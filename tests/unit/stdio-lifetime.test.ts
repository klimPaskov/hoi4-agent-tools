import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  processAlive,
  StdioLifetime,
  type StdioExitReason,
} from '../../src/hoi4_agent_tools/mcp/transports/stdio-lifetime.js';

const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) if (processAlive(pid)) process.kill(pid, 'SIGKILL');
});

function lifetime(options: { idleExitMinutes: number; parentAlive?: () => boolean }) {
  let now = 0;
  const exits: StdioExitReason[] = [];
  const subject = new StdioLifetime({
    idleExitMinutes: options.idleExitMinutes,
    parentPid: 4242,
    isAlive: options.parentAlive ?? (() => true),
    now: () => now,
    onExit: (reason) => exits.push(reason),
  });
  return { subject, exits, advance: (minutes: number) => (now += minutes * 60_000) };
}

describe('stdio server lifetime', () => {
  it('exits when its parent process is gone, after open requests finish and a quiet poll', () => {
    let alive = true;
    const { subject, exits, advance } = lifetime({ idleExitMinutes: 0, parentAlive: () => alive });
    subject.check();
    expect(exits).toEqual([]);
    subject.received({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
    alive = false;
    advance(1);
    subject.check();
    expect(exits).toEqual([]);
    subject.sent({ jsonrpc: '2.0', id: 1, result: {} });
    subject.check();
    expect(exits).toEqual([]);
    advance(1);
    subject.check();
    subject.check();
    expect(exits).toEqual(['parent_exited']);
  });

  it('exits after the idle limit only when no request is open', () => {
    const { subject, exits, advance } = lifetime({ idleExitMinutes: 15 });
    subject.received({ jsonrpc: '2.0', id: 7, method: 'tools/call' });
    advance(25);
    subject.check();
    expect(exits).toEqual([]);
    subject.sent({ jsonrpc: '2.0', id: 7, result: {} });
    advance(14);
    subject.check();
    expect(exits).toEqual([]);
    advance(2);
    subject.check();
    expect(exits).toEqual(['idle']);
  });

  it('closes a cancelled request, which gets no response, and drops abandoned ones', () => {
    const cancelled = lifetime({ idleExitMinutes: 15 });
    cancelled.subject.received({ jsonrpc: '2.0', id: 'a', method: 'tools/call' });
    cancelled.subject.received({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'a' },
    });
    cancelled.advance(16);
    cancelled.subject.check();
    expect(cancelled.exits).toEqual(['idle']);
    const abandoned = lifetime({ idleExitMinutes: 15 });
    abandoned.subject.received({ jsonrpc: '2.0', id: 9, method: 'tools/call' });
    abandoned.advance(29);
    abandoned.subject.check();
    expect(abandoned.exits).toEqual([]);
    abandoned.advance(2);
    abandoned.subject.check();
    expect(abandoned.exits).toEqual(['idle']);
  });

  it('never exits for idleness when the idle limit is disabled', () => {
    const { subject, exits, advance } = lifetime({ idleExitMinutes: 0 });
    advance(100_000);
    subject.check();
    expect(exits).toEqual([]);
  });

  it('recognizes a parent process that has exited', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    pids.push(child.pid!);
    await new Promise((resolve) => child.once('exit', resolve));
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(child.pid!)).toBe(false);
    const exits: StdioExitReason[] = [];
    new StdioLifetime({
      idleExitMinutes: 0,
      parentPid: child.pid!,
      pollMs: 0,
      onExit: (reason) => exits.push(reason),
    }).check();
    expect(exits).toEqual(['parent_exited']);
  });
});
