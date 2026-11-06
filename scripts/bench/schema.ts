import { z } from 'zod/v4';

/**
 * The benchmark's data: corpora, cases with hand-checked ground truth, and stored baselines.
 * Cases are JSON under `bench/cases/`; each one names a corpus, a tool call and what a correct
 * answer contains. A case records the observed truth, not the current behaviour, so a case can
 * fail until the fix it describes lands; the baseline says which cases passed last time.
 */

export const SURFACES = [
  'lookup',
  'source_lookup',
  'mod_index',
  'validation',
  'error_log',
  'event',
  'decision',
  'technology',
  'focus',
  'gui',
  'map',
  'probability',
  'localisation',
  'idea',
  'system',
  'unit',
  'asset',
  'impact',
  'render',
  'rewrite',
] as const;
export type Surface = (typeof SURFACES)[number];

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * One check on a tool result. `path` reads the structured content with dots, `[n]`, `[*]` for
 * every array item and `**` for any depth; `$text`, `$bytes`, `$isError` and `$ms` read the
 * text content, the structured size, the tool-error flag and the wall-clock time.
 */
export const assertionSchema = z
  .object({
    path: z.string().min(1).max(512),
    equals: z.unknown().optional(),
    notEquals: z.unknown().optional(),
    includes: z.unknown().optional(),
    excludes: z.unknown().optional(),
    atLeast: z.number().optional(),
    atMost: z.number().optional(),
    exists: z.boolean().optional(),
    matches: z.string().max(512).optional(),
    /** Read this artifact (by name prefix) instead of the inline result. */
    artifact: z.string().max(256).optional(),
    note: z.string().max(500).optional(),
  })
  .strict()
  .refine(
    (value) =>
      [
        'equals',
        'notEquals',
        'includes',
        'excludes',
        'atLeast',
        'atMost',
        'exists',
        'matches',
      ].filter((key) => key in value).length === 1,
    { message: 'An assertion takes exactly one operator' },
  );
export type Assertion = z.infer<typeof assertionSchema>;

const timingSchema = z.enum(['cold', 'warm', 'any']);

const callCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,127}$/u),
    kind: z.literal('call').default('call'),
    surface: z.enum(SURFACES),
    corpus: z.string().min(1),
    /** The problem number in the 2026-11-01 improvement plan, when the case comes from it. */
    problem: z.number().int().min(1).max(99).optional(),
    title: z.string().min(1).max(300),
    /** How the expected answer was checked by hand. */
    evidence: z.string().min(1).max(2000),
    tool: z.string().regex(/^hoi4\.[a-z_]+$/u),
    arguments: z.record(z.string(), z.unknown()),
    expect: z.array(assertionSchema).min(1).max(32),
    /** `cold` cases run first after the server starts, `warm` ones are repeated for latency. */
    timing: timingSchema.default('any'),
    repeat: z.number().int().min(1).max(50).default(1),
    /** A latency target in milliseconds; reported, and gated only in the local run. */
    budgetMs: z.number().int().positive().optional(),
  })
  .strict();

const sweepCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,127}$/u),
    kind: z.literal('sweep'),
    surface: z.enum(SURFACES),
    corpus: z.string().min(1),
    problem: z.number().int().min(1).max(99).optional(),
    title: z.string().min(1).max(300),
    evidence: z.string().min(1).max(2000),
    tool: z.string().regex(/^hoi4\.[a-z_]+$/u),
    /** Files of the corpus, as `/`-separated globs relative to its root. */
    files: z.array(z.string().min(1).max(256)).min(1).max(32),
    /** Skip files whose relative path matches one of these globs. */
    exclude: z.array(z.string().min(1).max(256)).max(64).default([]),
    /** At most this many files, taken in sorted order spread evenly over the matches. */
    limit: z.number().int().positive().max(20_000).optional(),
    /** Arguments with `{path}` replaced by each file's relative path. */
    arguments: z.record(z.string(), z.unknown()),
    /** Items of the result that count as false positives on a known-good file. */
    falsePositives: z
      .object({
        path: z.string().min(1).max(512),
        where: z.record(z.string(), scalar),
      })
      .strict(),
    /**
     * Real errors in a known-good file, checked by hand: matching items are not false
     * positives. Each names its file, line and code and says why it is a real error.
     */
    knownErrors: z
      .array(
        z
          .object({
            file: z.string().min(1).max(256),
            line: z.number().int().positive(),
            code: z.string().min(1).max(128),
            evidence: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(64)
      .default([]),
  })
  .strict();

export const caseSchema = z.union([sweepCaseSchema, callCaseSchema]);
export type BenchCase = z.infer<typeof caseSchema>;
export type CallCase = z.infer<typeof callCaseSchema>;
export type SweepCase = z.infer<typeof sweepCaseSchema>;

export const caseFileSchema = z
  .object({
    $schema: z.string().optional(),
    about: z.string().max(2000).optional(),
    cases: z.array(caseSchema).min(1),
  })
  .strict();

export const corpusSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    name: z.string().min(1).max(200),
    /**
     * `synthetic`: the project's own fixtures, built in a temporary folder.
     * `game`: the installed game through an empty mod. `mod`: a folder under the mod root.
     * `workshop`: a Steam Workshop item of HOI4 (app 394360).
     */
    kind: z.enum(['synthetic', 'game', 'mod', 'workshop']),
    folder: z.string().min(1).max(256).optional(),
    workshopId: z
      .string()
      .regex(/^[0-9]{6,12}$/u)
      .optional(),
    /** The version the benchmark was pinned at; a different installed version is a corpus change. */
    version: z.string().max(64).optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();
export type Corpus = z.infer<typeof corpusSchema>;

export const corpusFileSchema = z
  .object({ about: z.string().max(2000).optional(), corpora: z.array(corpusSchema).min(1) })
  .strict();

/** What a stored baseline keeps of each case: no timings, which differ between machines. */
export const machineSchema = z
  .object({
    platform: z.string(),
    cpu: z.string(),
    cores: z.number().int().min(1),
    memoryGb: z.number().int().min(0),
    node: z.string(),
    /** SHA-256 of the hoi4-engine binary HOI4_ENGINE names, when one is set. */
    engineSha256: z.string().optional(),
  })
  .strict();
export type Machine = z.infer<typeof machineSchema>;

export const baselineSchema = z
  .object({
    suite: z.string(),
    cases: z.record(
      z.string(),
      z
        .object({
          passed: z.boolean(),
          inline: z.boolean(),
          falsePositives: z.number().int().min(0).optional(),
          files: z.number().int().min(0).optional(),
        })
        .strict(),
    ),
    corpora: z.record(z.string(), z.string()).default({}),
    /** Warm p95 per case in the local run; absent from the committed CI baseline. */
    latency: z.record(z.string(), z.number()).optional(),
    /** The machine the local run measured latency on. */
    machine: machineSchema.optional(),
  })
  .strict();
export type Baseline = z.infer<typeof baselineSchema>;
