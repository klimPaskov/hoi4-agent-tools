/**
 * Map data derived from geometry rather than written by hand: building, unit and weather model
 * positions, and the supply-node and railway network. The same planners serve the repair
 * operations of an existing map and the generation of a new one; they return complete file
 * contents and never touch source themselves.
 */
import { compareCodeUnits } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  derivedStateCapital,
  LEVEL_STATE_BUILDINGS,
  type MapWorkspaceIndex,
  type ProvinceRaster,
  type StateRecord,
  type TextFileDocument,
} from './model.js';

export interface DerivedFile {
  relativePath: string;
  content: Buffer;
}

interface PositionsRequest {
  positions?: ReadonlyArray<'buildings' | 'units' | 'weather'>;
  stateIds?: readonly number[];
  provinceIds?: readonly number[];
  regionIds?: readonly number[];
  mode?: 'missing' | 'replace';
}

interface SupplyRequest {
  stateIds?: readonly number[];
  mode?: 'connect' | 'replace';
  railwayLevel?: number;
  capitalRailwayLevel?: number;
}

const TWO_PI = Math.PI * 2;

function fixed(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/** A deterministic value in [0, 1) from integers, so repeated runs place models identically. */
function unitHash(...values: number[]): number {
  let hash = 2166136261;
  for (const value of values) {
    hash ^= value & 0xffffffff;
    hash = Math.imul(hash, 16777619) >>> 0;
    hash ^= hash >>> 13;
  }
  return (hash >>> 0) / 4294967296;
}

function mapRoot(index: MapWorkspaceIndex): string {
  return index.sourceRoots.map[0] ?? 'map';
}

function requireRaster(index: MapWorkspaceIndex): ProvinceRaster {
  if (index.raster === undefined)
    throw new ServiceError(
      'MAP_PROVINCE_BITMAP_REQUIRED',
      'Generated positions and supply need a readable province bitmap',
    );
  return index.raster;
}

/** Pixels of one province with each pixel's 4-step distance to the province border. */
interface ProvinceShape {
  id: number;
  xs: Int32Array;
  ys: Int32Array;
  depth: Int32Array;
  deepest: number;
}

function provinceShape(raster: ProvinceRaster, id: number): ProvinceShape | undefined {
  const geometry = raster.geometry.get(id);
  if (geometry === undefined || geometry.pixelCount === 0) return undefined;
  const width = geometry.maxX - geometry.minX + 1;
  const height = geometry.maxY - geometry.minY + 1;
  const local = new Int32Array(width * height).fill(-1);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = geometry.minY; y <= geometry.maxY; y += 1)
    for (let x = geometry.minX; x <= geometry.maxX; x += 1)
      if (raster.provinceIds[y * raster.width + x] === id) {
        local[(y - geometry.minY) * width + (x - geometry.minX)] = xs.length;
        xs.push(x);
        ys.push(y);
      }
  const count = xs.length;
  const depth = new Int32Array(count).fill(-1);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  const neighbor = (pixel: number, dx: number, dy: number): number => {
    const x = xs[pixel]! + dx - geometry.minX;
    const y = ys[pixel]! + dy - geometry.minY;
    if (x < 0 || y < 0 || x >= width || y >= height) return -1;
    return local[y * width + x]!;
  };
  for (let pixel = 0; pixel < count; pixel += 1) {
    if (
      neighbor(pixel, 1, 0) < 0 ||
      neighbor(pixel, -1, 0) < 0 ||
      neighbor(pixel, 0, 1) < 0 ||
      neighbor(pixel, 0, -1) < 0
    ) {
      depth[pixel] = 0;
      queue[tail++] = pixel;
    }
  }
  while (head < tail) {
    const pixel = queue[head++]!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const next = neighbor(pixel, dx, dy);
      if (next >= 0 && depth[next] === -1) {
        depth[next] = depth[pixel]! + 1;
        queue[tail++] = next;
      }
    }
  }
  let deepest = 0;
  for (let pixel = 1; pixel < count; pixel += 1)
    if (depth[pixel]! > depth[deepest]!) deepest = pixel;
  return { id, xs: Int32Array.from(xs), ys: Int32Array.from(ys), depth, deepest };
}

