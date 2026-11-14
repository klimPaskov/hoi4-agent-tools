import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import type { ServiceResult } from '../../src/hoi4_agent_tools/core/result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const callback of cleanup.splice(0).reverse()) await callback();
});

function resultOf(
  value: Awaited<ReturnType<Client['callTool']>>,
): ServiceResult<Record<string, unknown>> {
  return value.structuredContent as unknown as ServiceResult<Record<string, unknown>>;
}

const cleanEvents = `add_namespace = clean

country_event = {
	id = clean.1
	title = clean.1.t
	is_triggered_only = yes
	option = {
		name = clean.1.a
		country_event = { id = clean.2 days = 1 }
	}
}

country_event = {
	id = clean.2
	title = clean.2.t
	is_triggered_only = yes
	option = {
		name = clean.2.a
		add_political_power = 1
	}
}
`;

// A file the parser cannot finish is a blocking diagnostic of its own file, whatever the trace is.
const brokenEvents = `add_namespace = broken

country_event = {
	id = broken.1
	title = broken.1.t
	option = {
		name = broken.1.a
`;

describe('Event validation is scoped to the answer', () => {
  it('passes a clean trace beside a file with a blocking diagnostic', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-event-scope-'));
    const mod = path.join(temporary, 'mod');
    const runtime = path.join(temporary, 'runtime');
    await Promise.all([
      mkdir(path.join(mod, 'events'), { recursive: true }),
      mkdir(path.join(mod, 'localisation', 'english'), { recursive: true }),
      mkdir(runtime, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(mod, 'events', 'clean.txt'), cleanEvents, 'utf8'),
      writeFile(path.join(mod, 'events', 'broken.txt'), brokenEvents, 'utf8'),
      writeFile(
        path.join(mod, 'localisation', 'english', 'scope_l_english.yml'),
        '﻿l_english:\nclean.1.t: "One"\nclean.1.a: "A"\nclean.2.t: "Two"\nclean.2.a: "B"\nbroken.1.t: "Broken"\nbroken.1.a: "A"\n',
        'utf8',
      ),
    ]);
    cleanup.push(async () => rm(temporary, { recursive: true, force: true }));
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'state'),
      storageRoots: [runtime],
      jobWorkerIdleSeconds: 0,
      workspaces: [
        {
          id: 'event-scope',
          name: 'Event scope',
          root: mod,
          artifactRoot: path.join(runtime, 'artifacts'),
          cacheRoot: path.join(runtime, 'cache'),
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    const server = createMcpServer(engine);
    const client = new Client({ name: 'event-scope-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
    );
    const trace = async (eventId: string) =>
      resultOf(
        await client.callTool({
          name: 'hoi4.event_inspect',
          arguments: {
            workspaceId: 'event-scope',
            mode: 'trace',
            selector: { kind: 'event', eventId },
            direction: 'downstream',
          },
        }),
      );

    const clean = await trace('clean.1');
    // The workspace has a blocking diagnostic, but not in the files of this answer.
    expect(clean.data.counts).toMatchObject({
      blockingDiagnostics: expect.any(Number),
    });
    expect(
      (clean.data.counts as { blockingDiagnostics: number }).blockingDiagnostics,
    ).toBeGreaterThan(0);
    expect(clean).toMatchObject({
      code: 'EVENT_INSPECTED',
      validation: { passed: true },
    });
    expect(JSON.stringify(clean.validation)).toContain('elsewhere in the workspace');
  });
});
