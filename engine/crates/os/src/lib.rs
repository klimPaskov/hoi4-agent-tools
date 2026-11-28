//! The few operating-system queries the engine needs that the standard library does not offer and
//! that cannot be written without `unsafe`: whether a process exists, a file's identity, the host
//! name and the effective user. Each function is a safe wrapper around one documented system call.
//!
//! The semantics follow the TypeScript server: `process.kill(pid, 0)` counts a permission error as
//! "alive", a file identity is `dev, ino, size, mtime, ctime`, and `os.hostname()` is the host.

use std::fs::File;
use std::io;

/// What the system says about a process id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessState {
    Alive,
    Dead,
    /// The system could not say; callers must treat this as alive and never delete on it.
    Unknown,
}

impl ProcessState {
    /// `false` only when the process is known not to exist.
    pub fn maybe_alive(self) -> bool {
        self != Self::Dead
    }
}

/// Everything that identifies one version of one file: a replacement at the same path changes the
/// device or node (a new file), and an in-place rewrite changes the size or a timestamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FileIdentity {
    /// Device on Unix; the volume serial number on Windows.
    pub device: u64,
    /// Inode on Unix; the file index on Windows.
    pub node: u64,
    pub size: u64,
    /// Nanoseconds since the Unix epoch (Windows: since 1601, which is irrelevant to equality).
    pub modified_ns: i128,
    /// Inode change time on Unix and the change time on Windows (creation time if that is unavailable).
    pub changed_ns: i128,
}

#[cfg(unix)]
pub fn process_state(pid: u32) -> ProcessState {
    // Pid 0 and negative ids would signal a whole process group, so they are never passed on.
    let Ok(pid) = libc::pid_t::try_from(pid) else { return ProcessState::Unknown };
    if pid <= 0 {
        return ProcessState::Unknown;
    }
    // SAFETY: `kill` with signal 0 sends nothing; it only checks that the process exists and that
    // the caller may signal it. The arguments are plain integers.
    let result = unsafe { libc::kill(pid, 0) };
    if result == 0 {
        return ProcessState::Alive;
    }
    match io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => ProcessState::Dead,
        // Another user's process exists; Node's `process.kill(pid, 0)` also treats this as alive.
        Some(libc::EPERM) => ProcessState::Alive,
        _ => ProcessState::Unknown,
    }
}

#[cfg(windows)]
pub fn process_state(pid: u32) -> ProcessState {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, GetLastError};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    const STILL_ACTIVE: u32 = 259;
    if pid == 0 {
        return ProcessState::Unknown;
    }
    // SAFETY: `OpenProcess` takes plain values and returns a handle or null.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // SAFETY: reads the calling thread's last error code.
        return match unsafe { GetLastError() } {
            ERROR_INVALID_PARAMETER => ProcessState::Dead,
            ERROR_ACCESS_DENIED => ProcessState::Alive,
            _ => ProcessState::Unknown,
        };
    }
    let mut code = 0u32;
    // SAFETY: `handle` is a valid process handle opened above and `code` is a valid out pointer.
    let read = unsafe { GetExitCodeProcess(handle, &mut code) };
    // SAFETY: `handle` is owned here and closed exactly once.
    unsafe { CloseHandle(handle) };
    if read == 0 {
        ProcessState::Unknown
    } else if code == STILL_ACTIVE {
        ProcessState::Alive
    } else {
        ProcessState::Dead
    }
}

#[cfg(not(any(unix, windows)))]
pub fn process_state(_pid: u32) -> ProcessState {
    ProcessState::Unknown
}

#[cfg(unix)]
pub fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    let nanos = |seconds: i64, nanoseconds: i64| i128::from(seconds) * 1_000_000_000 + i128::from(nanoseconds);
    Ok(FileIdentity {
        device: metadata.dev(),
        node: metadata.ino(),
        size: metadata.len(),
        modified_ns: nanos(metadata.mtime(), metadata.mtime_nsec()),
        changed_ns: nanos(metadata.ctime(), metadata.ctime_nsec()),
    })
}

