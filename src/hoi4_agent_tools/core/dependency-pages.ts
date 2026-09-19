import { z } from 'zod/v4';
import { hashCanonical } from './canonical.js';
import type { DependencyEdge } from './dependency-walk.js';
import { ServiceError } from './result.js';

export interface DependencyPageInput {
  domain: string;
  sourceRevision: string;
  edges: readonly DependencyEdge[];
  roots: readonly string[];
  branches: readonly string[];
  maximumDepth: number;
  /** edge_path preserves distinct structural edge paths, including parallel conditional calls. */
  visitPolicy: 'node' | 'edge_path';
  reverseEdges: boolean;
}
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const dependencyPageCursorSchema = z
  .object({
    version: z.literal(1),
    key: z.string().regex(/^[a-f0-9]{64}$/u),
    root: ordinal,
    steps: ordinal,
    emitted: ordinal,
    cycles: ordinal,
    depthStops: ordinal,
    frames: z
      .array(z.object({ edge: ordinal, next: ordinal, entered: z.boolean() }).strict())
      .max(256),
    visited: z.array(z.string().min(1)).max(1_000_000),
  })
  .strict();
export type DependencyPageCursor = z.infer<typeof dependencyPageCursorSchema>;
export interface DependencyPageRecord {
  kind: 'visit' | 'terminal' | 'cycle' | 'depth';
  root: number;
  /** Ordinals in the exact revision-bound input edge inventory. */
  path: number[];
}
export interface DependencyPage {
  records: DependencyPageRecord[];
  /** All requested roots were traversed within the explicit depth boundary, not runtime completion. */
  finished: boolean;
  completedRoots: number;
  totalRoots: number;
  work: number;
  cursor: DependencyPageCursor;
}

/** Bounded DFS pages: retain only active ancestors and, for node policy, this root's visited nodes. */
export class DependencyPages {
  readonly key: string;
  private readonly state: DependencyPageCursor;
  private readonly roots: number[];
  private readonly outgoing = new Map<string, number[]>();
  private readonly branches: Set<string>;
  private readonly visited: Set<string>;

  constructor(
    readonly input: DependencyPageInput,
    restored?: DependencyPageCursor,
  ) {
    if (
      !Number.isSafeInteger(input.maximumDepth) ||
      input.maximumDepth < 1 ||
      input.maximumDepth > 256 ||
      input.edges.length > 1_000_000
    )
      throw new ServiceError(
        'DEPENDENCY_PAGE_INPUT_INVALID',
        'Dependency pagination requires bounded edge and depth inventories',
      );
    const byId = new Map(input.edges.map(({ id }, index) => [id, index]));
    if (
      byId.size !== input.edges.length ||
      input.roots.some((id) => !byId.has(id)) ||
      new Set(input.roots).size !== input.roots.length
    )
      throw new ServiceError(
        'DEPENDENCY_PAGE_INPUT_INVALID',
        'Dependency edge and root identities must be unique and all roots must exist',
      );
    this.key = hashCanonical({ algorithm: 'dependency-pages.v1', ...input });
    this.roots = input.roots.map((id) => byId.get(id)!);
    this.branches = new Set(input.branches);
    for (const [index, { from }] of input.edges.entries()) {
      const values = this.outgoing.get(from) ?? [];
      values.push(index);
      this.outgoing.set(from, values);
    }
    if (input.reverseEdges) for (const values of this.outgoing.values()) values.reverse();
    if (restored === undefined)
      this.state = {
        version: 1,
        key: this.key,
        root: 0,
        steps: 0,
        emitted: 0,
        cycles: 0,
        depthStops: 0,
        frames: [],
        visited: [],
      };
    else {
      const parsed = dependencyPageCursorSchema.safeParse(restored);
      if (!parsed.success)
        throw new ServiceError(
          'DEPENDENCY_CURSOR_INVALID',
          'Dependency continuation has an invalid state schema',
        );
      this.state = parsed.data;
    }
    if (this.state.key !== this.key)
      throw new ServiceError(
        'DEPENDENCY_CURSOR_STALE',
        'Dependency continuation does not match the exact source revision and traversal contract',
      );
    this.validate();
    this.visited = new Set(this.state.visited);
  }

