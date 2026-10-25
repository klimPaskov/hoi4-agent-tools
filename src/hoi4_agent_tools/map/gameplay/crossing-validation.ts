/**
 * Validators for crossings, walls and positions that run on the files of any map (ADR 0062,
 * 0063): the rules `adjacency_rules.txt` defines against the rows that use them, `impassable` rows
 * between provinces that touch, `sea` crossings narrow enough to be a strait, railways that cross
 * a wall, and unit positions for every province. The findings that need the geography model
 * (a pass that is not a gap, a wall with an undeclared gap, an unnamed feature) are raised when
 * a world is generated, with their own codes.
 *
 * Thresholds come from the installed game, which must raise no finding: its widest crossing is 30
 * pixels, its 93 impassable rows all join touching land provinces, and every province has unit
 * positions.
 */
import type { Diagnostic } from '../../core/diagnostics.js';
import type { ScannedFile } from '../../core/scanner.js';
import { assignments, firstScalar, parseClausewitz } from '../../core/source/index.js';
import { defaultMapSelectorValue, type MapWorkspaceIndex } from '../model.js';
import { closestApproach, type ProvinceRasterView } from './facts.js';

export type CrossingReport = (diagnostic: Omit<Diagnostic, 'category'>) => void;
type Steps = Generator<void, void, void>;

/** Widest land-to-land crossing the validator accepts as a strait (the base game's is 30). */
export const STRAIT_VALIDATOR_LIMIT_PX = 48;
/** Total adjacency rows above which a map is reported as unusually dense with barriers. */
export const ADJACENCY_ROW_LIMIT = 2_000;
const ANALYSED_ROWS = 400;

export interface AdjacencyRuleRecord {
  name: string;
  required: number[];
  icon?: number;
}