/**
 * Spread points inside a province: the deepest pixel first, then pixels far from the points
 * already chosen while staying away from the border.
 */
function spreadPoints(shape: ProvinceShape, count: number): Array<{ x: number; y: number }> {
  const total = shape.xs.length;
  const stride = Math.max(1, Math.floor(total / 4000));
  const candidates: number[] = [];
  const minimumDepth = Math.min(2, shape.depth[shape.deepest]!);
  for (let pixel = 0; pixel < total; pixel += stride)
    if (shape.depth[pixel]! >= minimumDepth) candidates.push(pixel);
  if (candidates.length === 0) candidates.push(shape.deepest);
  const chosen: number[] = [shape.deepest];
  while (chosen.length < count) {
    let best = -1;
    let bestScore = -1;
    for (const candidate of candidates) {
      let nearest = Number.POSITIVE_INFINITY;
      for (const point of chosen) {
        const dx = shape.xs[candidate]! - shape.xs[point]!;
        const dy = shape.ys[candidate]! - shape.ys[point]!;
        nearest = Math.min(nearest, dx * dx + dy * dy);
      }
      const score = Math.min(Math.sqrt(nearest), 2 + shape.depth[candidate]! * 3);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    chosen.push(best < 0 ? shape.deepest : best);
  }
  return chosen.map((pixel) => ({ x: shape.xs[pixel]!, y: shape.ys[pixel]! }));
}

/** A coastal pixel of a land province facing the sea province it borders most. */
function coastPoint(
  raster: ProvinceRaster,
  shape: ProvinceShape,
  isSea: (id: number) => boolean,
): { x: number; y: number; dx: number; dy: number; sea: number } | undefined {
  const contacts = new Map<number, Array<{ x: number; y: number; dx: number; dy: number }>>();
  for (let pixel = 0; pixel < shape.xs.length; pixel += 1) {
    if (shape.depth[pixel] !== 0) continue;
    const x = shape.xs[pixel]!;
    const y = shape.ys[pixel]!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= raster.width || ny >= raster.height) continue;
      const other = raster.provinceIds[ny * raster.width + nx]!;
      if (other < 0 || !isSea(other)) continue;
      const list = contacts.get(other) ?? [];
      list.push({ x, y, dx, dy });
      contacts.set(other, list);
    }
  }
  const [sea, points] =
    [...contacts].sort(
      ([leftId, left], [rightId, right]) => right.length - left.length || leftId - rightId,
    )[0] ?? [];
  if (sea === undefined || points === undefined) return undefined;
  const middle = points[Math.floor(points.length / 2)]!;
  return { ...middle, sea };
}

function rotationFor(dx: number, dy: number): number {
  // Bitmap y grows downward; map z grows upward.
  return Math.atan2(-dy, dx);
}

interface BuildingSlot {
  name: string;
  perProvince: boolean;
  count: number;
  coastal: boolean;
}

