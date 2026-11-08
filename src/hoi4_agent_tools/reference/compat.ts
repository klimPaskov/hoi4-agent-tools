import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CoreEngine } from '../core/engine.js';
import { compareCodeUnits } from '../core/canonical.js';
import {
  runEngineCheck,
  type EngineCheckFinding,
  type EngineCheckReport,
  type EngineCheckRequest,
} from '../core/engine-check.js';
import type { EngineRunOptions } from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import { canonicalPath, isWithin, type ResolvedWorkspace } from '../core/workspace.js';
import type { CompatModData, CompatCheckRequest } from '../schemas/compat.js';

/**
 * `hoi4.compat_check` mode `mod` (decision R-5): one mod against another, in both load orders.
 * The shared engine's `check` reads every layer in load order; this side runs it twice, with each
 * mod loaded after the other, and keeps the findings that involve both mods. Findings about one
 * mod and the game are not compatibility problems and are left out.
 */

/** The data of a result stays well under the 32 KiB tool result limit, which also holds the envelope. */
export const COMPAT_DATA_BUDGET_BYTES = 24_000;
const MESSAGE_LIMIT = 400;
const REPLACE_FILES_SHOWN = 5;

type ModRef = CompatModData['other'];
type LoadOrder = CompatModData['loadOrders'][number];
type Finding = LoadOrder['dropped']['items'][number];

export type CompatCheckRunner = (
  request: EngineCheckRequest,
  options?: Omit<EngineRunOptions, 'args'>,
) => Promise<EngineCheckReport>;

export function clip(text: string, limit = MESSAGE_LIMIT): string {
  const single = text.replace(/\s+/gu, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}

/** Keep the first `limit` items and count the rest. */
export function bounded<T>(items: readonly T[], limit: number) {
  return {
    count: items.length,
    omitted: Math.max(0, items.length - limit),
    items: items.slice(0, limit),
  };
}

/**
 * Build a result with the largest list limit (at most `limit`) whose JSON stays within the data
 * budget. The counts stay complete; only the listed items shrink.
 */
export function fitToBudget<T>(
  build: (limit: number) => T,
  limit: number,
  budget = COMPAT_DATA_BUDGET_BYTES,
): T {
  let current = limit;
  let data = build(current);
  while (current > 0 && Buffer.byteLength(JSON.stringify(data), 'utf8') > budget) {
    current = current > 4 ? Math.floor(current / 2) : current - 1;
    data = build(current);
  }
  return data;
}

function severityRank(severity: Finding['severity']): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}

function sortFindings(items: Finding[]): Finding[] {
  return items.sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      compareCodeUnits(left.code, right.code) ||
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.subject ?? '', right.subject ?? '') ||
      compareCodeUnits(left.message, right.message),
  );
}

function toFinding(finding: EngineCheckFinding): Finding {
  return {
    code: finding.code,
    severity: finding.severity,
    subject: finding.subject ?? null,
    layer: finding.layer,
    path: finding.path,
    message: clip(finding.message),
  };
}

export interface LoadOrderInput {
  report: EngineCheckReport;
  first: ModRef;
  second: ModRef;
  /** Files the first mod ships directly in each folder the second mod replaces. */
  replacePathFiles: ReadonlyArray<{ folder: string; files: readonly string[] }>;
}

/** The engine's layer names for the pair: the checked mod is the last layer, the other mod just before it. */
export function pairLayerNames(report: EngineCheckReport): { first: string; second: string } {
  const layers = report.inputs.layers;
  const second = layers.at(-1);
  const first = layers.at(-2);
  if (second?.kind !== 'mod' || first?.kind !== 'dependency')
    throw new ServiceError(
      'COMPAT_ENGINE_LAYERS',
      'The engine report does not list the two mods as the last two layers',
    );
  return { first: first.name, second: second.name };
}