#[cfg(windows)]
pub fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
    };
    let ticks = |time: FILETIME| (i128::from(time.dwHighDateTime) << 32) | i128::from(time.dwLowDateTime);
    // SAFETY: an all-zero BY_HANDLE_FILE_INFORMATION is a valid value of this plain C struct.
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle belongs to `file`, which outlives the call, and `information` is a valid out pointer.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // The change time moves on every write, even when a tool puts the modification time back; the
    // creation time (the fallback) at least moves when a file is replaced.
    // SAFETY: an all-zero FILE_BASIC_INFO is a valid value of this plain C struct.
    let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: the handle belongs to `file`; the buffer is a FILE_BASIC_INFO of exactly the size passed.
    let basic_ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            (&mut basic as *mut FILE_BASIC_INFO).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    let changed = if basic_ok == 0 { ticks(information.ftCreationTime) } else { i128::from(basic.ChangeTime) };
    Ok(FileIdentity {
        device: u64::from(information.dwVolumeSerialNumber),
        node: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        size: (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow),
        // FILETIME counts 100 ns ticks.
        modified_ns: ticks(information.ftLastWriteTime) * 100,
        changed_ns: changed * 100,
    })
}

#[cfg(not(any(unix, windows)))]
pub fn file_identity(file: &File) -> io::Result<FileIdentity> {
    let metadata = file.metadata()?;
    let nanos = |time: io::Result<std::time::SystemTime>| {
        time.ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as i128)
    };
    Ok(FileIdentity { device: 0, node: 0, size: metadata.len(), modified_ns: nanos(metadata.modified()), changed_ns: nanos(metadata.created()) })
}

/// The host name as `os.hostname()` reports it; `None` when the system cannot say.
#[cfg(unix)]
pub fn hostname() -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is valid for `buffer.len()` bytes; `gethostname` writes at most that many.
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast::<libc::c_char>(), buffer.len()) };
    if result != 0 {
        return None;
    }
    let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
    String::from_utf8(buffer[..end].to_vec()).ok().filter(|name| !name.is_empty())
}

#[cfg(windows)]
pub fn hostname() -> Option<String> {
    use windows_sys::Win32::System::SystemInformation::{ComputerNameDnsHostname, GetComputerNameExW};
    let mut buffer = [0u16; 256];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` holds `length` UTF-16 units and `length` is a valid in/out pointer.
    let ok = unsafe { GetComputerNameExW(ComputerNameDnsHostname, buffer.as_mut_ptr(), &mut length) };
    if ok == 0 {
        return None;
    }
    String::from_utf16(&buffer[..length as usize]).ok().filter(|name| !name.is_empty())
}

#[cfg(not(any(unix, windows)))]
pub fn hostname() -> Option<String> {
    None
}

/// The effective user id on Unix; `None` elsewhere.
#[cfg(unix)]
pub fn effective_uid() -> Option<u32> {
    // SAFETY: `geteuid` takes no arguments and cannot fail.
    Some(unsafe { libc::geteuid() })
}

#[cfg(not(unix))]
pub fn effective_uid() -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn own_process_is_alive_and_reserved_ids_are_unknown() {
        assert_eq!(process_state(std::process::id()), ProcessState::Alive);
        assert_eq!(process_state(0), ProcessState::Unknown);
        assert!(ProcessState::Unknown.maybe_alive());
        assert!(!ProcessState::Dead.maybe_alive());
    }

    #[test]
    fn an_exited_child_is_dead() {
        let (program, arguments): (&str, Vec<&str>) = if cfg!(windows) { ("cmd", vec!["/C", "exit 0"]) } else { ("true", vec![]) };
        let mut child = std::process::Command::new(program).args(&arguments).spawn().expect("spawn");
        let pid = child.id();
        child.wait().expect("wait");
        drop(child);
        assert_eq!(process_state(pid), ProcessState::Dead);
    }

    /// Another user's process (pid 1 is root's init) exists even when it may not be signalled.
    #[cfg(unix)]
    #[test]
    fn another_users_process_counts_as_alive() {
        assert_eq!(process_state(1), ProcessState::Alive);
    }

    #[test]
    fn a_replacement_at_the_same_path_changes_the_identity() {
        let dir = std::env::temp_dir().join(format!("hoi4-os-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.bin");
        let other = dir.join("b.bin");
        std::fs::write(&path, b"abcd").unwrap();
        std::fs::write(&other, b"wxyz").unwrap();
        let before = file_identity(&File::open(&path).unwrap()).unwrap();
        assert_eq!(before, file_identity(&File::open(&path).unwrap()).unwrap());
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(&other, &path).unwrap();
        let after = file_identity(&File::open(&path).unwrap()).unwrap();
        assert_eq!(before.size, after.size);
        assert_ne!(before, after);
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"!").unwrap();
        drop(file);
        assert_ne!(after, file_identity(&File::open(&path).unwrap()).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_host_name_is_available() {
        assert!(hostname().is_some());
    }
}
