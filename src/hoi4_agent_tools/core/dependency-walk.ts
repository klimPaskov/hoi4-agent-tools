import { z } from 'zod/v4';
import { hashCanonical } from './canonical.js';
import { currentAnalysisCheckpoints } from './analysis-checkpoints.js';
import { ServiceError } from './result.js';

export interface DependencyEdge {
  id: string;
  from: string;
  to: string;
}
export interface DependencyWalkInput {
  domain: string;
  sourceRevision: string;
  edges: readonly DependencyEdge[];
  roots: readonly string[];
  branches: readonly string[];
  maximumDepth: number;
  /** Structural graphs retain alternate routes when one proof per reachable helper suffices. */
  visitPolicy: 'node' | 'path';
  reverseEdges: boolean;
  maximumSteps: number;
}

const ordinal = z.number().int().nonnegative();
const pathSchema = z.object({ edge: ordinal, parent: ordinal.nullable() }).strict();
const recordSchema = z
  .object({
    kind: z.enum(['visit', 'terminal', 'cycle', 'depth']),
    root: ordinal,
    path: ordinal,
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    key: z.string(),
    root: ordinal,
    steps: ordinal,
    paths: z.array(pathSchema),
    records: z.array(recordSchema),
    stack: z.array(ordinal),
    visited: z.array(z.string()),
    current: z.object({ path: ordinal, edge: ordinal }).strict().nullable(),
    started: z.boolean(),
    complete: z.boolean(),
  })
  .strict();

export type DependencyWalkState = z.infer<typeof stateSchema>;
export type DependencyWalkRecord = z.infer<typeof recordSchema>;

/** A bounded, serializable DFS frontier; paths share prefixes instead of copying source data. */
export class DependencyWalk {
  readonly state: DependencyWalkState;
  readonly key: string;
  private readonly edges: Map<string, number>;
  private readonly outgoing = new Map<string, number[]>();
  private readonly branches: Set<string>;
  private readonly visited: Set<string>;

  constructor(
    readonly input: DependencyWalkInput,
    restored?: DependencyWalkState,
  ) {
    this.key = hashCanonical({ algorithm: 'dependency-walk.v1', ...input });
    this.edges = new Map(input.edges.map(({ id }, index) => [id, index]));
    if (this.edges.size !== input.edges.length || input.roots.some((id) => !this.edges.has(id)))
      throw new ServiceError(
        'DEPENDENCY_WALK_INPUT_INVALID',
        'Dependency edge identities must be unique and roots must exist',
      );
    if (
      !Number.isSafeInteger(input.maximumDepth) ||
      input.maximumDepth < 1 ||
      !Number.isSafeInteger(input.maximumSteps) ||
      input.maximumSteps < 1
    )
      throw new ServiceError(
        'DEPENDENCY_WALK_INPUT_INVALID',
        'Dependency traversal requires finite positive bounds',
      );
    this.branches = new Set(input.branches);
    for (const [index, edge] of input.edges.entries()) {
      const values = this.outgoing.get(edge.from) ?? [];
      values.push(index);
      this.outgoing.set(edge.from, values);
    }
    if (input.reverseEdges) for (const values of this.outgoing.values()) values.reverse();
    const decoded = restored === undefined ? undefined : stateSchema.safeParse(restored);
    if (decoded !== undefined && !decoded.success)
      throw new ServiceError(
        'DEPENDENCY_CHECKPOINT_INVALID',
        'Dependency checkpoint has an invalid state schema',
      );
    this.state = decoded?.data ?? {
      version: 1,
      key: this.key,
      root: 0,
      steps: 0,
      paths: [],
      records: [],
      stack: [],
      visited: [],
      current: null,
      started: false,
      complete: input.roots.length === 0,
    };
    if (
      this.state.key !== this.key ||
      this.state.root > input.roots.length ||
      this.state.steps > input.maximumSteps
    )
      throw new ServiceError(
        'DEPENDENCY_CHECKPOINT_STALE',
        'Dependency checkpoint does not match this exact source graph and traversal contract',
      );
    this.validateState();
    this.visited = new Set(this.state.visited);
  }

