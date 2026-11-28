//! Random identifiers from the operating system's generator.
//!
//! New in the port; replaces `randomUUID` of `node:crypto` in
//! `src/hoi4_agent_tools/mcp/transports/http.ts` and `event-store.ts`, commit 9b7dc80d.

/// A random version-4 UUID. Session ids must be unguessable, so a failing system generator stops
/// the server instead of falling back to a weaker source.
#[allow(clippy::panic)]
pub fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        panic!("the operating system random generator is unavailable");
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_version_4_and_distinct() {
        let first = random_uuid();
        let second = random_uuid();
        assert_ne!(first, second);
        assert_eq!(first.len(), 36);
        assert_eq!(&first[14..15], "4");
        assert!(matches!(&first[19..20], "8" | "9" | "a" | "b"));
    }
}
