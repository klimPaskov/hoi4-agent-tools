import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import type * as RenderModule from '../../src/hoi4_agent_tools/event/render.js';

// Spend the request's raster budget on the second branch image.
let branchRenders = 0;
vi.mock('../../src/hoi4_agent_tools/event/render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RenderModule>();
  return {
    ...actual,
    renderEventGraph: vi.fn(async (...parameters: Parameters<typeof actual.renderEventGraph>) => {
      if (parameters[1].view === 'neighborhood' && ++branchRenders >= 2)
        throw new ServiceError(
          'RENDER_AGGREGATE_BLOCKED',
          'event chain render exceeds the fixed aggregate render budget for one request',
        );
      return actual.renderEventGraph(...parameters);
    }),
  };
});

const { EventChainViewer } = await import('../../src/hoi4_agent_tools/event/index.js');

const roots: string[] = [];
afterEach(async () => {
  branchRenders = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('overview branch render budget', () => {
  it('returns the overview and the branches that fit instead of failing the request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-event-render-budget-'));
    roots.push(root);
    const mod = path.join(root, 'mod');
    await mkdir(path.join(mod, 'events'), { recursive: true });
    const chains = Array.from(
      { length: 3 },
      (_, index) => `country_event = {
\tid = budget.${index * 2 + 1}
\tis_triggered_only = yes
\toption = { name = budget.${index * 2 + 1}.a country_event = budget.${index * 2 + 2} }
}
country_event = {
\tid = budget.${index * 2 + 2}
\tis_triggered_only = yes
\toption = { name = budget.${index * 2 + 2}.a }
}
`,
    ).join('');
    await writeFile(path.join(mod, 'events', 'budget.txt'), `add_namespace = budget\n${chains}`);
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(root, 'state'),
          workspaces: [{ id: 'budget', name: 'Render budget', root: mod }],
        }),
      ),
    );

    const rendered = await new EventChainViewer(engine).renderAndStore({
      workspaceId: 'budget',
      view: 'overview',
      maxNodes: 2,
      includeHtml: false,
      refresh: true,
    });

    expect(rendered.render.selectedNodeIds.length).toBeGreaterThan(0);
    expect(rendered.branches).toHaveLength(1);
    expect(rendered.budgetOmittedBranches).toBeGreaterThan(0);
    expect(JSON.parse(rendered.manifestJson)).toMatchObject({
      branches: [expect.objectContaining({ index: 1 })],
      coverage: { budgetOmittedBranches: rendered.budgetOmittedBranches, truncated: true },
    });
  });
});