  private validateState(): void {
    const invalid = (message: string): never => {
      throw new ServiceError('DEPENDENCY_CHECKPOINT_INVALID', message);
    };
    if (
      this.state.complete !== (this.state.root === this.input.roots.length) ||
      (!this.state.started && (this.state.current !== null || this.state.stack.length !== 0)) ||
      (this.state.complete && this.state.started) ||
      this.state.paths.length > this.state.steps ||
      this.state.records.length > this.state.steps ||
      new Set(this.state.stack).size !== this.state.stack.length ||
      new Set(this.state.visited).size !== this.state.visited.length
    )
      invalid('Dependency checkpoint has inconsistent lifecycle or retained work');
    const roots: number[] = [];
    const rootEdges = new Set(this.input.roots.map((id) => this.edges.get(id)!));
    for (const [index, path] of this.state.paths.entries()) {
      if (path.edge >= this.input.edges.length || (path.parent !== null && path.parent >= index))
        throw new ServiceError(
          'DEPENDENCY_CHECKPOINT_INVALID',
          'Dependency checkpoint contains an invalid path',
        );
      if (path.parent === null) {
        if (!rootEdges.has(path.edge))
          invalid('Dependency path starts outside the requested roots');
        roots.push(path.edge);
      } else {
        const previous = this.input.edges[this.state.paths[path.parent]!.edge]!;
        if (previous.to !== this.input.edges[path.edge]!.from)
          invalid('Dependency checkpoint path is disconnected from its parent edge');
        roots.push(roots[path.parent]!);
      }
    }
    for (const index of [
      ...this.state.stack,
      ...(this.state.current === null ? [] : [this.state.current.path]),
    ])
      if (
        index >= this.state.paths.length ||
        this.input.edges[roots[index]!]!.id !== this.input.roots[this.state.root]
      )
        throw new ServiceError(
          'DEPENDENCY_CHECKPOINT_INVALID',
          'Dependency frontier points outside its retained paths',
        );
    if (this.state.current !== null) {
      const { path, edge } = this.state.current;
      const node = this.input.edges[this.state.paths[path]!.edge]!.to;
      if (edge > (this.outgoing.get(node)?.length ?? 0) || this.state.stack.includes(path))
        invalid(
          'Dependency adjacency cursor is outside its current node or duplicates the frontier',
        );
    }
    for (const record of this.state.records)
      if (
        record.root >= this.input.roots.length ||
        record.path >= this.state.paths.length ||
        this.input.edges[roots[record.path]!]!.id !== this.input.roots[record.root]
      )
        throw new ServiceError(
          'DEPENDENCY_CHECKPOINT_INVALID',
          'Dependency evidence points outside its retained graph',
        );
  }