/** Everything one load order tells about the pair, from one engine report. */
export function summariseLoadOrder(input: LoadOrderInput, limit: number): LoadOrder {
  const names = pairLayerNames(input.report);
  const firstMarker = ` ${names.first}:`;
  const involvesFirst = (finding: EngineCheckFinding) => finding.message.includes(firstMarker);

  const sameFile = input.report.overrides
    .filter((entry) => entry.replaced.some((replaced) => replaced.startsWith(`${names.first}:`)))
    .map((entry) => ({ path: entry.path, winner: input.second.name }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));

  const duplicates = sortFindings(
    input.report.findings
      .filter(
        (finding) =>
          finding.code === 'LINT_DUPLICATE_ACROSS_LAYERS' &&
          finding.message.includes(`dependency ${names.first} in `),
      )
      .map(toFinding),
  );
  const droppedCodes = new Set([
    'OVERRIDE_DROPS_DEFINITION',
    'OVERRIDE_DROPS_ON_ACTION_HOOK',
    'OVERRIDE_BREAKS_REFERENCE',
    'OVERRIDE_CASE_ONLY_SHADOW',
  ]);
  const dropped = sortFindings(
    input.report.findings
      .filter(
        (finding) =>
          droppedCodes.has(finding.code) &&
          finding.severity !== 'info' &&
          (finding.code === 'OVERRIDE_BREAKS_REFERENCE'
            ? finding.message.includes(firstMarker)
            : involvesFirst(finding)),
      )
      .map(toFinding),
  );
  const replacePathDrops = input.replacePathFiles
    .filter(({ files }) => files.length > 0)
    .map(({ folder, files }) => ({
      folder,
      fileCount: files.length,
      files: files.slice(0, REPLACE_FILES_SHOWN),
    }))
    .sort((left, right) => compareCodeUnits(left.folder, right.folder));
  const droppedFiles = replacePathDrops.reduce((sum, { fileCount }) => sum + fileCount, 0);

  const countSeverity = (items: readonly Finding[], severity: Finding['severity']) =>
    items.filter((item) => item.severity === severity).length;
  return {
    first: input.first,
    second: input.second,
    errors: countSeverity(duplicates, 'error') + countSeverity(dropped, 'error'),
    warnings:
      countSeverity(duplicates, 'warning') + countSeverity(dropped, 'warning') + droppedFiles,
    sameFile: bounded(sameFile, limit),
    duplicateDefinitions: bounded(duplicates, limit),
    dropped: bounded(dropped, limit),
    replacePathDrops: bounded(replacePathDrops, limit),
  };
}

/** The full list of a load order, before any bound, for comparing and counting. */
export interface ComparedOrders {
  orders: [LoadOrder, LoadOrder];
  verdict: CompatModData['verdict'];
  lessLoss: CompatModData['lessLoss'];
  summary: string;
}

export function compareLoadOrders(orders: [LoadOrder, LoadOrder]): ComparedOrders {
  const [a, b] = orders;
  const clashes = orders.some(
    (order) =>
      order.sameFile.count + order.errors + order.warnings + order.replacePathDrops.count > 0,
  );
  const verdict = clashes ? 'conflicts' : 'no_conflicts';
  const difference = a.errors - b.errors || a.warnings - b.warnings;
  const winner = difference === 0 ? undefined : difference < 0 ? a : b;
  const loser = winner === a ? b : a;
  const lessLoss =
    winner === undefined || !clashes
      ? null
      : {
          loadsLast: winner.second,
          errors: winner.errors,
          warnings: winner.warnings,
          otherOrderErrors: loser.errors,
          otherOrderWarnings: loser.warnings,
        };
  const describe = (order: LoadOrder) =>
    `${order.second.name} after ${order.first.name}: ${order.errors} errors, ${order.warnings} warnings, ${order.sameFile.count} files at the same path`;
  const summary =
    verdict === 'no_conflicts'
      ? `No conflicts between ${a.first.name} and ${a.second.name} in either load order.`
      : `Conflicts. ${describe(a)}. ${describe(b)}. ${
          lessLoss === null
            ? 'Both load orders lose the same number of errors and warnings.'
            : `Loading ${lessLoss.loadsLast.name} last loses less (${lessLoss.errors} errors and ${lessLoss.warnings} warnings, against ${lessLoss.otherOrderErrors} and ${lessLoss.otherOrderWarnings}).`
        }`;
  return { orders, verdict, lessLoss, summary: clip(summary, 600) };
}

/** A descriptor's replace_path as a folder below the mod root, or undefined when it is not one. */
function replaceFolder(raw: string): string | undefined {
  const folder = raw.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
  if (folder.length === 0 || folder.includes('\0') || folder.includes(':')) return undefined;
  const segments = folder.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return undefined;
  return folder;
}

/**
 * Files a mod ships directly in the folders another mod replaces. The folders come from a
 * descriptor, so each is checked to stay inside the mod root, and only plain files count.
 */
