import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { EventChainViewer } from '../../src/hoi4_agent_tools/event/index.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const callback of cleanup.splice(0).reverse()) await callback();
});

describe('event-calling source surfaces', () => {
  it('scans official event-calling common directories into the shared event graph', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-event-source-surfaces-'));
    const mod = path.join(temporary, 'mod');
    const runtime = path.join(temporary, 'runtime');
    const sources = [
      ['common/operations/synthetic_operation.txt', 'surface.1'],
      ['common/raids/synthetic_raid.txt', 'surface.2'],
      ['common/bop/synthetic_balance.txt', 'surface.3'],
      ['common/resistance_compliance_modifiers/synthetic_resistance.txt', 'surface.4'],
      ['common/special_projects/projects/synthetic_project.txt', 'surface.5'],
    ] as const;

    await Promise.all([
      mkdir(path.join(mod, 'events'), { recursive: true }),
      mkdir(runtime, { recursive: true }),
      ...sources.map(([relativePath]) =>
        mkdir(path.dirname(path.join(mod, relativePath)), { recursive: true }),
      ),
    ]);
    await Promise.all([
      writeFile(
        path.join(mod, 'events', 'surface.txt'),
        `${sources
          .map(
            ([, eventId]) =>
              `country_event = {\n\tid = ${eventId}\n\thidden = yes\n\tis_triggered_only = yes\n}`,
          )
          .join('\n\n')}\n`,
        'utf8',
      ),
      ...sources.map(([relativePath, eventId], index) =>
        writeFile(
          path.join(mod, relativePath),
          `synthetic_source_${index + 1} = {\n\tcountry_event = ${eventId}\n}\n`,
          'utf8',
        ),
      ),
    ]);

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'state'),
      storageRoots: [runtime],
      workspaces: [
        {
          id: 'event-source-surfaces',
          name: 'Event source surface fixture',
          root: mod,
          artifactRoot: path.join(runtime, 'artifacts'),
          cacheRoot: path.join(runtime, 'cache'),
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    cleanup.push(async () => rm(temporary, { recursive: true, force: true }));

    const snapshot = await engine.scan('event-source-surfaces');
    const scannedPaths = new Set(
      snapshot.files.map(({ relativePath }) => relativePath.replaceAll('\\', '/')),
    );
    for (const [relativePath] of sources) expect(scannedPaths).toContain(relativePath);

    const graph = await new EventChainViewer(engine).scan('event-source-surfaces');
    for (const [relativePath, eventId] of sources) {
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          to: `event:${eventId}`,
          reason: 'other_entry',
          derived: false,
          location: expect.objectContaining({ path: expect.stringMatching(relativePath) }),
        }),
      );
    }
  });
});