/** Which building models each state and province needs, from definitions or base-game defaults. */
function buildingSlots(index: MapWorkspaceIndex): BuildingSlot[] {
  const slots: BuildingSlot[] = [];
  if (index.buildingDefinitions.size > 0) {
    for (const definition of index.buildingDefinitions.values()) {
      if (definition.spawnPoint !== undefined || definition.showOnMap <= 0) continue;
      slots.push({
        name: definition.name,
        perProvince: definition.provincial,
        count: definition.showOnMap,
        coastal: definition.onlyCoastal,
      });
    }
    for (const point of index.buildingSpawnPoints.values())
      if (point.autoNudged)
        slots.push({
          name: point.name,
          perProvince: point.provincial,
          count: point.max,
          coastal: point.onlyCoastal,
        });
  } else {
    for (const [name, count] of [
      ['arms_factory', 6],
      ['industrial_complex', 6],
      ['air_base', 1],
      ['anti_air_building', 3],
      ['synthetic_refinery', 1],
      ['fuel_silo', 1],
      ['radar_station', 1],
      ['nuclear_reactor_spawn', 1],
      ['rocket_site_spawn', 1],
    ] as const)
      slots.push({ name, perProvince: false, count, coastal: false });
    slots.push({ name: 'dockyard', perProvince: false, count: 1, coastal: true });
    for (const name of ['bunker', 'supply_node', 'special_project_facility_spawn'])
      slots.push({ name, perProvince: true, count: 1, coastal: false });
    for (const name of [
      'coastal_bunker',
      'naval_base_spawn',
      'naval_headquarters',
      'naval_supply_hub',
    ])
      slots.push({ name, perProvince: true, count: 1, coastal: true });
  }
  // Floating harbours are placed like buildings although no definition declares them.
  slots.push({ name: 'floating_harbor', perProvince: true, count: 1, coastal: true });
  return slots.sort((left, right) => compareCodeUnits(left.name, right.name));
}

/** Rewrite a delimited data file: keep unselected lines, drop replaced ones, append new ones. */
function rewriteLines(
  document: TextFileDocument | undefined,
  drop: ReadonlySet<number>,
  added: readonly string[],
): Buffer {
  const newline = document?.newline ?? '\n';
  const kept =
    document === undefined
      ? []
      : document.lines
          .filter((line) => !drop.has(line.index + 1))
          .map((line) => line.text)
          .filter((text, position, all) => !(position === all.length - 1 && text === ''));
  return Buffer.from(`${[...kept, ...added].join(newline)}${newline}`, 'utf8');
}

function selectedStates(index: MapWorkspaceIndex, request: PositionsRequest): StateRecord[] {
  const explicit =
    request.stateIds !== undefined ||
    request.provinceIds !== undefined ||
    request.regionIds !== undefined;
  if (!explicit) return index.states;
  const ids = new Set(request.stateIds ?? []);
  for (const provinceId of request.provinceIds ?? [])
    for (const state of index.statesByProvince.get(provinceId) ?? []) ids.add(state.id);
  return index.states.filter(({ id }) => ids.has(id));
}

function selectedProvinces(index: MapWorkspaceIndex, request: PositionsRequest): number[] {
  const explicit =
    request.stateIds !== undefined ||
    request.provinceIds !== undefined ||
    request.regionIds !== undefined;
  const ids = new Set<number>();
  if (!explicit) {
    for (const definition of index.definitions) if (definition.id > 0) ids.add(definition.id);
  } else {
    for (const id of request.provinceIds ?? []) ids.add(id);
    for (const stateId of request.stateIds ?? [])
      for (const id of index.statesById.get(stateId)?.provinces ?? []) ids.add(id);
    for (const regionId of request.regionIds ?? [])
      for (const id of index.regionsById.get(regionId)?.provinces ?? []) ids.add(id);
  }
  return [...ids].filter((id) => index.raster?.geometry.has(id) === true).sort((a, b) => a - b);
}

function isSeaProvince(index: MapWorkspaceIndex, id: number): boolean {
  return index.definitionsById.get(id)?.type === 'sea';
}

