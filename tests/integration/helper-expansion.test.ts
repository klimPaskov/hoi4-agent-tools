import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { JobExecutor, JobOperations } from '../../src/hoi4_agent_tools/core/job-executor.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { registerEventJobs } from '../../src/hoi4_agent_tools/event/job-operations.js';
import { registerTechnologyJobs } from '../../src/hoi4_agent_tools/technology/job-operations.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import type { HelperExpansionSummary } from '../../src/hoi4_agent_tools/schemas/helper-expansion.js';
import { helperExpansionFixture } from '../helpers/helper-expansion-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe('MCP helper expansion page contract', () => {
  it.each(['hoi4.event_inspect', 'hoi4.tech_inspect'])(
    'preserves exact %s foreground and persisted-job results through an opaque continuation',
    async (name) => {
      const setup = await helperExpansionFixture();
      cleanup.push(setup.dispose);
      const engine = await setup.engine();
      const jobs = await JobService.create(engine.resolver);
      const operations = new JobOperations();
      registerEventJobs(operations, engine);
      registerTechnologyJobs(operations, engine);
      const executor = new JobExecutor(engine, jobs, operations);
      const server = createMcpServer(engine);
      const client = new Client({ name: 'synthetic-helper-pages', version: '1.0.0' });
      cleanup.push(async () => {
        await client.close();
        await server.close();
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      let continuationUri: string | undefined;
      for (let page = 0; page < 2; page++) {
        const input = {
          workspaceId: 'pages',
          mode: 'helper_expansion',
          helperExpansion: {
            maxRecords: page === 0 ? 1 : 5_000,
            maxWork: 100_000,
            ...(continuationUri === undefined ? {} : { continuationUri }),
          },
        };
        const foreground = await client.callTool({ name, arguments: input });
        expect(foreground.isError).not.toBe(true);
        const summary = (
          foreground.structuredContent as { data: { helperExpansion: HelperExpansionSummary } }
        ).data.helperExpansion;
        expect(summary.finished).toBe(page === 1);
        expect(summary.complete).toBe(page === 1);
        if (page === 0) {
          continuationUri = summary.continuationUri;
          expect(continuationUri).toMatch(/^hoi4-agent:\/\//u);
          expect(await client.readResource({ uri: continuationUri! })).toMatchObject({
            contents: [expect.objectContaining({ mimeType: 'application/json' })],
          });
        }
        const { record } = await jobs.submit('pages', {
          toolName: name,
          arguments: input,
          mutation: false,
        });
        const completed = await executor.run('pages', record.id);
        expect(completed.status).toBe('completed');
        expect(completed.failure).toBeUndefined();
        expect(completed.result).toEqual(JSON.parse(JSON.stringify(foreground)));
      }
      const invalid = await client.callTool({
        name,
        arguments: { workspaceId: 'pages', mode: 'helper_expansion', maxDepth: 1 },
      });
      expect(invalid.isError).toBe(true);
      for (const [relative, original] of setup.sources)
        expect(await readFile(path.join(setup.mod, relative), 'utf8')).toBe(original);
    },
  );
});
