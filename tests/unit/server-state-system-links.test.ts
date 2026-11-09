import { lstatSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTrustedSystemLink, ServerState } from '../../src/hoi4_agent_tools/core/server-state.js';

function rootOwnedTmpLink(): boolean {
  if (process.platform === 'win32') return false;
  try {
    const link = lstatSync('/tmp');
    const parent = lstatSync('/');
    return link.isSymbolicLink() && link.uid === 0 && parent.uid === 0;
  } catch {
    return false;
  }
}

describe('server state roots behind system links', () => {
  it('trusts only links that the superuser alone can change', () => {
    const rootLink = { linkUid: 0, parentUid: 0, parentMode: 0o40755 };
    expect(isTrustedSystemLink(rootLink, 'darwin')).toBe(true);
    expect(isTrustedSystemLink(rootLink, 'linux')).toBe(true);
    expect(isTrustedSystemLink(rootLink, 'win32')).toBe(false);
    expect(isTrustedSystemLink({ ...rootLink, linkUid: 501 }, 'darwin')).toBe(false);
    expect(isTrustedSystemLink({ ...rootLink, parentUid: 501 }, 'darwin')).toBe(false);
    expect(isTrustedSystemLink({ ...rootLink, parentMode: 0o40775 }, 'darwin')).toBe(false);
    expect(isTrustedSystemLink({ ...rootLink, parentMode: 0o41777 }, 'darwin')).toBe(false);
  });

  it.runIf(rootOwnedTmpLink())(
    'accepts a state root reached through a root-owned system link such as /tmp on macOS',
    async () => {
      const base = await mkdtemp(path.join(await realpath('/tmp'), 'hoi4-agent-system-link-'));
      try {
        const requested = path.join('/tmp', path.basename(base), 'server-state');
        const state = await ServerState.create(requested);
        expect(state.root).toBe(path.join(base, 'server-state'));
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    },
  );

  it('still refuses a state root behind a link the user owns', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-user-link-'));
    try {
      const real = path.join(base, 'real');
      const linked = path.join(base, 'linked');
      await mkdir(real);
      try {
        await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        return;
      }
      await expect(ServerState.create(path.join(linked, 'state'))).rejects.toMatchObject({
        code: 'SERVER_STATE_UNSAFE',
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
