import { readFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const request = z
  .object({
    configPath: z.string(),
    crash: z.enum(['intent', 'backup', 'replace', 'checkpoint']),
    crashPath: z.string().optional(),
    changes: z.array(z.object({ relativePath: z.string(), content: z.string().nullable() })),
  })
  .parse(JSON.parse(await readFile(process.argv[2]!, 'utf8')));
const config = serverConfigurationSchema.parse(
  JSON.parse(await readFile(request.configPath, 'utf8')),
);
const resolver = await WorkspaceResolver.create(config);
const manager = new TransactionManager(resolver);
const validation = async () => ({
  diagnostics: [],
  checks: [{ id: 'synthetic', passed: true, message: 'Synthetic crash fixture' }],
});
const plan = await manager.plan({
  workspaceId: 'batch',
  operationKind: 'batch-crash-test',
  operations: [{ id: 'test', kind: 'test', summary: 'Synthetic crash recovery', data: {} }],
  changes: request.changes.map(({ relativePath, content }) => ({
    relativePath,
    content: content === null ? null : Buffer.from(content),
    operationIds: ['test'],
  })),
  validate: validation,
});
const crash = () => process.exit(73);
await manager.apply('batch', plan.transactionId, plan.planHash, {
  postValidate: validation,
  hooks: {
    afterBatchIntent: async () => {
      if (request.crash === 'intent') crash();
    },
    afterBackup: async (relativePath) => {
      if (request.crash === 'backup' && relativePath === (request.crashPath ?? 'b-update.txt'))
        crash();
    },
    afterReplace: async (relativePath) => {
      if (request.crash === 'replace' && relativePath === (request.crashPath ?? 'a-create.txt'))
        crash();
    },
    beforeBatchCheckpoint: async () => {
      if (request.crash === 'checkpoint') crash();
    },
  },
});
throw new Error('Crash checkpoint was not reached');
