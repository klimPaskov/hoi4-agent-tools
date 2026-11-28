import { execFile, spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';

/**
 * A hard memory cap for the engine processes that parity and benchmark scripts start.
 *
 * Every script that runs `hoi4-engine` calls {@link capEngineMemory} once, before it starts the
 * engine. A watchdog samples, about once a second, the memory of every descendant of this
 * process whose name matches `hoi4-engine` (an engine may run under a server the script starts).
 * When one passes the cap, the watchdog kills it and stops the script with `ENGINE_MEMORY_CAP`
 * and the peak, so a runaway operation fails clearly instead of filling the machine's commit
 * charge and pagefile. One parity run on a large mod once grew an engine to 22 GB of private
 * memory.
 *
 * The cap is `HOI4_PARITY_ENGINE_MAX_MB` (megabytes, default 6,144). `0` turns the watchdog off,
 * which is for machines with memory to spare, never for the shared build pool. On Windows the
 * sample is the process's private bytes, on Linux its resident set, and on macOS its resident
 * set size from `ps`.
 */

export const ENGINE_MEMORY_CAP_ENV = 'HOI4_PARITY_ENGINE_MAX_MB';
export const DEFAULT_ENGINE_MEMORY_CAP_MB = 6_144;

export interface EngineMemorySample {
  pid: number;
  bytes: number;
}

export interface EngineMemoryTrip {
  pid: number;
  peakBytes: number;
  capBytes: number;
  label: string;
}

export interface EngineMemoryCapOptions {
  /** Named in the error, for example the script and corpus. */
  label: string;
  /** Overrides the environment and the default. `0` turns the cap off. */
  maxMb?: number;
  intervalMs?: number;
  /** The process names to watch. */
  match?: RegExp;
  /** Called once when the cap trips, after the process is killed. The default stops the script. */
  onTrip?: (trip: EngineMemoryTrip) => void;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  bytes: number;
}

export function engineMemoryCapMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENGINE_MEMORY_CAP_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_ENGINE_MEMORY_CAP_MB;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${ENGINE_MEMORY_CAP_ENV} must be a whole number of megabytes, got ${raw}`);
  return value;
}

export function engineMemoryCapMessage(trip: EngineMemoryTrip): string {
  const mb = (bytes: number): string =>
    `${Math.round(bytes / 1_048_576).toLocaleString('en-US')} MB`;
  return (
    `ENGINE_MEMORY_CAP: ${trip.label}: hoi4-engine (pid ${trip.pid}) reached ${mb(trip.peakBytes)}, ` +
    `over the cap of ${mb(trip.capBytes)}. The engine was stopped. Find the operation that grows, ` +
    `or set ${ENGINE_MEMORY_CAP_ENV} on a machine with memory to spare.`
  );
}

/** The matching processes among all descendants of `parent`. */
export function engineDescendants(
  rows: readonly ProcessRow[],
  parent: number,
  match: RegExp,
): EngineMemorySample[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const samples: EngineMemorySample[] = [];
  const seen = new Set<number>([parent]);
  const queue = [parent];
  while (queue.length > 0) {
    for (const row of children.get(queue.shift()!) ?? []) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      queue.push(row.pid);
      if (match.test(row.name)) samples.push({ pid: row.pid, bytes: row.bytes });
    }
  }
  return samples;
}

/** Starts the watchdog; the returned function stops it. */
export function capEngineMemory(options: EngineMemoryCapOptions): () => void {
  const capMb = options.maxMb ?? engineMemoryCapMb();
  if (capMb === 0) return () => undefined;
  const capBytes = capMb * 1_048_576;
  const match = options.match ?? /^hoi4-engine/u;
  const onTrip =
    options.onTrip ??
    ((trip: EngineMemoryTrip) => {
      process.stderr.write(`${engineMemoryCapMessage(trip)}\n`);
      process.exit(3);
    });
  let tripped = false;
  const sampler = processSampler(options.intervalMs ?? 1_000, (rows) => {
    if (tripped) return;
    const over = engineDescendants(rows, process.pid, match).find(({ bytes }) => bytes > capBytes);
    if (over === undefined) return;
    tripped = true;
    try {
      process.kill(over.pid);
    } catch {
      // Already gone.
    }
    sampler.stop();
    onTrip({ pid: over.pid, peakBytes: over.bytes, capBytes, label: options.label });
  });
  return () => sampler.stop();
}

interface Sampler {
  stop(): void;
}

/** Calls `listener` with every process on the machine, about every `intervalMs`. */
function processSampler(intervalMs: number, listener: (rows: ProcessRow[]) => void): Sampler {
  if (process.platform === 'win32') return windowsSampler(intervalMs, listener);
  let stopped = false;
  let busy = false;
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    (process.platform === 'linux' ? linuxRows() : psRows())
      .then((rows) => {
        if (!stopped) listener(rows);
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** One long-lived PowerShell prints `pid ppid name privateBytes` lines, then `---`. */
function windowsSampler(intervalMs: number, listener: (rows: ProcessRow[]) => void): Sampler {
  const script =
    'while ($true) { Get-CimInstance Win32_Process | ForEach-Object { ' +
    '"{0} {1} {2} {3}" -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.PrivatePageCount }; ' +
    `'---'; Start-Sleep -Milliseconds ${intervalMs} }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  child.unref();
  child.on('error', () => undefined);
  let stopped = false;
  let buffer = '';
  let batch: ProcessRow[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '---') {
        if (!stopped) listener(batch);
        batch = [];
        continue;
      }
      const [pid, ppid, name, bytes] = line.split(/\s+/u);
      if (pid !== undefined && ppid !== undefined && name !== undefined)
        batch.push({ pid: Number(pid), ppid: Number(ppid), name, bytes: Number(bytes ?? 0) });
    }
  });
  // The pipe must not keep the script alive once its own work is done.
  (child.stdout as unknown as { unref?: () => void }).unref?.();
  return {
    stop: () => {
      stopped = true;
      child.kill();
    },
  };
}

async function linuxRows(): Promise<ProcessRow[]> {
  const rows: ProcessRow[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    const status = await readFile(`/proc/${entry}/status`, 'utf8').catch(() => undefined);
    if (status === undefined) continue;
    const field = (name: string): string | undefined =>
      new RegExp(`^${name}:\\s*(.+)$`, 'mu').exec(status)?.[1]?.trim();
    const rss = /^(\d+)\s*kB$/u.exec(field('VmRSS') ?? '');
    // The status Name is the main thread's name, which a process may rename (Node 24 calls its
    // main thread "MainThread"), so the executable comes from argv[0] when the process has one.
    const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
    const argv0 = cmdline.split('\0')[0]?.split('/').pop() ?? '';
    rows.push({
      pid: Number(entry),
      ppid: Number(field('PPid')),
      name: argv0 === '' ? (field('Name') ?? '') : argv0,
      bytes: rss === null ? 0 : Number(rss[1]) * 1024,
    });
  }
  return rows;
}

function psRows(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], (error, stdout) => {
      if (error !== null) return resolve([]);
      const rows: ProcessRow[] = [];
      for (const line of stdout.split('\n')) {
        const [pid, ppid, rss, ...command] = line.trim().split(/\s+/u);
        if (pid === undefined || ppid === undefined || pid === '') continue;
        const name = command.join(' ').split('/').pop() ?? '';
        rows.push({ pid: Number(pid), ppid: Number(ppid), name, bytes: Number(rss) * 1024 });
      }
      resolve(rows);
    });
  });
}
