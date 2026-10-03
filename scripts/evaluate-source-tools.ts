import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoreEngine } from '../src/hoi4_agent_tools/core/engine.js';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import { sourceLookup } from '../src/hoi4_agent_tools/reference/source-lookup.js';
import { ReferenceService } from '../src/hoi4_agent_tools/reference/service.js';
import { validateScript } from '../src/hoi4_agent_tools/reference/script-validation.js';
import { sourceLookupRequestSchema } from '../src/hoi4_agent_tools/schemas/reference.js';
import { scriptValidateRequestSchema } from '../src/hoi4_agent_tools/schemas/script-validation.js';

const [modRoot, gameRoot] = process.argv.slice(2);
const gameOnly = process.argv.includes('--game-only');
const persistentCache = !process.argv.includes('--no-persistent-cache');
if (modRoot === undefined || gameRoot === undefined)
  throw new Error('Usage: tsx scripts/evaluate-source-tools.ts MOD_ROOT GAME_ROOT');
const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-source-evaluation-'));
const timings: Array<{
  name: string;
  ms: number;
  bytes: number;
  rssMiB: number;
  cpuUserMs: number;
  error?: string;
}> = [];
try {
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'state'),
      storageRoots: [path.join(temporary, 'artifacts'), path.join(temporary, 'cache')],
      workspaces: [
        {
          id: 'evaluation',
          name: 'Source evaluation',
          root: gameOnly ? gameRoot : modRoot,
          ...(gameOnly ? { kind: 'game' as const } : { gameRoot }),
          artifactRoot: path.join(temporary, 'artifacts'),
          cacheRoot: path.join(temporary, 'cache'),
        },
      ],
    }),
  );
  const engine = new CoreEngine(resolver, persistentCache ? {} : { persistentAnalysisCache: null });
  const input = sourceLookupRequestSchema.parse({
    workspaceId: 'evaluation',
    symbol: 'political.1',
    kind: 'event',
    includeReferences: false,
    view: 'structure',
  });
  const measure = async <T>(
    name: string,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const start = performance.now();
    const cpu = process.cpuUsage();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Evaluation stage timed out: ${name}`)),
      180_000,
    );
    process.stderr.write(`${JSON.stringify({ stage: name, state: 'started' })}\n`);
    try {
      const result = await call(controller.signal);
      const receipt = {
        name,
        ms: Math.round(performance.now() - start),
        bytes: Buffer.byteLength(JSON.stringify(result)),
        rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        cpuUserMs: Math.round(process.cpuUsage(cpu).user / 1000),
      };
      timings.push(receipt);
      process.stderr.write(`${JSON.stringify({ ...receipt, state: 'completed' })}\n`);
      return result;
    } catch (error) {
      const receipt = {
        name,
        ms: Math.round(performance.now() - start),
        bytes: 0,
        rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        cpuUserMs: Math.round(process.cpuUsage(cpu).user / 1000),
        error: error instanceof Error ? error.message : String(error),
      };
      timings.push(receipt);
      process.stderr.write(`${JSON.stringify({ ...receipt, state: 'failed' })}\n`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const structure = await measure('cold_event_structure', (signal) =>
    sourceLookup(engine, 'evaluation', input, undefined, signal),
  );
  assert.equal(structure.definitionCount, 1);
  assert.equal(
    structure.definitions[0]?.navigation?.children.filter(({ key }) => key === 'option').length,
    2,
  );
  const nested = await measure('warm_nested_command', (signal) =>
    sourceLookup(
      engine,
      'evaluation',
      {
        ...input,
        view: 'source',
        expectedRevision: structure.revision,
        keyPath: [{ key: 'option', occurrence: 0 }, { key: 'add_political_power' }],
      },
      undefined,
      signal,
    ),
  );
  const definition = nested.definitions[0]!;
  assert.equal(definition.text, 'add_political_power = -100');
  assert.equal(definition.nextLine, null);
  const references = new ReferenceService();
  const checkInput = scriptValidateRequestSchema.parse({
    workspaceId: 'evaluation',
    source: definition.text,
    kind: 'effect',
    scope: 'country',
  });
  const supported = await measure('installed_command_check', (signal) =>
    validateScript(references, resolver.get('evaluation'), checkInput, signal),
  );
  assert.equal(supported.valid, true);
  const wrongScope = await validateScript(references, resolver.get('evaluation'), {
    ...checkInput,
    scope: 'state',
  });
  assert.equal(wrongScope.valid, false);
  assert.equal(wrongScope.findings[0]?.code, 'SCRIPT_COMMAND_WRONG_SCOPE');
  const expanded = await measure('expanded_reference_lookup', (signal) =>
    sourceLookup(
      engine,
      'evaluation',
      { ...input, view: 'source', includeReferences: true },
      undefined,
      signal,
    ),
  );
  const repeated = await measure('repeated_reference_lookup', (signal) =>
    sourceLookup(
      engine,
      'evaluation',
      {
        ...input,
        view: 'source',
        includeReferences: true,
        expectedRevision: expanded.revision,
      },
      undefined,
      signal,
    ),
  );
  assert.deepEqual(repeated, expanded);
  const report = {
    gameOnly,
    persistentCache,
    timings,
    source: {
      path: definition.path,
      revision: structure.revision,
      navigation: definition.navigation,
    },
    documentation: supported.documentation,
    command: supported.findings[0]?.reference,
    coverage: {
      complete: expanded.complete,
      referencesComplete: expanded.referencesComplete,
      unresolvedReferences: expanded.unresolvedReferenceCount,
    },
    persistent: await engine.persistentAnalysisCacheStatistics(),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ gameOnly, timings, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
  );
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
