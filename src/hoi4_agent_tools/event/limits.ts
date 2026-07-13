import { ServiceError } from '../core/result.js';

export const EVENT_GRAPH_MAX_NODES = 100_000;
export const EVENT_GRAPH_MAX_EDGES = 250_000;
export const EVENT_GRAPH_MAX_STATE_ACCESSES = 250_000;
export const EVENT_GRAPH_MAX_STATE_LINKS = 250_000;
export const EVENT_GRAPH_MAX_STATE_LINK_CANDIDATES = 500_000;
export const EVENT_GRAPH_MAX_ISSUES = 20_000;
export const EVENT_GRAPH_MAX_UNRESOLVED = 50_000;
export const EVENT_GRAPH_MAX_HELPER_DEPTH = 64;
export const EVENT_GRAPH_MAX_HELPER_PROJECTIONS = 200_000;
export const EVENT_GRAPH_MAX_HELPER_STATE_PROJECTIONS = 50_000;
export const EVENT_GRAPH_MAX_CONDITION_TEXT = 16_384;
export const EVENT_GRAPH_WORK_LIMIT = 5_000_000;
export const EVENT_FRAGMENT_CACHE_MAX_ENTRIES = 10_000;
export const EVENT_FRAGMENT_CACHE_MAX_SOURCE_BYTES = 134_217_728;
export const EVENT_PROPOSED_SOURCE_MAX_FILES = 64;
export const EVENT_PROPOSED_SOURCE_MAX_BYTES = 67_108_864;

/** One cooperative, deterministic work ceiling shared by extraction and graph construction. */
export class EventAnalysisBudget {
  #spent = 0;

  public constructor(
    private readonly signal?: AbortSignal,
    private readonly maximum = EVENT_GRAPH_WORK_LIMIT,
  ) {}

  public spend(label: string, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new ServiceError('EVENT_ANALYSIS_BUDGET_INVALID', 'Event work amount is invalid');
    }
    this.#spent += amount;
    if ((this.#spent & 0xff) === 0) this.signal?.throwIfAborted();
    if (this.#spent > this.maximum) {
      throw new ServiceError(
        'EVENT_ANALYSIS_WORK_BLOCKED',
        'Event-chain analysis exceeds the fixed work ceiling',
        { label, spent: this.#spent, maximum: this.maximum },
      );
    }
  }

  public check(): void {
    this.signal?.throwIfAborted();
  }
}