function planBuildingPositions(index: MapWorkspaceIndex, request: PositionsRequest): DerivedFile {
  const raster = requireRaster(index);
  const replace = request.mode === 'replace';
  const states = selectedStates(index, request);
  const stateIds = new Set(states.map(({ id }) => id));
  const existing = new Map<string, number>();
  for (const record of index.buildingPositions)
    existing.set(
      `${record.stateId};${record.building}`,
      (existing.get(`${record.stateId};${record.building}`) ?? 0) + 1,
    );
  const document = index.buildingPositions[0]?.document;
  const drop = new Set<number>();
  if (replace)
    for (const record of index.buildingPositions)
      if (stateIds.has(record.stateId)) drop.add(record.line);
  const slots = buildingSlots(index);
  const shapes = new Map<number, ProvinceShape | undefined>();
  const shapeOf = (id: number) => {
    if (!shapes.has(id)) shapes.set(id, provinceShape(raster, id));
    return shapes.get(id);
  };
  const isSea = (id: number) => isSeaProvince(index, id);
  const added: string[] = [];
  for (const state of [...states].sort((left, right) => left.id - right.id)) {
    const provinces = state.provinces
      .filter((id) => !isSea(id) && raster.geometry.has(id))
      .sort(
        (left, right) =>
          (raster.geometry.get(right)?.pixelCount ?? 0) -
            (raster.geometry.get(left)?.pixelCount ?? 0) || left - right,
      );
    if (provinces.length === 0) continue;
    const coastal = provinces.filter((id) => index.coastalProvinceIds.has(id));
    const capital = state.capital ?? derivedStateCapital(state.victoryPoints) ?? provinces[0]!;
    for (const slot of slots) {
      const owners = slot.perProvince
        ? slot.coastal
          ? coastal
          : provinces
        : [slot.coastal ? coastal[0] : capital];
      if (!slot.perProvince && slot.coastal && coastal.length === 0) continue;
      const have = replace ? 0 : (existing.get(`${state.id};${slot.name}`) ?? 0);
      const wanted = slot.count * owners.length;
      if (have >= wanted) continue;
      let produced = 0;
      for (const provinceId of owners) {
        if (provinceId === undefined) continue;
        const shape = shapeOf(provinceId);
        if (shape === undefined) continue;
        const perOwner = slot.count;
        if (slot.coastal) {
          const coast = coastPoint(raster, shape, isSea);
          if (coast === undefined) continue;
          for (
            let copy = 0;
            copy < perOwner && produced < wanted - have;
            copy += 1, produced += 1
          ) {
            const floating = slot.name === 'floating_harbor';
            // A floating harbour sits on the water two pixels out and names its land province.
            const x = floating ? coast.x + coast.dx * 2 : coast.x;
            const y = floating ? coast.y + coast.dy * 2 : coast.y;
            added.push(
              [
                state.id,
                slot.name,
                fixed(x),
                fixed(floating ? 9.5 : index.heightAt(x, y)),
                fixed(raster.height - 1 - y),
                fixed(rotationFor(coast.dx, coast.dy)),
                floating ? provinceId : slot.name.startsWith('naval_base') ? coast.sea : 0,
              ].join(';'),
            );
          }
          continue;
        }
        const points = spreadPoints(shape, perOwner);
        for (const [copy, point] of points.entries()) {
          if (produced >= wanted - have) break;
          added.push(
            [
              state.id,
              slot.name,
              fixed(point.x),
              fixed(index.heightAt(point.x, point.y)),
              fixed(raster.height - 1 - point.y),
              fixed(unitHash(state.id, provinceId, copy, slot.name.length) * TWO_PI),
              0,
            ].join(';'),
          );
          produced += 1;
        }
      }
    }
  }
  return {
    relativePath: document?.file.relativePath ?? `${mapRoot(index)}/buildings.txt`,
    content: rewriteLines(document, drop, added),
  };
}

