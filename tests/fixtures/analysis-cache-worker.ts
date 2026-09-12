import path from 'node:path';
import { canonicalJson } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const root = process.argv[2];
if (root === undefined) throw new Error('Fixture root is required');
const configuration = serverConfigurationSchema.parse({
  version: 1,
  serverStateRoot: path.join(root, 'state'),
  workspaces: [
    {
      id: 'test',
      name: 'Persistent analysis fixture',
      root: path.join(root, 'mod'),
    },
  ],
});
const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
const snapshot = await engine.scan('test');
process.stdout.write(
  canonicalJson({
    revision: snapshot.revision,
    focusIds: snapshot.index.findAll('focus').map(({ id }) => id),
    index: engine.indexSegments.statistics(),
    persistent: await engine.persistentAnalysisCacheStatistics(),
  }),
);
