import { totalmem } from 'node:os';

/** What a worker process reported when the operating system ended it. */
export interface WorkerExitEvidence {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Last bytes the worker wrote to its standard error; never reported verbatim. */
  stderrTail: string;
  /** The supervising host stopped this worker itself (deadline or cancellation). */
  stoppedByHost: boolean;
  /** V8 old-space ceiling the worker was started with, in MiB. */
  heapLimitMiB: number | undefined;
}

export type WorkerExitCause =
  | 'heap_out_of_memory'
  | 'native_out_of_memory'
  | 'native_crash'
  | 'stopped_by_host'
  | 'terminated_externally'
  | 'uncaught_error'
  | 'exited';

export interface WorkerExitReport {
  cause: WorkerExitCause;
  /** Fixed-vocabulary description that contains no paths or source text. */
  message: string;
}

/** Windows status codes that a crashed native module or the C runtime leaves as the exit code. */
const WINDOWS_CRASH_CODES = new Map<number, string>([
  [0xc0000005, 'access violation'],
  [0xc00000fd, 'native stack overflow'],
  [0xc0000409, 'fast-fail abort'],
  [0xc0000374, 'heap corruption'],
  [0x80000003, 'breakpoint abort'],
]);
const CRASH_SIGNALS = new Set<string>(['SIGSEGV', 'SIGABRT', 'SIGILL', 'SIGBUS', 'SIGFPE']);

const HEAP_OOM = /JavaScript heap out of memory|Reached heap limit|Ineffective mark-compacts/iu;
const NATIVE_OOM =
  /Allocation failed - process out of memory|std::bad_alloc|Array buffer allocation failed|out of memory/iu;

function unsignedExitCode(code: number): number {
  return code < 0 ? code >>> 0 : code;
}

/** Decide, from the exit status and the worker's last stderr, why a worker stopped. */
export function classifyWorkerExit(evidence: WorkerExitEvidence): WorkerExitReport {
  const status =
    evidence.signal === null
      ? `exit code ${evidence.code ?? 'none'}`
      : `signal ${evidence.signal}${evidence.code === null ? '' : `, exit code ${evidence.code}`}`;
  if (evidence.stoppedByHost)
    return {
      cause: 'stopped_by_host',
      message: `The worker was stopped by its supervising server (${status})`,
    };
  if (HEAP_OOM.test(evidence.stderrTail))
    return {
      cause: 'heap_out_of_memory',
      message: `The worker exhausted its V8 heap limit${
        evidence.heapLimitMiB === undefined ? '' : ` of ${evidence.heapLimitMiB} MiB`
      } (${status}); narrow the request or raise jobWorkerMaxHeapMiB`,
    };
  if (NATIVE_OOM.test(evidence.stderrTail))
    return {
      cause: 'native_out_of_memory',
      message: `The worker could not allocate native memory (${status}); close other memory-heavy processes or request fewer or smaller render variants`,
    };
  const crash =
    evidence.code === null ? undefined : WINDOWS_CRASH_CODES.get(unsignedExitCode(evidence.code));
  if (crash !== undefined || (evidence.signal !== null && CRASH_SIGNALS.has(evidence.signal)))
    return {
      cause: 'native_crash',
      message: `The worker crashed in native code${crash === undefined ? '' : ` (${crash})`} (${status}); this is not a memory-limit failure`,
    };
  if (evidence.signal !== null)
    return {
      cause: 'terminated_externally',
      message: `The worker was terminated from outside the server (${status})`,
    };
  const reported = /^worker-error: ([A-Z0-9_]{1,64})$/mu.exec(evidence.stderrTail)?.[1];
  if (reported !== undefined)
    return {
      cause: 'uncaught_error',
      message: `The worker stopped on an uncaught job error ${reported} (${status}); this is not a memory failure, and the retained stderr log under the server state holds the stack`,
    };
  return {
    cause: 'exited',
    message: `The worker exited without publishing a terminal job outcome (${status})`,
  };
}

const MIB = 1024 * 1024;
const MINIMUM_DEFAULT_HEAP_MIB = 2_048;
const MAXIMUM_DEFAULT_HEAP_MIB = 8_192;

/**
 * V8 heap ceiling for job workers when none is configured. Node's own default is capped at
 * about 4 GiB, which a large GUI or event analysis can exceed on a machine with plenty of memory.
 * A quarter of physical memory, within fixed bounds, keeps one worker from using the machine.
 */
export function defaultWorkerHeapMiB(physicalBytes: number = totalmem()): number {
  const quarter = Math.floor(physicalBytes / MIB / 4);
  return Math.min(MAXIMUM_DEFAULT_HEAP_MIB, Math.max(MINIMUM_DEFAULT_HEAP_MIB, quarter));
}