  path(index: number): DependencyEdge[] {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.state.paths.length)
      throw new ServiceError(
        'DEPENDENCY_PATH_INVALID',
        'Dependency path ordinal is outside the retained frontier',
      );
    const values: DependencyEdge[] = [];
    let cursor: number | null = index;
    while (cursor !== null) {
      const path: z.infer<typeof pathSchema> = this.state.paths[cursor]!;
      values.push(this.input.edges[path.edge]!);
      cursor = path.parent;
    }
    return values.reverse();
  }

  private addPath(edge: number, parent: number | null): number {
    this.state.paths.push({ edge, parent });
    return this.state.paths.length - 1;
  }

  private record(kind: DependencyWalkRecord['kind'], path: number): void {
    this.state.records.push({ kind, path, root: this.state.root });
  }

  /** Advance at most this many elementary transitions, including wide adjacency lists. */
  advance(maximumSteps: number, signal?: AbortSignal): boolean {
    if (!Number.isSafeInteger(maximumSteps) || maximumSteps < 1)
      throw new ServiceError('DEPENDENCY_BATCH_INVALID', 'Dependency batch size must be positive');
    const end = this.state.steps + maximumSteps;
    while (!this.state.complete && this.state.steps < end) {
      signal?.throwIfAborted();
      if (this.state.steps >= this.input.maximumSteps)
        throw new ServiceError(
          'DEPENDENCY_WORK_LIMIT',
          'Dependency expansion reached its explicit work ceiling',
          {
            maximum: this.input.maximumSteps,
            completedRoots: this.state.root,
            totalRoots: this.input.roots.length,
          },
        );
      this.state.steps++;
      if (!this.state.started) {
        const edge = this.edges.get(this.input.roots[this.state.root]!)!;
        const rootPath = this.addPath(edge, null);
        this.state.stack.push(rootPath);
        this.visited.clear();
        if (this.input.visitPolicy === 'node') this.visited.add(this.input.edges[edge]!.to);
        this.state.started = true;
        continue;
      }
      if (this.state.current === null) {
        const path = this.state.stack.pop();
        if (path === undefined) {
          this.state.root++;
          this.state.started = false;
          this.state.complete = this.state.root === this.input.roots.length;
          continue;
        }
        if (this.input.visitPolicy === 'path') {
          const key = this.path(path)
            .map(({ to }) => to)
            .join('\0');
          if (this.visited.has(key)) continue;
          this.visited.add(key);
        }
        this.record('visit', path);
        this.state.current = { path, edge: 0 };
        continue;
      }
      const current = this.state.current;
      const node = this.input.edges[this.state.paths[current.path]!.edge]!.to;
      const candidates = this.outgoing.get(node) ?? [];
      const edgeIndex = candidates[current.edge++];
      if (edgeIndex === undefined) {
        this.state.current = null;
        continue;
      }
      const edge = this.input.edges[edgeIndex]!;
      if (!this.branches.has(edge.to)) {
        this.record('terminal', this.addPath(edgeIndex, current.path));
        continue;
      }
      const ancestors = this.path(current.path).map(({ to }) => to);
      if (ancestors.includes(edge.to)) {
        this.record('cycle', this.addPath(edgeIndex, current.path));
        continue;
      }
      if (ancestors.length >= this.input.maximumDepth) {
        this.record('depth', this.addPath(edgeIndex, current.path));
        continue;
      }
      const visitKey =
        this.input.visitPolicy === 'node' ? edge.to : [...ancestors, edge.to].join('\0');
      if (this.input.visitPolicy === 'node') {
        if (this.visited.has(visitKey)) continue;
        this.visited.add(visitKey);
      }
      this.state.stack.push(this.addPath(edgeIndex, current.path));
    }
    return this.state.complete;
  }

  checkpoint(): DependencyWalkState {
    this.state.visited = [...this.visited];
    return this.state;
  }
}

export function walkDependencies(input: DependencyWalkInput, signal?: AbortSignal): DependencyWalk {
  const walk = new DependencyWalk(input);
  while (!walk.state.complete) walk.advance(256, signal);
  return walk;
}

export async function walkDependenciesAsync(
  input: DependencyWalkInput,
  signal?: AbortSignal,
  checkpointSteps = 2_048,
): Promise<DependencyWalk> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(checkpointSteps) || checkpointSteps < 1)
    throw new ServiceError('DEPENDENCY_BATCH_INVALID', 'Checkpoint interval must be positive');
  const checkpoints = currentAnalysisCheckpoints();
  const key = hashCanonical({ algorithm: 'dependency-walk.v1', ...input });
  const restored = await checkpoints?.load(key, input.sourceRevision, stateSchema);
  const walk = new DependencyWalk(input, restored);
  let savedAt = walk.state.steps;
  while (!walk.state.complete) {
    const complete = walk.advance(256, signal);
    if ((complete && savedAt > 0) || walk.state.steps - savedAt >= checkpointSteps) {
      await checkpoints?.save(
        key,
        input.sourceRevision,
        walk.checkpoint(),
        walk.state.root,
        input.roots.length,
      );
      savedAt = walk.state.steps;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal?.throwIfAborted();
  }
  return walk;
}

export type DependencyAnalysis<T> = Generator<DependencyWalkInput, T, DependencyWalk>;

export function runDependencyAnalysis<T>(analysis: DependencyAnalysis<T>, signal?: AbortSignal): T {
  let next = analysis.next();
  while (!next.done) next = analysis.next(walkDependencies(next.value, signal));
  return next.value;
}

export async function runDependencyAnalysisAsync<T>(
  analysis: DependencyAnalysis<T>,
  signal?: AbortSignal,
): Promise<T> {
  let next = analysis.next();
  while (!next.done) next = analysis.next(await walkDependenciesAsync(next.value, signal));
  return next.value;
}
