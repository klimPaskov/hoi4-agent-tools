import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  capEngineMemory,
  DEFAULT_ENGINE_MEMORY_CAP_MB,
  engineDescendants,
  engineMemoryCapMb,
  engineMemoryCapMessage,
  type EngineMemoryTrip,
} from '../../scripts/bench/engine-memory-cap.js';

/** A child that keeps `megabytes` of touched memory and waits. */
function growingChild(megabytes: number) {
  return spawn(
    process.execPath,
    [
      '-e',
      `const keep = []; for (let i = 0; i < ${megabytes}; i++) keep.push(Buffer.alloc(1048576, 1)); setInterval(() => keep.length, 1000);`,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
}

describe('the engine memory cap of the parity and benchmark scripts', () => {
  it('reads the cap from the environment, with a default and a refusal', () => {
    expect(engineMemoryCapMb({})).toBe(DEFAULT_ENGINE_MEMORY_CAP_MB);
    expect(engineMemoryCapMb({ HOI4_PARITY_ENGINE_MAX_MB: '2048' })).toBe(2048);
    expect(engineMemoryCapMb({ HOI4_PARITY_ENGINE_MAX_MB: '0' })).toBe(0);
    expect(() => engineMemoryCapMb({ HOI4_PARITY_ENGINE_MAX_MB: 'lots' })).toThrow(/whole number/u);
    expect(() => engineMemoryCapMb({ HOI4_PARITY_ENGINE_MAX_MB: '-1' })).toThrow(/whole number/u);
  });

  it('finds matching processes among all descendants, not only children', () => {
    const rows = [
      { pid: 10, ppid: 1, name: 'node.exe', bytes: 1 },
      { pid: 11, ppid: 10, name: 'node.exe', bytes: 2 },
      { pid: 12, ppid: 11, name: 'hoi4-engine.exe', bytes: 3 },
      { pid: 13, ppid: 10, name: 'hoi4-engine.exe', bytes: 4 },
      { pid: 14, ppid: 99, name: 'hoi4-engine.exe', bytes: 5 },
    ];
    expect(engineDescendants(rows, 10, /^hoi4-engine/u)).toEqual([
      { pid: 13, bytes: 4 },
      { pid: 12, bytes: 3 },
    ]);
  });

  it('kills a child that grows past the cap and reports the peak', async () => {
    const child = growingChild(400);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const trip = await new Promise<EngineMemoryTrip>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('the cap never tripped')), 45_000);
      capEngineMemory({
        label: 'memory cap test',
        maxMb: 150,
        intervalMs: 250,
        match: /^node/u,
        onTrip: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
      });
    });
    await exited;
    expect(trip.pid).toBe(child.pid);
    expect(trip.peakBytes).toBeGreaterThan(150 * 1_048_576);
    expect(engineMemoryCapMessage(trip)).toMatch(
      /^ENGINE_MEMORY_CAP: memory cap test: hoi4-engine \(pid \d+\) reached [\d,]+ MB, over the cap of 150 MB\./u,
    );
  }, 60_000);

  it('leaves a child under the cap alone', async () => {
    const child = growingChild(20);
    let tripped = false;
    const stop = capEngineMemory({
      label: 'memory cap test',
      maxMb: 1_024,
      intervalMs: 250,
      match: /^node/u,
      onTrip: () => {
        tripped = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    stop();
    expect(tripped).toBe(false);
    expect(child.exitCode).toBeNull();
    child.kill();
  }, 30_000);
});
