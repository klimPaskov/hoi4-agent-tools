import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HTTP_MAX_AGGREGATE_BODY_BYTES,
  HTTP_MAX_BODY_BYTES,
  loadConfiguration,
  serverConfigurationSchema,
  workspaceRegistrationSchema,
} from '../../src/hoi4_agent_tools/core/configuration.js';
import {
  automaticConfiguration,
  configurationPath,
  createEngine,
  defaultConfigurationPath,
} from '../../src/hoi4_agent_tools/runtime.js';

const temporaryRoots: string[] = [];
const originalConfigPath = process.env.HOI4_AGENT_CONFIG;

afterEach(async () => {
  if (originalConfigPath === undefined) delete process.env.HOI4_AGENT_CONFIG;
  else process.env.HOI4_AGENT_CONFIG = originalConfigPath;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function configurationFile(value: unknown, raw = false): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-configuration-test-'));
  temporaryRoots.push(root);
  const filePath = path.join(root, 'config.json');
  await writeFile(filePath, raw ? String(value) : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

const workspace = {
  id: 'fixture',
  name: 'Fixture workspace',
  root: 'C:/fixture',
};

describe('configuration loading and path selection', () => {
  it('builds an immediate local configuration from the MCP working directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-automatic-configuration-'));
    temporaryRoots.push(root);
    const modRoot = path.join(root, 'my_mod');
    await mkdir(path.join(modRoot, 'common'), { recursive: true });
    await writeFile(path.join(modRoot, 'descriptor.mod'), 'name="My Mod"\n', 'utf8');

    const configuration = await automaticConfiguration(path.join(modRoot, 'common'));

    expect(configuration.workspaces).toHaveLength(1);
    expect(configuration.workspaces[0]).toMatchObject({
      id: 'auto_my_mod',
      name: 'my_mod',
      root: modRoot,
      kind: 'mod',
    });
    expect(configuration.serverStateRoot).toBeTruthy();
    expect(configuration.workspaceStorageRoot).toBeTruthy();
  });

  it('accepts only exact non-opaque HTTP(S) origins', () => {
    for (const origin of [
      'file:///tmp/agent',
      'data:text/plain,agent',
      'https://user:secret@agent.example.test',
      'https://agent.example.test/path',
      'https://agent.example.test/?query=yes',
      'https://agent.example.test/#fragment',
    ]) {
      expect(
        serverConfigurationSchema.safeParse({
          version: 1,
          http: { allowedOrigins: [origin] },
        }).success,
        origin,
      ).toBe(false);
    }
    expect(
      serverConfigurationSchema.safeParse({
        version: 1,
        http: { allowedOrigins: ['http://127.0.0.1:3210', 'https://agent.example.test'] },
      }).success,
    ).toBe(true);
  });

  it('keeps HTTP concurrency and JSON body budgets within the fixed memory envelope', () => {
    expect(
      serverConfigurationSchema.safeParse({
        version: 1,
        http: { maxConcurrentRequests: 3 },
      }).success,
    ).toBe(false);
    expect(
      serverConfigurationSchema.safeParse({
        version: 1,
        http: { maxConcurrentRequests: 2, maxBodyBytes: HTTP_MAX_BODY_BYTES + 1 },
      }).success,
    ).toBe(false);
    const maximum = serverConfigurationSchema.safeParse({
      version: 1,
      http: { maxConcurrentRequests: 2, maxBodyBytes: HTTP_MAX_BODY_BYTES },
    });
    expect(maximum.success).toBe(true);
    if (maximum.success) {
      expect(maximum.data.http.maxBodyBytes).toBe(HTTP_MAX_BODY_BYTES);
      expect(maximum.data.http.maxBodyBytes * maximum.data.http.maxConcurrentRequests).toBe(
        HTTP_MAX_AGGREGATE_BODY_BYTES,
      );
    }
  });

  it('requires isolated state for writable mods and bounds collections', () => {
    expect(
      serverConfigurationSchema.safeParse({ version: 1, writePolicy: 'transactions' }).success,
    ).toBe(false);
    expect(
      serverConfigurationSchema.safeParse({
        version: 1,
        serverStateRoot: 'relative/server-state',
        modRoots: [path.resolve('mods')],
      }).success,
    ).toBe(false);
    expect(
      serverConfigurationSchema.safeParse({
        version: 1,
        workspaces: [workspace],
      }).success,
    ).toBe(false);
    expect(
      serverConfigurationSchema.safeParse({
        version: 1,
        registrationRoots: Array.from({ length: 17 }, (_, index) => `/root-${index}`),
      }).success,
    ).toBe(false);
    expect(
      serverConfigurationSchema.safeParse({
        version: 1,
        serverStateRoot: path.resolve('server-state'),
        modRoots: Array.from({ length: 17 }, (_, index) => `/mods-${index}`),
      }).success,
    ).toBe(false);
    expect(
      workspaceRegistrationSchema.safeParse({
        ...workspace,
        dependencyRoots: Array.from({ length: 17 }, (_, index) => `C:/dependency-${index}`),
      }).success,
    ).toBe(false);
    expect(
      serverConfigurationSchema.safeParse({
        version: 1,
        workspaces: Array.from({ length: 1_001 }, (_, index) => ({
          id: `workspace-${index}`,
          name: `Workspace ${index}`,
          root: `C:/workspace-${index}`,
        })),
      }).success,
    ).toBe(false);
  });

  it('makes automatic mod-root discovery writable by default and requires isolated state', () => {
    expect(
      serverConfigurationSchema.safeParse({
        version: 1,
        modRoots: [path.resolve('mods')],
      }).success,
    ).toBe(false);
    const automatic = serverConfigurationSchema.safeParse({
      version: 1,
      serverStateRoot: path.resolve('server-state'),
      modRoots: [path.resolve('mods')],
      gameRoot: path.resolve('game'),
      workspaceStorageRoot: path.resolve('workspace-storage'),
    });
    expect(automatic.success).toBe(true);
    if (automatic.success) expect(automatic.data.modRoots).toEqual([path.resolve('mods')]);
  });

  it('loads defaults and validates known static-token and OAuth-principal grants', async () => {
    const filePath = await configurationFile({
      version: 1,
      serverStateRoot: path.resolve('server-state'),
      workspaces: [workspace],
      http: {
        tokens: [
          {
            principal: 'static-user',
            tokenEnv: 'HOI4_TEST_TOKEN',
            workspaceIds: ['fixture'],
          },
        ],
        principals: [{ principal: 'oauth-user', workspaceIds: ['fixture'] }],
      },
    });

    await expect(loadConfiguration(filePath)).resolves.toMatchObject({
      modRoots: [],
      workspaces: [expect.objectContaining({ id: 'fixture' })],
      http: {
        tokens: [expect.objectContaining({ principal: 'static-user', allowDiscoveredMods: false })],
        principals: [
          expect.objectContaining({ principal: 'oauth-user', allowDiscoveredMods: false }),
        ],
      },
    });
  });

  it('rejects unreadable, malformed, and schema-invalid configuration files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-missing-configuration-'));
    temporaryRoots.push(root);
    await expect(loadConfiguration(path.join(root, 'missing.json'))).rejects.toMatchObject({
      code: 'CONFIG_READ_FAILED',
    });

    const malformed = await configurationFile('{not-json', true);
    await expect(loadConfiguration(malformed)).rejects.toMatchObject({
      code: 'CONFIG_READ_FAILED',
    });

    const invalid = await configurationFile({ version: 2 });
    await expect(loadConfiguration(invalid)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('rejects duplicate workspaces and unknown token or principal grants', async () => {
    const duplicate = await configurationFile({
      version: 1,
      serverStateRoot: path.resolve('server-state'),
      workspaces: [workspace, { ...workspace, name: 'Duplicate fixture' }],
    });
    await expect(loadConfiguration(duplicate)).rejects.toMatchObject({
      code: 'CONFIG_DUPLICATE_WORKSPACE',
    });

    const unknownToken = await configurationFile({
      version: 1,
      serverStateRoot: path.resolve('server-state'),
      workspaces: [workspace],
      http: {
        tokens: [
          {
            principal: 'static-user',
            tokenEnv: 'HOI4_TEST_TOKEN',
            workspaceIds: ['missing'],
          },
        ],
      },
    });
    await expect(loadConfiguration(unknownToken)).rejects.toMatchObject({
      code: 'CONFIG_UNKNOWN_WORKSPACE_GRANT',
      details: { principal: 'static-user', workspaceIds: ['missing'] },
    });

    const unknownPrincipal = await configurationFile({
      version: 1,
      serverStateRoot: path.resolve('server-state'),
      workspaces: [workspace],
      http: {
        principals: [{ principal: 'oauth-user', workspaceIds: ['missing'] }],
      },
    });
    await expect(loadConfiguration(unknownPrincipal)).rejects.toMatchObject({
      code: 'CONFIG_UNKNOWN_WORKSPACE_GRANT',
      details: { principal: 'oauth-user', workspaceIds: ['missing'] },
    });
  });

  it('rejects ambiguous static-token and OAuth principal identities', () => {
    const token = (principal: string, tokenEnv: string) => ({
      principal,
      tokenEnv,
      workspaceIds: ['fixture'],
    });
    expect(() =>
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.resolve('server-state'),
        workspaces: [workspace],
        http: { tokens: [token('duplicate', 'TOKEN_ONE'), token('duplicate', 'TOKEN_TWO')] },
      }),
    ).toThrow(/principals must be unique/iu);
    expect(() =>
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.resolve('server-state'),
        workspaces: [workspace],
        http: { tokens: [token('one', 'SHARED_TOKEN'), token('two', 'SHARED_TOKEN')] },
      }),
    ).toThrow(/environment names must be unique/iu);
    expect(() =>
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.resolve('server-state'),
        workspaces: [workspace],
        http: {
          principals: [
            { principal: 'duplicate', workspaceIds: ['fixture'] },
            { principal: 'duplicate', workspaceIds: ['fixture'] },
          ],
        },
      }),
    ).toThrow(/OAuth principals must be unique/iu);
    expect(() =>
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.resolve('server-state'),
        workspaces: [workspace],
        http: {
          tokens: [token('shared-user', 'SHARED_USER_TOKEN')],
          principals: [{ principal: 'shared-user', workspaceIds: ['fixture'] }],
        },
      }),
    ).toThrow(/namespaces must be disjoint/iu);
    expect(() =>
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.resolve('server-state'),
        workspaces: [workspace],
        http: {
          tokens: [token('static-user', 'STATIC_USER_TOKEN')],
          oauth: {
            issuer: 'https://identity.example.test/',
            jwksUri: 'https://identity.example.test/.well-known/jwks.json',
            audience: 'hoi4-agent-tools',
            authorizationServers: ['https://identity.example.test/'],
          },
        },
      }),
    ).toThrow(/mutually exclusive/iu);
  });

  it('rejects simultaneous legacy and structured dependency registration', () => {
    expect(() =>
      workspaceRegistrationSchema.parse({
        ...workspace,
        dependencyRoots: ['C:/legacy-dependency'],
        dependencies: [{ root: 'C:/structured-dependency' }],
      }),
    ).toThrowError(/not both/iu);
  });

  it('prefers an explicit config path and rejects missing option values', () => {
    expect(configurationPath(['--config', './fixture.json'])).toBe(path.resolve('./fixture.json'));
    expect(() => configurationPath(['--config'])).toThrowError(
      expect.objectContaining({ code: 'CONFIG_ARGUMENT_MISSING' }),
    );
    expect(() => configurationPath(['--config', '--other'])).toThrowError(
      expect.objectContaining({ code: 'CONFIG_ARGUMENT_MISSING' }),
    );
  });

  it('uses the environment or home default and creates an engine from the default argument', async () => {
    const filePath = await configurationFile({ version: 1 });
    process.env.HOI4_AGENT_CONFIG = filePath;
    expect(configurationPath([])).toBe(path.resolve(filePath));
    const engine = await createEngine();
    expect(engine.resolver.list()).toEqual([]);

    delete process.env.HOI4_AGENT_CONFIG;
    expect(configurationPath([])).toBe(defaultConfigurationPath());
  });
});
