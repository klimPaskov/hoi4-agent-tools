import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import type { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import {
  planMapOperations,
  type MapOperation,
  type MapOperationPlan,
} from '../../src/hoi4_agent_tools/map/operations.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';

/**
 * A generated world for the operation tests: `create_world` with the feature-aware partition on a
 * small map, planned in memory, with the files it would write. Nothing here is game data.
 */
export interface GeneratedFixtureWorld {
  index: MapWorkspaceIndex;
  files: Map<string, Buffer>;
}

const cleanup: string[] = [];
export async function removeTerritoryWorkspaces(): Promise<void> {
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true });
}

export interface WorkspaceHandle {
  nudger: AgentNudger;
  root: string;
  scan: () => Promise<MapWorkspaceIndex>;
}

/** A mod folder holding exactly these files, behind a real resolver and nudger. */
export async function workspaceOf(
  files: ReadonlyMap<string, Buffer | string>,
): Promise<WorkspaceHandle> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-territory-'));
  cleanup.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(mod, { recursive: true });
  for (const [relativePath, content] of files) {
    const target = path.join(mod, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'territory', name: 'Territory', root: mod }],
    }),
  );
  const nudger = new AgentNudger(resolver, new TransactionManager(resolver));
  return {
    nudger,
    root: mod,
    scan: async () =>
      (await nudger.scan('territory', undefined, undefined, false, false, false, true)).index,
  };
}

export function parseOperations(operations: unknown[]): MapOperation[] {
  return operations.map((operation) => mapOperationSchema.parse(operation) as MapOperation);
}

export function plan(index: MapWorkspaceIndex, operations: unknown[]): MapOperationPlan {
  return planMapOperations(index, parseOperations(operations));
}

export async function generatedWorld(
  extra: Record<string, unknown> = {},
): Promise<GeneratedFixtureWorld & { workspace: WorkspaceHandle }> {
  const empty = await workspaceOf(new Map([['descriptor.mod', 'name="World"\n']]));
  const index = await empty.scan();
  const result = plan(index, [
    {
      id: 'world',
      kind: 'create_world',
      width: 768,
      height: 512,
      seed: 5,
      rivers: 30,
      landProvincePixels: 150,
      provincesPerState: 6,
      partition: 'feature-aware',
      countries: [
        { tag: 'AAA', name: 'Aster' },
        { tag: 'BBB', name: 'Brum' },
        { tag: 'CCC', name: 'Corvel' },
        { tag: 'DDD', name: 'Dorn' },
      ],
      ...extra,
    },
  ]);
  if (result.blockers.length > 0)
    throw new Error(`world generation blocked: ${JSON.stringify(result.blockers)}`);
  const files = new Map(
    result.changes
      .filter(({ content }) => content !== null)
      .map(({ relativePath, content }) => [relativePath, Buffer.from(content!)] as const),
  );
  const workspace = await workspaceOf(files);
  return { index: result.finalIndex, files, workspace };
}

/** State ids spread over the land: farthest-point sampling over province-centre means. */
export function spreadStates(index: MapWorkspaceIndex, count: number): number[] {
  const centres = index.states
    .map((state) => {
      let x = 0;
      let y = 0;
      let n = 0;
      for (const province of state.provinces) {
        const geometry = index.raster?.geometry.get(province);
        if (geometry === undefined) continue;
        x += geometry.centerX * geometry.pixelCount;
        y += geometry.centerY * geometry.pixelCount;
        n += geometry.pixelCount;
      }
      return { id: state.id, x: x / Math.max(1, n), y: y / Math.max(1, n) };
    })
    .sort((a, b) => a.id - b.id);
  const chosen = [centres[0]!];
  while (chosen.length < count) {
    let best = centres[0]!;
    let distance = -1;
    for (const candidate of centres) {
      const nearest = Math.min(
        ...chosen.map((other) => (other.x - candidate.x) ** 2 + (other.y - candidate.y) ** 2),
      );
      if (nearest > distance) {
        distance = nearest;
        best = candidate;
      }
    }
    chosen.push(best);
  }
  return chosen.map(({ id }) => id);
}

export function changedText(result: MapOperationPlan, relativePath: string): string | undefined {
  const change = result.changes.find((candidate) => candidate.relativePath === relativePath);
  return change?.content == null ? undefined : Buffer.from(change.content).toString('utf8');
}

/** States adjacent to a state (sharing a province border), by id. */
export function neighbourStates(index: MapWorkspaceIndex, stateId: number): number[] {
  const state = index.statesById.get(stateId)!;
  const result = new Set<number>();
  for (const province of state.provinces)
    for (const other of index.raster?.adjacency.get(province) ?? []) {
      const owner = index.stateForProvince(other)[0];
      if (owner !== undefined && owner.id !== stateId) result.add(owner.id);
    }
  return [...result].sort((a, b) => a - b);
}

/** A state on the same landmass that is `depth` states away from `stateId` (breadth first). */
export function stateAtDepth(index: MapWorkspaceIndex, stateId: number, depth: number): number {
  let frontier = [stateId];
  const seen = new Set(frontier);
  for (let step = 0; step < depth; step += 1) {
    const next: number[] = [];
    for (const id of frontier)
      for (const other of neighbourStates(index, id))
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
    if (next.length === 0) break;
    frontier = next;
  }
  return frontier[frontier.length - 1]!;
}
