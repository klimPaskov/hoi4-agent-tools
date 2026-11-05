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
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

async function client(environment: Record<string, string | undefined>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-assets-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'mod');
  const write = async (relative: string, text: string) => {
    const file = path.join(mod, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await write('descriptor.mod', 'name="Asset fixture"\n');
  await write(
    'interface/t.gfx',
    'spriteTypes = {\n spriteType = { name = "GFX_t_ok" texturefile = "gfx/interface/t_ok.dds" }\n spriteType = { name = "GFX_t_lost" texturefile = "gfx/interface/t_lost.dds" }\n}\n',
  );
  // A DXT5 DDS header of 64x64 pixels.
  const dds = Buffer.alloc(148);
  dds.write('DDS ', 0, 'latin1');
  dds.writeUInt32LE(124, 4);
  dds.writeUInt32LE(64, 12);
  dds.writeUInt32LE(64, 16);
  dds.writeUInt32LE(4, 80);
  dds.write('DXT5', 84, 'latin1');
  const texture = path.join(mod, 'gfx', 'interface', 't_ok.dds');
  await mkdir(path.dirname(texture), { recursive: true });
  await writeFile(texture, dds);
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
  const mcp = new Client({ name: 'assets-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  close.push(async () => {
    await mcp.close();
    await server.close();
  });
  return (args: Record<string, unknown>) =>
    mcp.callTool({ name: 'hoi4.asset_inspect', arguments: { workspaceId: 'fixture', ...args } });
}

describe(
  engineBinary === undefined
    ? 'hoi4.asset_inspect on the real engine (skipped: run cargo build -p hoi4-engine-cli in engine/ or set HOI4_ENGINE)'
    : 'hoi4.asset_inspect on the real engine',
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
      'inspects a sprite, flags a missing texture and answers an unknown name with not-found',
      async () => {
        const call = await client({});
        const first = await call({ kind: 'sprite', id: 'GFX_t_ok' });
        expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
        expect(first.structuredContent).toMatchObject({
          code: 'ASSET_INSPECTED',
          validation: { passed: true },
        });
        const lost = await call({ kind: 'sprite', id: 'GFX_t_lost' });
        const structured = lost.structuredContent as {
          data: { inspection: { references: Array<{ value: string; known: boolean }> } };
          validation: { passed: boolean };
        };
        expect(structured.data.inspection.references).toEqual([
          expect.objectContaining({ value: 'gfx/interface/t_lost.dds', known: false }),
        ]);
        expect(structured.validation.passed).toBe(false);
        const audit = await call({ kind: 'sprite', audit: true });
        expect(audit.structuredContent).toMatchObject({
          code: 'ASSET_AUDITED',
          data: { audit: { checked: 2 } },
        });
        const missing = await call({ kind: 'sprite', id: 'GFX_t_ko' });
        expect(missing.structuredContent).toMatchObject({ code: 'ASSET_NOT_FOUND' });
        expect(JSON.stringify(missing.content)).toContain('GFX_t_ok');
      },
    );
  },
);

describe('hoi4.asset_inspect without the engine', () => {
  it('says the engine is unavailable instead of answering from TypeScript', async () => {
    const call = await client({
      HOI4_ENGINE: path.join(os.tmpdir(), 'no-such-engine', 'hoi4-engine.exe'),
    });
    const result = await call({ kind: 'flag', audit: true });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });
});