  private validate(): void {
    const invalid = (): never => {
      throw new ServiceError(
        'DEPENDENCY_CURSOR_INVALID',
        'Dependency continuation has inconsistent counters or DFS ancestry',
      );
    };
    const { root, frames, visited, steps, emitted, cycles, depthStops } = this.state;
    if (
      root > this.roots.length ||
      frames.length > this.input.maximumDepth ||
      (root === this.roots.length && frames.length !== 0) ||
      emitted > steps ||
      cycles + depthStops > emitted ||
      new Set(visited).size !== visited.length ||
      (frames.length === 0 && visited.length !== 0) ||
      (this.input.visitPolicy === 'edge_path' && visited.length !== 0)
    )
      invalid();
    const nodes = new Set(this.input.edges.map(({ to }) => to));
    if (visited.some((node) => !nodes.has(node))) invalid();
    const ancestors = new Set<string>();
    for (const [index, frame] of frames.entries()) {
      const edge = this.input.edges[frame.edge];
      if (edge === undefined || ancestors.has(edge.to)) invalid();
      ancestors.add(edge!.to);
      if (
        frame.next > (this.outgoing.get(edge!.to)?.length ?? 0) ||
        (!frame.entered && (index !== frames.length - 1 || frame.next !== 0))
      )
        invalid();
      if (index === 0) {
        if (frame.edge !== this.roots[root]) invalid();
      } else {
        const parent = frames[index - 1]!;
        const previous = this.input.edges[parent.edge]!;
        if (
          !parent.entered ||
          parent.next === 0 ||
          this.outgoing.get(previous.to)?.[parent.next - 1] !== frame.edge ||
          previous.to !== edge!.from ||
          !this.branches.has(edge!.to)
        )
          invalid();
      }
      if (this.input.visitPolicy === 'node' && !visited.includes(edge!.to)) invalid();
    }
  }

  cursor(): DependencyPageCursor {
    return {
      ...this.state,
      frames: this.state.frames.map((frame) => ({ ...frame })),
      visited: [...this.visited],
    };
  }

  page(maximumRecords: number, maximumWork: number, signal?: AbortSignal): DependencyPage {
    if (
      !Number.isSafeInteger(maximumRecords) ||
      maximumRecords < 1 ||
      maximumRecords > 5_000 ||
      !Number.isSafeInteger(maximumWork) ||
      maximumWork < 1 ||
      maximumWork > 100_000
    )
      throw new ServiceError(
        'DEPENDENCY_PAGE_BOUND_INVALID',
        'Dependency pages require 1–5,000 records and 1–100,000 work transitions',
      );
    const records: DependencyPageRecord[] = [];
    const startedAt = this.state.steps;
    const emit = (kind: DependencyPageRecord['kind'], extra?: number) => {
      records.push({
        kind,
        root: this.state.root,
        path: [
          ...this.state.frames.map(({ edge }) => edge),
          ...(extra === undefined ? [] : [extra]),
        ],
      });
      this.state.emitted++;
      if (kind === 'cycle') this.state.cycles++;
      if (kind === 'depth') this.state.depthStops++;
    };
    while (this.state.root < this.roots.length && this.state.steps - startedAt < maximumWork) {
      signal?.throwIfAborted();
      if (this.state.steps === Number.MAX_SAFE_INTEGER)
        throw new ServiceError(
          'DEPENDENCY_PAGE_COUNTER_LIMIT',
          'Dependency pagination exhausted its exact integer work counter',
        );
      const frame = this.state.frames.at(-1);
      if (frame === undefined) {
        const edge = this.roots[this.state.root]!;
        this.state.frames.push({ edge, next: 0, entered: false });
        this.visited.clear();
        if (this.input.visitPolicy === 'node') this.visited.add(this.input.edges[edge]!.to);
      } else if (!frame.entered) {
        if (records.length >= maximumRecords) break;
        emit('visit');
        frame.entered = true;
      } else {
        const node = this.input.edges[frame.edge]!.to;
        const candidate = this.outgoing.get(node)?.[frame.next];
        if (candidate === undefined) {
          this.state.frames.pop();
          if (this.state.frames.length === 0) {
            this.state.root++;
            this.visited.clear();
          }
        } else {
          const edge = this.input.edges[candidate]!;
          const cycle = this.state.frames.some(
            (ancestor) => this.input.edges[ancestor.edge]!.to === edge.to,
          );
          const kind = !this.branches.has(edge.to)
            ? 'terminal'
            : cycle
              ? 'cycle'
              : this.state.frames.length >= this.input.maximumDepth
                ? 'depth'
                : undefined;
          if (kind !== undefined) {
            if (records.length >= maximumRecords) break;
            emit(kind, candidate);
            frame.next++;
          } else {
            frame.next++;
            if (this.input.visitPolicy === 'edge_path' || !this.visited.has(edge.to)) {
              if (this.input.visitPolicy === 'node') this.visited.add(edge.to);
              this.state.frames.push({ edge: candidate, next: 0, entered: false });
            }
          }
        }
      }
      this.state.steps++;
    }
    return {
      records,
      finished: this.state.root === this.roots.length,
      completedRoots: this.state.root,
      totalRoots: this.roots.length,
      work: this.state.steps - startedAt,
      cursor: this.cursor(),
    };
  }
}