function planUnitPositions(index: MapWorkspaceIndex, request: PositionsRequest): DerivedFile {
  const raster = requireRaster(index);
  const replace = request.mode === 'replace';
  const provinces = selectedProvinces(index, request);
  const selected = new Set(provinces);
  const covered = new Set(index.unitPositions.map(({ provinceId }) => provinceId));
  const document = index.unitPositions[0]?.document;
  const drop = new Set<number>();
  if (replace)
    for (const record of index.unitPositions)
      if (selected.has(record.provinceId)) drop.add(record.line);
  const added: string[] = [];
  for (const id of provinces) {
    if (!replace && covered.has(id)) continue;
    const definition = index.definitionsById.get(id);
    if (definition === undefined || definition.type === 'lake') continue;
    const shape = provinceShape(raster, id);
    if (shape === undefined) continue;
    const sea = definition.type === 'sea';
    const cx = shape.xs[shape.deepest]!;
    const cy = shape.ys[shape.deepest]!;
    const reach = Math.max(1, Math.min(6, shape.depth[shape.deepest]! * 0.6));
    const neighbors = [...(raster.adjacency.get(id) ?? [])].sort((left, right) => left - right);
    const toward = (other: number) => {
      const geometry = raster.geometry.get(other)!;
      const dx = geometry.centerX - cx;
      const dy = geometry.centerY - cy;
      const length = Math.hypot(dx, dy) || 1;
      return { dx: dx / length, dy: dy / length };
    };
    const offset = fixed(0.2 + unitHash(id) * 1.0);
    const line = (type: number, x: number, y: number, rotation: number) =>
      [
        id,
        type,
        fixed(x),
        fixed(sea ? 9.5 : index.heightAt(x, y)),
        fixed(raster.height - 1 - y),
        fixed(rotation),
        offset,
      ].join(';');
    const moving = neighbors.slice(0, 8);
    const landing = neighbors
      .filter((other) => (index.definitionsById.get(other)?.type === 'sea') !== sea)
      .slice(0, 8);
    // Step from the centre toward a direction and stop before leaving the province, so every
    // model stands on its own province even in narrow shapes.
    const place = (type: number, dx: number, dy: number, distance: number, rotation: number) => {
      let x = cx;
      let y = cy;
      for (let travelled = 0.5; travelled <= distance; travelled += 0.5) {
        const px = Math.floor(cx + dx * travelled);
        const py = Math.floor(cy + dy * travelled);
        if (px < 0 || py < 0 || px >= raster.width || py >= raster.height) break;
        if (raster.provinceIds[py * raster.width + px] !== id) break;
        // Whole pixels: the game and the validator read a position by the pixel it falls in.
        x = px;
        y = py;
      }
      added.push(line(type, x, y, rotation));
    };
    added.push(line(0, cx, cy, 0));
    for (const [position, other] of moving.entries()) {
      const { dx, dy } = toward(other);
      place(1 + position, dx, dy, reach, rotationFor(dx, dy));
    }
    const first = moving[0] === undefined ? { dx: 1, dy: 0 } : toward(moving[0]);
    place(9, -first.dx, -first.dy, reach * 0.5, rotationFor(first.dx, first.dy));
    place(10, first.dx, first.dy, reach * 0.5, rotationFor(-first.dx, -first.dy));
    for (const [position, other] of landing.entries()) {
      const { dx, dy } = toward(other);
      place(11 + position, dx, dy, reach, rotationFor(dx, dy));
    }
    added.push(line(21, cx, cy, 0));
    for (const [position, other] of moving.entries()) {
      const { dx, dy } = toward(other);
      place(22 + position, dx, dy, reach, rotationFor(dx, dy));
    }
    for (const [position, other] of landing.entries()) {
      const { dx, dy } = toward(other);
      place(30 + position, dx, dy, reach, rotationFor(dx, dy));
    }
    place(38, -first.dx, -first.dy, reach * 0.5, rotationFor(first.dx, first.dy));
  }
  return {
    relativePath: document?.file.relativePath ?? `${mapRoot(index)}/unitstacks.txt`,
    content: rewriteLines(document, drop, added),
  };
}

