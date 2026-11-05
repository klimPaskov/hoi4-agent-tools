import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const game = path.join(repositoryRoot, 'engine', 'fixtures', 'game');

/** A built hoi4-engine: HOI4_ENGINE, else a cargo debug or release build. */
function realEngineBinary(): string | undefined {
  const executable = process.platform === 'win32' ? 'hoi4-engine.exe' : 'hoi4-engine';
  const targets = [process.env.CARGO_TARGET_DIR, path.join(repositoryRoot, 'engine', 'target')]
    .filter((entry): entry is string => entry !== undefined && entry !== '')
    .flatMap((target) => [
      path.resolve(target, 'release', executable),
      path.resolve(target, 'debug', executable),
    ]);
  return [process.env.HOI4_ENGINE, ...targets].find((candidate) => {
    if (candidate === undefined || candidate === '' || !path.isAbsolute(candidate)) return false;
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const engineBinary = realEngineBinary();
const BOM = '﻿';
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

async function client(environment: Record<string, string | undefined>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-ideas-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'mod');
  const write = async (relative: string, text: string) => {
    const file = path.join(mod, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await write('descriptor.mod', 'name="Ideas fixture"\n');
  await write(
    'common/ideas/t.txt',
    'ideas = { country = { t_spirit = { modifier = { political_power_gain = 0.1 not_a_modifier = 1 } } } }\n',
  );
  await write('localisation/english/t_l_english.yml', `${BOM}l_english:\n t_spirit:0 "Spirit"\n`);
  const previous = Object.fromEntries(Object.keys(environment).map((k) => [k, process.env[k]]));
  for (const [key, value] of Object.entries(environment))
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  close.push(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
  });
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [
        { id: 'fixture', name: 'Fixture', root: mod, gameRoot: game, includeGameDlc: false },
      ],
    }),
  );
  const server = createMcpServer(new CoreEngine(resolver));
  const mcp = new Client({ name: 'ideas-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  close.push(async () => {
    await mcp.close();
    await server.close();
  });
  return (args: Record<string, unknown>) =>
    mcp.callTool({ name: 'hoi4.idea_inspect', arguments: { workspaceId: 'fixture', ...args } });
}

describe(
  engineBinary === undefined
    ? 'hoi4.idea_inspect on the real engine (skipped: run cargo build -p hoi4-engine-cli in engine/ or set HOI4_ENGINE)'
    : 'hoi4.idea_inspect on the real engine',
  () => {
    let restore: (() => void) | undefined;
    beforeAll(() => {
      if (engineBinary !== undefined) {
        const previous = process.env.HOI4_ENGINE;
        process.env.HOI4_ENGINE = engineBinary;
        restore = () => {
          if (previous === undefined) Reflect.deleteProperty(process.env, 'HOI4_ENGINE');
          else process.env.HOI4_ENGINE = previous;
        };
      }
    });
    afterAll(() => restore?.());

    it.skipIf(engineBinary === undefined)(
      'inspects an idea, flags an unknown modifier and answers an unknown id with not-found',
      async () => {
        const call = await client({});
        const idea = await call({ kind: 'idea', id: 't_spirit' });
        expect(idea.isError, JSON.stringify(idea.content)).not.toBe(true);
        const structured = idea.structuredContent as {
          code: string;
          data: { inspection: { modifiers: Array<{ key: string; known: boolean }> } };
          validation: { passed: boolean };
        };
        expect(structured.code).toBe('IDEA_INSPECTED');
        expect(structured.data.inspection.modifiers.filter(({ known }) => !known)).toEqual([
          expect.objectContaining({ key: 'not_a_modifier' }),
        ]);
        expect(structured.validation.passed).toBe(false);
        const missing = await call({ kind: 'idea', id: 't_spirt' });
        expect(missing.structuredContent).toMatchObject({ code: 'IDEA_NOT_FOUND' });
        expect(JSON.stringify(missing.content)).toContain('t_spirit');
      },
    );
  },
);

describe('hoi4.idea_inspect without the engine', () => {
  it('says the engine is unavailable instead of answering from TypeScript', async () => {
    const call = await client({
      HOI4_ENGINE: path.join(os.tmpdir(), 'no-such-engine', 'hoi4-engine.exe'),
    });
    const result = await call({ kind: 'character', audit: true });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });
});