function normalized(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

function rulesFile(index: MapWorkspaceIndex): ScannedFile | undefined {
  let name = 'adjacency_rules.txt';
  try {
    name = defaultMapSelectorValue(index.defaultMapFile, 'adjacency_rules', name);
  } catch {
    // An untrustworthy selector is reported elsewhere; the default name is still worth checking.
  }
  for (const root of index.sourceRoots.map) {
    const found = index.activeFiles.byRelativePath.get(normalized(`${root}/${name}`));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The rules a file defines; `duplicates` lists names defined more than once. */
export function parseAdjacencyRules(file: ScannedFile): {
  rules: AdjacencyRuleRecord[];
  duplicates: string[];
} {
  const document = parseClausewitz(file.bytes, file.displayPath);
  const rules: AdjacencyRuleRecord[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const entry of assignments(document.root, 'adjacency_rule')) {
    if (entry.value.type !== 'block') continue;
    const name = firstScalar(entry.value, 'name')?.value ?? '';
    const required: number[] = [];
    const list = assignments(entry.value, 'required_provinces')[0]?.value;
    if (list?.type === 'block')
      for (const item of list.entries)
        if (item.type === 'scalar' && /^\d+$/u.test(item.value)) required.push(Number(item.value));
    const icon = firstScalar(entry.value, 'icon')?.value;
    rules.push({
      name,
      required,
      ...(icon !== undefined && /^\d+$/u.test(icon) ? { icon: Number(icon) } : {}),
    });
    if (name !== '') {
      if (seen.has(name)) duplicates.push(name);
      seen.add(name);
    }
  }
  return { rules, duplicates };
}

function bounded<T>(items: readonly T[], limit = 8): T[] {
  return items.slice(0, limit);
}

function* checkRules(index: MapWorkspaceIndex, report: CrossingReport): Steps {
  const file = rulesFile(index);
  if (file === undefined) return;
  const { rules, duplicates } = parseAdjacencyRules(file);
  yield;
  const location = {
    path: file.displayPath,
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 },
  };
  for (const name of bounded(duplicates))
    report({
      code: 'MAP_ADJACENCY_RULE_DUPLICATE',
      severity: 'error',
      message: `Adjacency rule ${name} is defined more than once`,
      location,
      details: { rule: name },
    });
  const defined = new Map(rules.map((rule) => [rule.name, rule]));
  for (const rule of rules) {
    const problems: string[] = [];
    if (rule.name === '') problems.push('has no name');
    if (rule.required.length < 2) problems.push('lists fewer than two required_provinces');
    const unknown = rule.required.filter((id) => !index.definitionsById.has(id));
    if (unknown.length > 0)
      problems.push(`names unknown province(s) ${bounded(unknown).join(', ')}`);
    if (rule.icon !== undefined && !index.definitionsById.has(rule.icon))
      problems.push(`has an icon on unknown province ${rule.icon}`);
    if (problems.length > 0)
      report({
        code: 'MAP_ADJACENCY_RULE_INVALID',
        severity: 'error',
        message: `Adjacency rule ${rule.name === '' ? '(unnamed)' : rule.name} ${problems.join(' and ')}`,
        location,
        details: { rule: rule.name, problems },
      });
  }
  yield;
  const used = new Set<string>();
  for (const row of index.adjacencies) {
    if (row.rule === '') continue;
    used.add(row.rule);
    if (!defined.has(row.rule))
      report({
        code: 'MAP_ADJACENCY_RULE_MISSING',
        severity: 'error',
        message: `Adjacency ${row.from}-${row.to} uses rule ${row.rule}, which adjacency_rules.txt does not define`,
        location,
        details: { rule: row.rule, from: row.from, to: row.to },
      });
  }
  const unused = rules.filter((rule) => rule.name !== '' && !used.has(rule.name));
  if (unused.length > 0)
    report({
      code: 'MAP_ADJACENCY_RULE_UNUSED',
      severity: 'info',
      message: `${unused.length} adjacency rule(s) are defined but no adjacency row uses them`,
      location,
      details: { rules: bounded(unused.map((rule) => rule.name)) },
    });
}

/** Pixels of one province, from its bounding box. */
function pixelsOf(index: MapWorkspaceIndex, id: number): number[] {
  const raster = index.raster;
  const geometry = raster?.geometry.get(id);
  if (raster === undefined || geometry === undefined) return [];
  const out: number[] = [];
  const stride = Math.max(1, Math.ceil(Math.sqrt(geometry.pixelCount / 4_000)));
  for (let y = geometry.minY; y <= geometry.maxY; y += 1)
    for (let x = geometry.minX; x <= geometry.maxX; x += 1)
      if ((x + y) % stride === 0 && raster.provinceIds[y * raster.width + x] === id)
        out.push(y * raster.width + x);
  return out;
}

function* checkRows(index: MapWorkspaceIndex, report: CrossingReport): Steps {
  const raster = index.raster;
  if (raster === undefined) return;
  const impassable = index.adjacencies.filter(({ type }) => type === 'impassable');
  const isolated: string[] = [];
  const nonLand: string[] = [];
  for (const row of impassable) {
    const from = index.definitionsById.get(row.from);
    const to = index.definitionsById.get(row.to);
    if (from === undefined || to === undefined) continue;
    if (!(raster.adjacency.get(row.from)?.has(row.to) ?? false))
      isolated.push(`${row.from}-${row.to}`);
    if (from.type !== 'land' || to.type !== 'land') nonLand.push(`${row.from}-${row.to}`);
  }
  yield;
  // The base game has one such row among 93, so a stray row is information and a pattern a warning.
  if (isolated.length > 0)
    report({
      code: 'MAP_IMPASSABLE_NOT_ADJACENT',
      severity:
        isolated.length >= 3 && isolated.length > impassable.length * 0.05 ? 'warning' : 'info',
      message: `${isolated.length} impassable row(s) join provinces that do not touch, so they block nothing`,
      details: { rows: bounded(isolated), count: isolated.length },
    });
  if (nonLand.length > 0)
    report({
      code: 'MAP_IMPASSABLE_NOT_LAND',
      severity: 'warning',
      message: `${nonLand.length} impassable row(s) join a province that is not land; walls separate land provinces`,
      details: { rows: bounded(nonLand), count: nonLand.length },
    });
  if (index.adjacencies.length > ADJACENCY_ROW_LIMIT)
    report({
      code: 'MAP_ADJACENCY_ROW_LIMIT',
      severity: 'warning',
      message: `adjacencies.csv has ${index.adjacencies.length} rows; the base game has 244. Large walls slow the load and the AI; consider fewer or larger provinces along the wall`,
      details: { rows: index.adjacencies.length, limit: ADJACENCY_ROW_LIMIT },
    });
  // Land-to-land sea crossings narrow enough to be a strait.
  const wide: string[] = [];
  let analysed = 0;
  const view: ProvinceRasterView = {
    width: raster.width,
    height: raster.height,
    pixel: raster.provinceIds,
    count: 0,
  };
  for (const row of index.adjacencies) {
    if (row.type !== 'sea' || analysed >= ANALYSED_ROWS) continue;
    const from = index.definitionsById.get(row.from);
    const to = index.definitionsById.get(row.to);
    if (from?.type !== 'land' || to?.type !== 'land') continue;
    if (raster.adjacency.get(row.from)?.has(row.to) ?? false) continue;
    analysed += 1;
    const approach = closestApproach(
      pixelsOf(index, row.from),
      pixelsOf(index, row.to),
      view.width,
      200,
    );
    if (approach !== undefined && approach.gap > STRAIT_VALIDATOR_LIMIT_PX)
      wide.push(`${row.from}-${row.to} (${Math.round(approach.gap)} px)`);
    if (analysed % 16 === 0) yield;
  }
  if (wide.length > 0)
    report({
      code: 'MAP_STRAIT_NOT_NARROW',
      severity: 'warning',
      message: `${wide.length} land crossing(s) span more than ${STRAIT_VALIDATOR_LIMIT_PX} pixels between their provinces (the base game's widest is 30): ${bounded(wide, 4).join(', ')}`,
      details: { crossings: bounded(wide), count: wide.length, limitPx: STRAIT_VALIDATOR_LIMIT_PX },
    });
}

function* checkRailways(index: MapWorkspaceIndex, report: CrossingReport): Steps {
  if (index.railways.length === 0) return;
  const blocked = new Set<string>();
  for (const row of index.adjacencies)
    if (row.type === 'impassable') {
      blocked.add(`${row.from}:${row.to}`);
      blocked.add(`${row.to}:${row.from}`);
    }
  if (blocked.size === 0) return;
  const crossing: string[] = [];
  for (const railway of index.railways) {
    for (let step = 1; step < railway.provinces.length; step += 1) {
      const from = railway.provinces[step - 1]!;
      const to = railway.provinces[step]!;
      if (blocked.has(`${from}:${to}`)) crossing.push(`${from}-${to}`);
    }
  }
  yield;
  if (crossing.length > 0)
    report({
      code: 'MAP_RAILWAY_CROSSES_IMPASSABLE',
      severity: 'warning',
      message: `${crossing.length} railway step(s) run between provinces separated by an impassable row; a railway cannot cross a wall except at a gate`,
      details: { steps: bounded(crossing), count: crossing.length },
    });
}

function* checkUnitPositions(index: MapWorkspaceIndex, report: CrossingReport): Steps {
  if (index.unitPositions.length === 0 || index.raster === undefined) return;
  const covered = new Set(index.unitPositions.map(({ provinceId }) => provinceId));
  const missing: number[] = [];
  for (const definition of index.definitions)
    if (
      definition.id > 0 &&
      index.raster.geometry.has(definition.id) &&
      definition.type !== 'lake' &&
      !covered.has(definition.id)
    )
      missing.push(definition.id);
  yield;
  // The base game lacks positions for 7 of 13,000 provinces: a few are information, many a warning.
  if (missing.length > 0)
    report({
      code: 'MAP_UNIT_POSITION_MISSING',
      severity: missing.length > Math.max(3, index.definitions.length * 0.01) ? 'warning' : 'info',
      message: `${missing.length} province(s) have no unit-stack positions, so units there have no place to stand`,
      details: { provinces: bounded(missing, 12), count: missing.length },
    });
}

/** Run the crossing, wall, railway and position checks; findings go to `report`. */
export function* validateCrossings(index: MapWorkspaceIndex, report: CrossingReport): Steps {
  yield* checkRules(index, report);
  yield* checkRows(index, report);
  yield* checkRailways(index, report);
  yield* checkUnitPositions(index, report);
}