function planWeatherPositions(index: MapWorkspaceIndex, request: PositionsRequest): DerivedFile {
  const raster = requireRaster(index);
  const replace = request.mode === 'replace';
  const explicitRegions = request.regionIds !== undefined;
  const regions = index.regions.filter(
    ({ id }) => !explicitRegions || request.regionIds!.includes(id),
  );
  const selected = new Set(regions.map(({ id }) => id));
  const covered = new Set(index.weatherPositions.map(({ strategicRegionId }) => strategicRegionId));
  const document = index.weatherPositions[0]?.document;
  const drop = new Set<number>();
  if (replace)
    for (const record of index.weatherPositions)
      if (selected.has(record.strategicRegionId)) drop.add(record.line);
  const added: string[] = [];
  for (const region of [...regions].sort((left, right) => left.id - right.id)) {
    if (!replace && covered.has(region.id)) continue;
    let weight = 0;
    let sumX = 0;
    let sumY = 0;
    for (const id of region.provinces) {
      const geometry = raster.geometry.get(id);
      if (geometry === undefined) continue;
      weight += geometry.pixelCount;
      sumX += geometry.centerX * geometry.pixelCount;
      sumY += geometry.centerY * geometry.pixelCount;
    }
    if (weight === 0) continue;
    const meanX = sumX / weight;
    const meanY = sumY / weight;
    const anchor = region.provinces
      .filter((id) => raster.geometry.has(id))
      .sort((left, right) => {
        const a = raster.geometry.get(left)!;
        const b = raster.geometry.get(right)!;
        return (
          Math.hypot(a.centerX - meanX, a.centerY - meanY) -
            Math.hypot(b.centerX - meanX, b.centerY - meanY) || left - right
        );
      })[0];
    const shape = anchor === undefined ? undefined : provinceShape(raster, anchor);
    if (shape === undefined) continue;
    const [small, large] = spreadPoints(shape, 2);
    for (const [point, size] of [
      [small!, 'small'],
      [large ?? small!, 'big'],
    ] as const)
      added.push(
        [
          region.id,
          fixed(point.x),
          fixed(index.heightAt(point.x, point.y) + 0.4),
          fixed(raster.height - 1 - point.y),
          size,
        ].join(';'),
      );
  }
  return {
    relativePath: document?.file.relativePath ?? `${mapRoot(index)}/weatherpositions.txt`,
    content: rewriteLines(document, drop, added),
  };
}

/** Building, unit-stack and weather positions for a selection, or for the whole map. */
export function planMapPositions(
  index: MapWorkspaceIndex,
  request: PositionsRequest,
): DerivedFile[] {
  const kinds = new Set(request.positions ?? ['buildings', 'units', 'weather']);
  return [
    ...(kinds.has('buildings') ? [planBuildingPositions(index, request)] : []),
    ...(kinds.has('units') ? [planUnitPositions(index, request)] : []),
    ...(kinds.has('weather') ? [planWeatherPositions(index, request)] : []),
  ];
}

/** Land provinces that belong to a state: the only ones a railway may cross. */
function railNeighbors(index: MapWorkspaceIndex): (id: number) => number[] {
  const raster = requireRaster(index);
  const blocked = new Set(
    index.adjacencies
      .filter(({ type }) => type === 'impassable')
      .flatMap(({ from, to }) => [`${from}:${to}`, `${to}:${from}`]),
  );
  const usable = (id: number) =>
    index.definitionsById.get(id)?.type === 'land' &&
    (index.statesByProvince.get(id)?.length ?? 0) > 0;
  return (id: number) =>
    [...(raster.adjacency.get(id) ?? [])]
      .filter((other) => usable(other) && !blocked.has(`${id}:${other}`))
      .sort((left, right) => left - right);
}

/** The province a state's supply node belongs in: its capital, else its largest land province. */
function stateHubProvince(index: MapWorkspaceIndex, state: StateRecord): number | undefined {
  const land = state.provinces.filter((id) => index.definitionsById.get(id)?.type === 'land');
  const capital = state.capital ?? derivedStateCapital(state.victoryPoints);
  if (capital !== undefined && land.includes(capital)) return capital;
  return land.sort(
    (left, right) =>
      (index.raster?.geometry.get(right)?.pixelCount ?? 0) -
        (index.raster?.geometry.get(left)?.pixelCount ?? 0) || left - right,
  )[0];
}

/** A state with a supply node within this many land provinces has no supply gap. */
const SUPPLY_GAP_PROVINCES = 3;