export async function shippedInFolders(
  root: string,
  folders: readonly string[],
  signal?: AbortSignal,
): Promise<Array<{ folder: string; files: string[] }>> {
  const found: Array<{ folder: string; files: string[] }> = [];
  const seen = new Set<string>();
  for (const raw of folders) {
    signal?.throwIfAborted();
    const folder = replaceFolder(raw);
    if (folder === undefined || seen.has(folder.toLowerCase())) continue;
    seen.add(folder.toLowerCase());
    const directory = path.join(root, ...folder.split('/'));
    let entries;
    try {
      const canonical = await canonicalPath(directory);
      if (!isWithin(root, canonical)) continue;
      entries = await readdir(canonical, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(compareCodeUnits);
    if (files.length > 0) found.push({ folder, files });
  }
  return found;
}

function modRef(workspace: ResolvedWorkspace): ModRef {
  return { id: workspace.id, name: workspace.name };
}

/** Both mods may name a shared dependency; each is loaded once, before the pair. */
function dependenciesFor(checked: ResolvedWorkspace, loadedBefore: ResolvedWorkspace): string[] {
  const own = checked.dependencyRoots.filter(
    (root) => root !== loadedBefore.modRoot && root !== checked.modRoot,
  );
  return [...new Set([...own, loadedBefore.modRoot])];
}

export interface CompatServices {
  runCheck?: CompatCheckRunner;
}

/** Resolve `other` to a mod workspace the principal may read, or refuse. */
export function resolveOtherMod(
  engine: CoreEngine,
  workspace: ResolvedWorkspace,
  other: string,
  principal?: string,
): ResolvedWorkspace {
  const id = engine.resolver.resolveWorkspaceId(other, principal);
  const resolved = engine.resolver.get(id, principal);
  if (resolved.registration.kind !== 'mod')
    throw new ServiceError('COMPAT_OTHER_NOT_A_MOD', 'The other workspace is not a mod');
  if (resolved.id === workspace.id)
    throw new ServiceError('COMPAT_OTHER_IS_SELF', 'The other mod is the mod being checked');
  return resolved;
}

export async function checkModCompatibility(
  engine: CoreEngine,
  workspace: ResolvedWorkspace,
  input: CompatCheckRequest,
  principal?: string,
  signal?: AbortSignal,
  services: CompatServices = {},
): Promise<CompatModData> {
  const started = Date.now();
  const other = resolveOtherMod(engine, workspace, input.other ?? '', principal);
  const runCheck = services.runCheck ?? runEngineCheck;
  const options = signal === undefined ? {} : { signal };
  const request = (checked: ResolvedWorkspace, before: ResolvedWorkspace): EngineCheckRequest => ({
    mod: checked.modRoot,
    ...(workspace.gameRoot === undefined ? {} : { game: workspace.gameRoot }),
    dependencies: dependenciesFor(checked, before),
    includeDlc: workspace.dlcLayers.length > 0,
  });
  // The pair is read in both orders; the engine runs are independent.
  const [otherFirst, workspaceFirst] = await Promise.all([
    runCheck(request(workspace, other), options),
    runCheck(request(other, workspace), options),
  ]);
  const [replaceByWorkspace, replaceByOther] = await Promise.all([
    shippedInFolders(other.modRoot, otherFirst.inputs.layers.at(-1)?.replace_paths ?? [], signal),
    shippedInFolders(
      workspace.modRoot,
      workspaceFirst.inputs.layers.at(-1)?.replace_paths ?? [],
      signal,
    ),
  ]);
  const build = (limit: number): CompatModData => {
    const compared = compareLoadOrders([
      summariseLoadOrder(
        {
          report: otherFirst,
          first: modRef(other),
          second: modRef(workspace),
          replacePathFiles: replaceByWorkspace,
        },
        limit,
      ),
      summariseLoadOrder(
        {
          report: workspaceFirst,
          first: modRef(workspace),
          second: modRef(other),
          replacePathFiles: replaceByOther,
        },
        limit,
      ),
    ]);
    return {
      mode: 'mod',
      workspace: modRef(workspace),
      other: modRef(other),
      verdict: compared.verdict,
      lessLoss: compared.lessLoss,
      summary: compared.summary,
      loadOrders: compared.orders,
      notes: [
        'Only findings that involve both mods are listed. Findings about one mod and the game are left out.',
        'A file at the same path replaces the whole file of the mod that loads first. What it drops is listed under dropped.',
        'Errors and warnings count every duplicate definition, every dropped or broken definition and every file a replace_path unloads, not only the ones listed.',
      ],
      durationMs: Date.now() - started,
    };
  };
  return fitToBudget(build, input.limit);
}
