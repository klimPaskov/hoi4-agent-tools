import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import {
  ResidentEngine,
  replaceSharedResidentEngine,
} from '../../src/hoi4_agent_tools/core/resident-engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

// ADR 0089: the resolver trusts no answer of `paths.resolve` it cannot check.

/** A `hoi4-engine serve` stand-in that answers every `paths.resolve` with `FAKE_ANSWER`. */
const FAKE_SOURCE = `import process from 'node:process';
const answer = JSON.parse(process.env.FAKE_ANSWER);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let newline = buffer.indexOf('\\n'); newline >= 0; newline = buffer.indexOf('\\n')) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    process.stdout.write(JSON.stringify({ id: request.id, ...answer, payload: 0 }) + '\\n');
  }
});
`;

const roots: string[] = [];
afterEach(async () => {
  replaceSharedResidentEngine(undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function resolverWith(answer: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-paths-engine-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(mod);
  await writeFile(path.join(mod, 'inside.txt'), 'inside');
  const fake = path.join(root, 'fake-engine.mjs');
  await writeFile(fake, FAKE_SOURCE, 'utf8');
  replaceSharedResidentEngine(
    new ResidentEngine({
      env: { ...process.env, HOI4_ENGINE: fake, FAKE_ANSWER: JSON.stringify(answer) },
    }),
  );
  return WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'test', name: 'Paths engine fixture', root: mod }],
    }),
  );
}

describe('workspace paths through the engine', () => {
  it.each([
    ['a path that is not a string', { ok: true, result: { resolved: { path: 7, root: 0 } } }],
    ['an empty path', { ok: true, result: { resolved: { path: '', root: 0 } } }],
    ['an extra field', { ok: true, result: { resolved: null, extra: true } }],
    ['a negative root', { ok: true, result: { resolved: { path: 'x', root: -1 } } }],
    ['a refusal without a code', { ok: true, result: { refusal: { message: 'no' } } }],
  ])('refuses an answer with %s as an unavailable engine', async (_label, answer) => {
    const resolver = await resolverWith(answer);
    await expect(resolver.resolvePath('test', 'inside.txt', 'read')).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
    });
  });

  it('refuses an answer that names a root the workspace does not have', async () => {
    const resolver = await resolverWith({
      ok: true,
      result: { resolved: { path: '/anywhere', root: 9 } },
    });
    await expect(resolver.resolvePath('test', 'inside.txt', 'read')).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
    });
  });

  it('reports the engine refusal with the TypeScript code and the offending path', async () => {
    const resolver = await resolverWith({
      ok: true,
      result: {
        refusal: { code: 'PATH_TRAVERSAL', message: 'Parent path segments are not allowed' },
      },
    });
    await expect(resolver.resolvePath('test', '../x.txt', 'write', ['mod'])).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
      details: { relativePath: '../x.txt' },
    });
    // An unsafe path is refused before an unknown workspace, as before the move.
    await expect(resolver.resolvePath('missing', '../x.txt', 'read')).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
    });
  });

  it('rethrows a file system failure with its error code', async () => {
    const resolver = await resolverWith({
      ok: false,
      error: {
        code: 'io_error',
        message: 'the path could not be resolved (EACCES)',
        errno: 'EACCES',
      },
    });
    await expect(resolver.resolvePath('test', 'inside.txt', 'read')).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it('answers ENGINE_UNAVAILABLE without an engine', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-paths-no-engine-'));
    roots.push(root);
    const mod = path.join(root, 'mod');
    await mkdir(mod);
    replaceSharedResidentEngine(
      new ResidentEngine({
        env: { ...process.env, HOI4_ENGINE: path.join(root, 'no-such-engine.exe') },
      }),
    );
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        workspaces: [{ id: 'test', name: 'No engine', root: mod }],
      }),
    );
    await expect(resolver.resolvePath('test', 'inside.txt', 'read')).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
    });
  });
});