/** A binary min-heap of [cost, province] pairs. */
class CostHeap {
  readonly #items: Array<[number, number]> = [];
  get size(): number {
    return this.#items.length;
  }
  push(item: [number, number]): void {
    const items = this.#items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (CostHeap.before(items[parent]!, items[index]!)) break;
      [items[parent], items[index]] = [items[index]!, items[parent]!];
      index = parent;
    }
  }
  pop(): [number, number] {
    const items = this.#items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && CostHeap.before(items[left]!, items[smallest]!)) smallest = left;
        if (right < items.length && CostHeap.before(items[right]!, items[smallest]!))
          smallest = right;
        if (smallest === index) break;
        [items[smallest], items[index]] = [items[index]!, items[smallest]!];
        index = smallest;
      }
    }
    return top;
  }
  private static before(left: [number, number], right: [number, number]): boolean {
    return left[0] < right[0] || (left[0] === right[0] && left[1] < right[1]);
  }
}

/** Cheapest path through land provinces, preferring the owner's own territory. */
function shortestRailPath(
  neighbors: (id: number) => number[],
  sources: ReadonlySet<number>,
  isTarget: (id: number) => boolean,
  cost: (id: number) => number,
): number[] | undefined {
  const distance = new Map<number, number>();
  const previous = new Map<number, number>();
  const frontier = new CostHeap();
  for (const source of sources) {
    distance.set(source, 0);
    frontier.push([0, source]);
  }
  while (frontier.size > 0) {
    const [current, province] = frontier.pop();
    if (current > (distance.get(province) ?? Number.POSITIVE_INFINITY)) continue;
    if (!sources.has(province) && isTarget(province)) {
      const path = [province];
      let cursor = province;
      while (previous.has(cursor)) {
        cursor = previous.get(cursor)!;
        path.push(cursor);
      }
      return path;
    }
    for (const next of neighbors(province)) {
      const candidate = current + cost(next);
      if (candidate < (distance.get(next) ?? Number.POSITIVE_INFINITY)) {
        distance.set(next, candidate);
        previous.set(next, province);
        frontier.push([candidate, next]);
      }
    }
  }
  return undefined;
}

/**
 * Supply nodes and railways: every owned state gets a node in its capital province, and each
 * country's nodes are joined to its main hub (the state with the most victory points) by the
 * shortest railway through its own land where possible.
 */
