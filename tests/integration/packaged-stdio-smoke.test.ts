import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  launchSmokeServer,
  writeSmokeConfig,
  type SmokeServer,
} from '../helpers/mcp-stdio-smoke.js';

it('reports a missing packaged entry without falling back to the source server', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-packaged-entry-'));
  let server: SmokeServer | undefined;
  try {
    const root = path.join(temporary, 'mod');
    await mkdir(root);
    await writeFile(path.join(root, 'descriptor.mod'), 'name="Packaged entry test"\n');
    const config = await writeSmokeConfig(path.join(temporary, 'config'), [
      { id: 'packaged-entry', name: 'Packaged entry test', root },
    ]);
    server = await launchSmokeServer(config);
    expect(server.toolNames).toHaveLength(28);
    await server.close();
    server = undefined;
    await expect(
      launchSmokeServer(config, path.join(temporary, 'missing-stdio.js')).then((started) => {
        server = started;
        return started;
      }),
    ).rejects.toThrow('stdio server failed to start');
  } finally {
    await server?.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 10 });
  }
});
