/**
 * The full dependency audit with reviewed exceptions (ADR 0088).
 *
 * `npm audit --omit=dev --audit-level=high` stays strict for what users install. This gate runs
 * the full audit (development dependencies included) and fails on every high or critical
 * advisory, except one listed in scripts/audit-exceptions.json for that exact package, with a
 * reason, until its review date. An exception never covers an advisory that also reaches the
 * production dependencies, and it stops counting once the package publishes a version outside
 * the advisory's vulnerable range. The gate also fails when an exception is past its review date
 * or no longer matches any advisory, so an exception never outlives its reason.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** The part of semver (a dev dependency without bundled types) the gate uses. */
interface Semver {
  valid(version: string): string | null;
  prerelease(version: string): readonly (string | number)[] | null;
  satisfies(version: string, range: string): boolean;
  rcompare(a: string, b: string): number;
}

const semver = createRequire(import.meta.url)('semver') as Semver;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const auditExceptionsSchema = z
  .object({
    exceptions: z.array(
      z
        .object({
          id: z.string().regex(/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/u),
          package: z.string().min(1),
          reason: z.string().min(20),
          approved: dateSchema,
          reviewBy: dateSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type AuditExceptions = z.infer<typeof auditExceptionsSchema>;

const advisorySchema = z.object({
  name: z.string(),
  severity: z.string(),
  url: z.string(),
  range: z.string(),
});

const auditReportSchema = z.object({
  vulnerabilities: z.record(
    z.string(),
    z.object({ via: z.array(z.union([z.string(), advisorySchema.loose()])) }).loose(),
  ),
});

/** What the gate reads besides the exception list. */
export interface AuditInputs {
  /** `npm audit --json`: every dependency. */
  full: unknown;
  /** `npm audit --omit=dev --json`: what users install. */
  production: unknown;
  /** Published versions of each excepted package, from the registry. */
  publishedVersions: ReadonlyMap<string, readonly string[]>;
  /** YYYY-MM-DD. */
  today: string;
}

export interface AuditGateResult {
  failures: string[];
  allowed: string[];
}

interface Advisory {
  id: string;
  name: string;
  severity: string;
  range: string;
}

function advisoryId(url: string): string {
  return /GHSA(-[0-9a-z]{4}){3}/u.exec(url)?.[0] ?? url;
}

function keyOf(id: string, name: string): string {
  return `${id}\0${name}`;
}

/** Every advisory in a report, high and critical only unless `all`. */
function advisories(report: unknown, all: boolean): Map<string, Advisory> {
  const parsed = auditReportSchema.parse(report);
  const found = new Map<string, Advisory>();
  for (const vulnerability of Object.values(parsed.vulnerabilities)) {
    for (const via of vulnerability.via) {
      if (typeof via === 'string') continue;
      if (!all && via.severity !== 'high' && via.severity !== 'critical') continue;
      const id = advisoryId(via.url);
      found.set(keyOf(id, via.name), {
        id,
        name: via.name,
        severity: via.severity,
        range: via.range,
      });
    }
  }
  return found;
}

/** The newest published stable version outside the vulnerable range, if any. */
export function fixedVersion(range: string, published: readonly string[]): string | undefined {
  const fixed = published
    .filter((version) => semver.valid(version) !== null && semver.prerelease(version) === null)
    .filter((version) => !semver.satisfies(version, range))
    .sort((a, b) => semver.rcompare(a, b));
  return fixed[0];
}

/** Decides the gate. Pure: the caller runs npm. */
export function evaluateAudit(inputs: AuditInputs, exceptions: AuditExceptions): AuditGateResult {
  const found = advisories(inputs.full, false);
  const production = advisories(inputs.production, true);
  const failures: string[] = [];
  const allowed: string[] = [];
  const used = new Set<string>();
  const sorted = [...found.values()].sort((a, b) =>
    `${a.id} ${a.name}`.localeCompare(`${b.id} ${b.name}`),
  );
  for (const advisory of sorted) {
    const key = keyOf(advisory.id, advisory.name);
    const exception = exceptions.exceptions.find((entry) => keyOf(entry.id, entry.package) === key);
    if (exception === undefined) {
      failures.push(
        `${advisory.severity} ${advisory.id} in ${advisory.name} has no reviewed exception`,
      );
      continue;
    }
    used.add(key);
    if (production.has(key)) {
      failures.push(
        `${advisory.id} in ${advisory.name} reaches the production dependencies; an exception never covers those`,
      );
      continue;
    }
    if (inputs.today > exception.reviewBy) {
      failures.push(
        `${advisory.id} in ${advisory.name}: the exception's review date ${exception.reviewBy} has passed; review it again`,
      );
      continue;
    }
    const published = inputs.publishedVersions.get(advisory.name);
    if (published === undefined || published.length === 0) {
      failures.push(
        `${advisory.id} in ${advisory.name}: the published versions could not be read, so a fix cannot be ruled out`,
      );
      continue;
    }
    const fixed = fixedVersion(advisory.range, published);
    if (fixed !== undefined) {
      failures.push(
        `${advisory.id} in ${advisory.name}: ${advisory.name}@${fixed} is outside the vulnerable range ${advisory.range}; update the dependency and remove the exception`,
      );
      continue;
    }
    allowed.push(
      `${advisory.id} in ${advisory.name} (${advisory.range}, no fixed version; reviewed exception until ${exception.reviewBy})`,
    );
  }
  for (const exception of exceptions.exceptions) {
    if (!used.has(keyOf(exception.id, exception.package))) {
      failures.push(
        `The exception for ${exception.id} in ${exception.package} matches no advisory any more; remove it`,
      );
    }
  }
  return { failures, allowed };
}

function npm(npmCli: string, args: readonly string[]): string {
  // npm audit exits non-zero whenever it finds anything; the report decides, not the exit code.
  const run = spawnSync(process.execPath, [npmCli, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error !== undefined) throw run.error;
  return run.stdout;
}

function auditJson(npmCli: string, args: readonly string[]): unknown {
  const report: unknown = JSON.parse(npm(npmCli, ['audit', '--json', ...args]));
  if (typeof report === 'object' && report !== null && 'error' in report) {
    throw new Error(`npm audit failed: ${JSON.stringify(report.error)}`);
  }
  return report;
}

function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const exceptions = auditExceptionsSchema.parse(
    JSON.parse(readFileSync(path.join(here, 'audit-exceptions.json'), 'utf8')),
  );
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) throw new Error('Run this through `npm run audit:gate`');
  const publishedVersions = new Map<string, string[]>();
  for (const name of new Set(exceptions.exceptions.map((entry) => entry.package))) {
    const versions: unknown = JSON.parse(npm(npmCli, ['view', name, 'versions', '--json']));
    publishedVersions.set(
      name,
      z.union([z.array(z.string()), z.string().transform((one) => [one])]).parse(versions),
    );
  }
  const result = evaluateAudit(
    {
      full: auditJson(npmCli, []),
      production: auditJson(npmCli, ['--omit=dev']),
      publishedVersions,
      today: new Date().toISOString().slice(0, 10),
    },
    exceptions,
  );
  for (const line of result.allowed) console.log(`allowed: ${line}`);
  for (const line of result.failures) console.error(`audit: ${line}`);
  if (result.failures.length > 0) process.exit(1);
  console.log('audit gate: no high or critical advisory without a reviewed exception');
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