export function planSupplyRebuild(index: MapWorkspaceIndex, request: SupplyRequest): DerivedFile[] {
  requireRaster(index);
  const replace = request.mode === 'replace';
  const railwayLevel = request.railwayLevel ?? 1;
  const capitalLevel = request.capitalRailwayLevel ?? 3;
  const neighbors = railNeighbors(index);
  const owned = index.states.filter((state) => index.ownersByState.has(state.id));
  const scope =
    request.stateIds === undefined
      ? owned
      : owned.filter(({ id }) => request.stateIds!.includes(id));
  const nodes = new Set(replace ? [] : index.supplyNodes.map(({ provinceId }) => provinceId));
  const railways: number[][] = replace ? [] : index.railways.map(({ provinces }) => [...provinces]);
  const newNodes: number[] = [];
  const newRailways: Array<{ level: number; provinces: number[] }> = [];
  const byOwner = new Map<string, StateRecord[]>();
  for (const state of owned) {
    const owner = index.ownersByState.get(state.id)!;
    const list = byOwner.get(owner) ?? [];
    list.push(state);
    byOwner.set(owner, list);
  }
  const ownerOf = (province: number) => {
    const state = index.statesByProvince.get(province)?.[0];
    return state === undefined ? undefined : index.ownersByState.get(state.id);
  };
  // Without named states, connect only states with a supply gap: no node in the state or on
  // its border. Named states always get their own node.
  // Supply reaches a few provinces past a node; a state within that reach has no gap.
  const reach = new Map<number, number>();
  const queue = [...nodes];
  for (const id of queue) reach.set(id, 0);
  // Iterating the queue while appending to it visits the appended provinces too.
  for (const current of queue) {
    const distance = reach.get(current)!;
    if (distance >= SUPPLY_GAP_PROVINCES) continue;
    for (const next of neighbors(current))
      if (!reach.has(next)) {
        reach.set(next, distance + 1);
        queue.push(next);
      }
  }
  const nearNode = (state: StateRecord) => state.provinces.some((id) => reach.has(id));
  for (const state of scope) {
    if (state.provinces.some((id) => nodes.has(id))) continue;
    if (!replace && request.stateIds === undefined && nearNode(state)) continue;
    const hub = stateHubProvince(index, state);
    if (hub === undefined) continue;
    nodes.add(hub);
    newNodes.push(hub);
  }
  for (const [owner, states] of [...byOwner].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    const ownerScope = states.filter((state) => scope.includes(state));
    if (ownerScope.length === 0) continue;
    const hubState = [...states].sort(
      (left, right) =>
        right.victoryPoints.reduce((sum, { value }) => sum + value, 0) -
          left.victoryPoints.reduce((sum, { value }) => sum + value, 0) ||
        right.provinces.length - left.provinces.length ||
        left.id - right.id,
    )[0]!;
    const hub = hubState.provinces.find((id) => nodes.has(id)) ?? stateHubProvince(index, hubState);
    if (hub === undefined) continue;
    // The hub's railway component.
    const adjacency = new Map<number, Set<number>>();
    for (const path of railways)
      for (let step = 1; step < path.length; step += 1) {
        const left = path[step - 1]!;
        const right = path[step]!;
        adjacency.set(left, (adjacency.get(left) ?? new Set()).add(right));
        adjacency.set(right, (adjacency.get(right) ?? new Set()).add(left));
      }
    const connected = new Set<number>([hub]);
    const queue = [hub];
    while (queue.length > 0) {
      const province = queue.shift()!;
      for (const next of adjacency.get(province) ?? [])
        if (!connected.has(next)) {
          connected.add(next);
          queue.push(next);
        }
    }
    const pending = new Set(
      ownerScope
        .map((state) => state.provinces.find((id) => nodes.has(id)))
        .filter((id): id is number => id !== undefined && !connected.has(id)),
    );
    while (pending.size > 0) {
      const path = shortestRailPath(
        neighbors,
        connected,
        (id) => pending.has(id),
        (id) => (ownerOf(id) === owner ? 1 : 4),
      );
      if (path === undefined) break;
      // A path that leaves the connected set once: from its target back to the network.
      const level = path.includes(hub) ? capitalLevel : railwayLevel;
      newRailways.push({ level, provinces: [...path].reverse() });
      railways.push(path);
      for (const id of path) {
        connected.add(id);
        pending.delete(id);
      }
    }
  }
  const nodeDocument = index.supplyNodes[0]?.document;
  const railDocument = index.railways[0]?.document;
  const nodeDrop = new Set(replace ? index.supplyNodes.map(({ line }) => line) : []);
  const railDrop = new Set(replace ? index.railways.map(({ line }) => line) : []);
  return [
    {
      relativePath:
        index.supplyNodeFile?.relativePath ??
        nodeDocument?.file.relativePath ??
        `${mapRoot(index)}/supply_nodes.txt`,
      content: rewriteLines(
        nodeDocument,
        nodeDrop,
        newNodes.map((id) => `1 ${id}`),
      ),
    },
    {
      relativePath:
        index.railwayFile?.relativePath ??
        railDocument?.file.relativePath ??
        `${mapRoot(index)}/railways.txt`,
      content: rewriteLines(
        railDocument,
        railDrop,
        newRailways.map(
          ({ level, provinces }) => `${level} ${provinces.length} ${provinces.join(' ')}`,
        ),
      ),
    },
  ];
}

/** Base-game level buildings, re-exported for callers that classify buildings without an index. */
export { LEVEL_STATE_BUILDINGS };
export type { ScannedFile };
