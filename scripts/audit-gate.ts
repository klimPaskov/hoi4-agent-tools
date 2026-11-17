/**
 * The full dependency audit with reviewed exceptions.
 *
 * `npm audit --omit=dev --audit-level=high` stays strict for what users install. This gate runs
 * the full audit (development dependencies included) and fails on every high or critical
 * advisory, except one listed in scripts/audit-exceptions.json for that exact package, with a
 * reason, until its review date. It also fails when an exception is past its review date or no
 * longer matches any advisory, so an exception never outlives its reason.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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
  title: z.string().optional(),
});

const auditReportSchema = z.object({
  vulnerabilities: z.record(
    z.string(),
    z.object({ via: z.array(z.union([z.string(), advisorySchema.loose()])) }).loose(),
  ),
});

export interface AuditGateResult {
  failures: string[];
  allowed: string[];
}

function advisoryId(url: string): string {
  return /GHSA(-[0-9a-z]{4}){3}/u.exec(url)?.[0] ?? url;
}

/** Decides the gate from a parsed `npm audit --json` report. `today` is YYYY-MM-DD. */
export function evaluateAudit(
  report: unknown,
  exceptions: AuditExceptions,
  today: string,
): AuditGateResult {
  const parsed = auditReportSchema.parse(report);
  const found = new Map<string, { id: string; name: string; severity: string }>();
  for (const vulnerability of Object.values(parsed.vulnerabilities)) {
    for (const via of vulnerability.via) {
      if (typeof via === 'string') continue;
      if (via.severity !== 'high' && via.severity !== 'critical') continue;
      const id = advisoryId(via.url);
      found.set(`${id}\0${via.name}`, { id, name: via.name, severity: via.severity });
    }
  }
  const failures: string[] = [];
  const allowed: string[] = [];
  const used = new Set<string>();
  for (const advisory of [...found.values()].sort((a, b) =>
    `${a.id} ${a.name}`.localeCompare(`${b.id} ${b.name}`),
  )) {
    const exception = exceptions.exceptions.find(
      (entry) => entry.id === advisory.id && entry.package === advisory.name,
    );
    if (exception === undefined) {
      failures.push(
        `${advisory.severity} ${advisory.id} in ${advisory.name} has no reviewed exception`,
      );
    } else if (today > exception.reviewBy) {
      used.add(`${exception.id}\0${exception.package}`);
      failures.push(
        `${advisory.id} in ${advisory.name}: the exception's review date ${exception.reviewBy} has passed; review it again`,
      );
    } else {
      used.add(`${exception.id}\0${exception.package}`);
      allowed.push(
        `${advisory.id} in ${advisory.name} (reviewed exception until ${exception.reviewBy})`,
      );
    }
  }
  for (const exception of exceptions.exceptions) {
    if (!used.has(`${exception.id}\0${exception.package}`)) {
      failures.push(
        `The exception for ${exception.id} in ${exception.package} matches no advisory any more; remove it`,
      );
    }
  }
  return { failures, allowed };
}

function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const exceptions = auditExceptionsSchema.parse(
    JSON.parse(readFileSync(path.join(here, 'audit-exceptions.json'), 'utf8')),
  );
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) throw new Error('Run this through `npm run audit:gate`');
  // npm audit exits non-zero whenever it finds anything; the report decides, not the exit code.
  const run = spawnSync(process.execPath, [npmCli, 'audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error !== undefined) throw run.error;
  const report: unknown = JSON.parse(run.stdout);
  if (typeof report === 'object' && report !== null && 'error' in report) {
    throw new Error(`npm audit failed: ${JSON.stringify(report.error)}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const result = evaluateAudit(report, exceptions, today);
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
