import { access, readFile } from 'node:fs/promises';
import process from 'node:process';
import { ArtifactStore } from '../../src/hoi4_agent_tools/core/artifacts.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const [configurationPath, workspaceId, gatePath, mode] = process.argv.slice(2);
if (configurationPath === undefined || workspaceId === undefined || gatePath === undefined) {
  throw new Error('Expected configuration path, workspace id, and gate path');
}

const configuration = serverConfigurationSchema.parse(
  JSON.parse(await readFile(configurationPath, 'utf8')) as unknown,
);
const resolver = await WorkspaceResolver.create(configuration);
const workspace = resolver.get(workspaceId);
const store = new ArtifactStore();
const content = Buffer.alloc(1_000_000, 0x61);
const provenance = {
  kind: 'cross-process-publication-test',
  toolVersion: '0.1.0',
  schemaVersion: 'cross-process.v1',
  sourceHashes: {},
  metadata: { padding: 'x'.repeat(128_000) },
};

async function waitForGate(gate: string): Promise<void> {
  for (let attempt = 0; attempt < 12_000; attempt += 1) {
    try {
      await access(gate);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error('Timed out waiting for the process publication gate');
}
process.stdout.write('READY\n');
await waitForGate(gatePath);

if (mode === 'rollback') {
  try {
    await store.withAtomicWrites(
      workspace,
      [{ name: 'shared-large.json', mimeType: 'application/json', content, provenance }],
      async () => {
        process.stdout.write('COMMITTING\n');
        await waitForGate(`${gatePath}.rollback`);
        throw new Error('intentional commit failure');
      },
    );
    throw new Error('Expected commit failure');
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'intentional commit failure') throw error;
  }
  process.stdout.write('ROLLED_BACK\n');
} else {
  let uri = '';
  for (let iteration = 0; iteration < 3; iteration += 1) {
    uri = (await store.put(workspace, 'shared-large.json', 'application/json', content, provenance))
      .uri;
  }
  process.stdout.write(`DONE ${uri}\n`);
}
