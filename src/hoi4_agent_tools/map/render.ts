import sharp from 'sharp';
import { compareCodeUnits, canonicalJson, sha256Bytes } from '../core/canonical.js';
import { assertRenderDimensions, RenderBudget, RENDER_MAX_PIXELS } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import type { PixelDiffBounds, RgbColor } from './bmp.js';
import type { MapWorkspaceIndex, ProvinceGeometry, StateRecord } from './model.js';
import { validateMapAsync, type MapValidationResult } from './validation.js';

export type MapBaseLayer =
  | 'province'
  | 'state'
  | 'strategic-region'
  | 'terrain'
  | 'continent'
  | 'owner'
  | 'controller'
  | 'cores'
  | 'claims'
  | 'coast';

export type MapOverlay =
  | 'coastlines'
  | 'ports'
  | 'victory-points'
  | 'resources'
  | 'state-buildings'
  | 'province-buildings'
  | 'supply-nodes'
  | 'railways'
  | 'adjacencies'
  | 'building-positions'
  | 'unit-positions'
  | 'weather-positions';

export interface MapRenderOptions {
  layer?: MapBaseLayer;
  overlays?: MapOverlay[];
  scale?: number;
  budget?: RenderBudget;
  signal?: AbortSignal;
}

export interface MapRenderBundle {
  width: number;
  height: number;
  png: Buffer;
  json: string;
  html: string;
  hashes: { png: string; json: string; html: string };
}

export interface MapDiffBundle extends MapRenderBundle {
  changedBounds?: PixelDiffBounds;
  changedProvinceIds: number[];
  semantic: MapSemanticDiff;
  review?: MapDiffReviewContext;
}

export interface MapDiffReviewContext {
  operationIds: string[];
  affectedFiles: {
    relativePath: string;
    operationIds: string[];
    mediaType?: string;
    deletion: boolean;
  }[];
  unresolvedChoices: {
    code: string;
    message: string;
    operationId?: string;
    details?: Record<string, unknown>;
  }[];
  allocations: unknown[];
  validation: MapValidationResult;
}

export interface MapSemanticDiff {
  definitions: { id: number; before: string | null; after: string | null }[];
  stateMembership: { provinceId: number; before: number[]; after: number[] }[];
  regionMembership: { provinceId: number; before: number[]; after: number[] }[];
  states: MapRecordSemanticDiff[];
  ports: MapRecordSemanticDiff[];
  buildingPositions: MapRecordSemanticDiff[];
  unitPositions: MapRecordSemanticDiff[];
  weatherPositions: MapRecordSemanticDiff[];
  entityLocators: MapRecordSemanticDiff[];
  supplyNodes: MapRecordSemanticDiff[];
  railways: MapRecordSemanticDiff[];
  adjacencies: MapRecordSemanticDiff[];
  normalAdjacencies: MapRecordSemanticDiff[];
  supplyNodesChanged: boolean;
  railwaysChanged: boolean;
  adjacenciesChanged: boolean;
  normalAdjacenciesChanged: boolean;
}

export interface MapRecordSemanticDiff {
  key: string;
  before: string | null;
  after: string | null;
}

function stableColor(key: string): RgbColor {
  const hash = sha256Bytes(key);
  const first = Number.parseInt(hash.slice(0, 2), 16);
  const second = Number.parseInt(hash.slice(2, 4), 16);
  const third = Number.parseInt(hash.slice(4, 6), 16);
  return {
    r: 48 + (first % 176),
    g: 48 + (second % 176),
    b: 48 + (third % 176),
  };
}

function stateId(index: MapWorkspaceIndex, provinceId: number): number | undefined {
  const states = index.stateForProvince(provinceId);
  return states.length === 1 ? states[0]?.id : undefined;
}

function regionId(index: MapWorkspaceIndex, provinceId: number): number | undefined {
  const regions = index.regionForProvince(provinceId);
  return regions.length === 1 ? regions[0]?.id : undefined;
}

function baseColor(index: MapWorkspaceIndex, provinceId: number, layer: MapBaseLayer): RgbColor {
  const definition = index.definitionsById.get(provinceId);
  if (definition === undefined) return { r: 255, g: 0, b: 255 };
  const state = stateId(index, provinceId);
  const stateRecord = state === undefined ? undefined : index.statesById.get(state);
  if (layer === 'province') return definition.color;
  if (layer === 'state') return stableColor(state === undefined ? 'state:none' : `state:${state}`);
  if (layer === 'strategic-region') {
    const region = regionId(index, provinceId);
    return stableColor(region === undefined ? 'region:none' : `region:${region}`);
  }
  if (layer === 'terrain') return stableColor(`terrain:${definition.terrain}`);
  if (layer === 'continent') return stableColor(`continent:${definition.continent}`);
  if (layer === 'owner') return stableColor(`owner:${stateRecord?.owner ?? 'none'}`);
  if (layer === 'controller')
    return stableColor(`controller:${stateRecord?.controller ?? stateRecord?.owner ?? 'none'}`);
  if (layer === 'cores')
    return stableColor(`cores:${[...(stateRecord?.cores ?? [])].sort().join(',') || 'none'}`);
  if (layer === 'claims')
    return stableColor(`claims:${[...(stateRecord?.claims ?? [])].sort().join(',') || 'none'}`);
  return index.raster?.coastalProvinceIds.has(provinceId)
    ? definition.type === 'land'
      ? { r: 227, g: 186, b: 65 }
      : { r: 44, g: 158, b: 202 }
    : { r: 45, g: 51, b: 58 };
}

function setPixel(
  bytes: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  color: RgbColor,
  alpha = 255,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 4;
  bytes[offset] = color.r;
  bytes[offset + 1] = color.g;
  bytes[offset + 2] = color.b;
  bytes[offset + 3] = alpha;
}

function marker(
  bytes: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  color: RgbColor,
  radius = 2,
): void {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy <= radius * radius)
        setPixel(bytes, width, height, Math.round(x) + dx, Math.round(y) + dy, color);
    }
  }
}

function line(
  bytes: Buffer,
  width: number,
  height: number,
  from: ProvinceGeometry,
  to: ProvinceGeometry,
  color: RgbColor,
): void {
  let x0 = Math.round(from.centerX);
  let y0 = Math.round(from.centerY);
  const x1 = Math.round(to.centerX);
  const y1 = Math.round(to.centerY);
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    marker(bytes, width, height, x0, y0, color, 1);
    if (x0 === x1 && y0 === y1) break;
    const doubled = error * 2;
    if (doubled >= dy) {
      error += dy;
      x0 += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y0 += sy;
    }
  }
}

function provinceCenter(
  index: MapWorkspaceIndex,
  provinceId: number,
): ProvinceGeometry | undefined {
  return index.raster?.geometry.get(provinceId);
}

function stateCenter(index: MapWorkspaceIndex, state: StateRecord): ProvinceGeometry | undefined {
  let pixels = 0;
  let weightedX = 0;
  let weightedY = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const provinceId of state.provinces) {
    const geometry = provinceCenter(index, provinceId);
    if (geometry === undefined) continue;
    pixels += geometry.pixelCount;
    weightedX += geometry.centerX * geometry.pixelCount;
    weightedY += geometry.centerY * geometry.pixelCount;
    minX = Math.min(minX, geometry.minX);
    minY = Math.min(minY, geometry.minY);
    maxX = Math.max(maxX, geometry.maxX);
    maxY = Math.max(maxY, geometry.maxY);
  }
  if (pixels === 0) return undefined;
  return {
    id: state.id,
    pixelCount: pixels,
    minX,
    minY,
    maxX,
    maxY,
    centerX: weightedX / pixels,
    centerY: weightedY / pixels,
  };
}

function valueMarkers(
  bytes: Buffer,
  width: number,
  height: number,
  center: ProvinceGeometry,
  values: ReadonlyMap<string, number>,
  namespace: string,
  phase: number,
): void {
  const entries = [...values].sort(([left], [right]) => compareCodeUnits(left, right));
  for (const [index, [key, value]] of entries.entries()) {
    const angle = ((index + phase) % 8) * (Math.PI / 4);
    const ring = 3 + Math.floor((index + phase) / 8) * 3;
    marker(
      bytes,
      width,
      height,
      center.centerX + Math.cos(angle) * ring,
      center.centerY + Math.sin(angle) * ring,
      stableColor(`${namespace}:${key}`),
      Math.min(4, Math.max(1, Math.ceil(Math.log2(Math.max(0, value) + 1)))),
    );
  }
}

async function renderCheckpoint(signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
}

function mapCoordinateToPixel(
  index: MapWorkspaceIndex,
  x: number,
  z: number,
): { x: number; y: number } | undefined {
  const raster = index.raster;
  if (raster === undefined) return undefined;
  const pixel = { x: Math.floor(x), y: raster.height - 1 - Math.floor(z) };
  return pixel.x < 0 || pixel.y < 0 || pixel.x >= raster.width || pixel.y >= raster.height
    ? undefined
    : pixel;
}

async function applyOverlays(
  index: MapWorkspaceIndex,
  bytes: Buffer,
  overlays: ReadonlySet<MapOverlay>,
  signal?: AbortSignal,
): Promise<void> {
  const raster = index.raster;
  if (raster === undefined) return;
  if (overlays.has('coastlines')) {
    for (let y = 0; y < raster.height; y += 1) {
      if (y % 32 === 0) await renderCheckpoint(signal);
      for (let x = 0; x < raster.width; x += 1) {
        const id = raster.provinceIds[y * raster.width + x] ?? -1;
        const definition = index.definitionsById.get(id);
        if (definition?.type !== 'land') continue;
        const neighbors = [
          raster.provinceIds[y * raster.width + (x === 0 ? raster.width - 1 : x - 1)] ?? -1,
          raster.provinceIds[y * raster.width + (x === raster.width - 1 ? 0 : x + 1)] ?? -1,
          y === 0 ? -1 : (raster.provinceIds[(y - 1) * raster.width + x] ?? -1),
          y === raster.height - 1 ? -1 : (raster.provinceIds[(y + 1) * raster.width + x] ?? -1),
        ];
        if (neighbors.some((neighbor) => index.definitionsById.get(neighbor)?.type === 'sea')) {
          setPixel(bytes, raster.width, raster.height, x, y, { r: 65, g: 223, b: 255 });
        }
      }
    }
  }
  if (overlays.has('ports')) {
    for (const state of index.states) {
      for (const [provinceId, buildings] of state.provinceBuildings) {
        if ((buildings.get('naval_base') ?? 0) <= 0) continue;
        const center = provinceCenter(index, provinceId);
        if (center !== undefined)
          marker(
            bytes,
            raster.width,
            raster.height,
            center.centerX,
            center.centerY,
            { r: 46, g: 221, b: 255 },
            3,
          );
      }
    }
  }
  if (overlays.has('victory-points')) {
    for (const state of index.states) {
      for (const point of state.victoryPoints) {
        const center = provinceCenter(index, point.provinceId);
        if (center !== undefined)
          marker(
            bytes,
            raster.width,
            raster.height,
            center.centerX,
            center.centerY,
            { r: 255, g: 223, b: 72 },
            Math.min(5, Math.max(2, Math.ceil(point.value / 10))),
          );
      }
    }
  }
  if (overlays.has('resources')) {
    for (const state of [...index.states].sort((left, right) => left.id - right.id)) {
      signal?.throwIfAborted();
      const center = stateCenter(index, state);
      if (center !== undefined)
        valueMarkers(bytes, raster.width, raster.height, center, state.resources, 'resource', 0);
    }
  }
  if (overlays.has('state-buildings')) {
    for (const state of [...index.states].sort((left, right) => left.id - right.id)) {
      signal?.throwIfAborted();
      const center = stateCenter(index, state);
      if (center !== undefined)
        valueMarkers(
          bytes,
          raster.width,
          raster.height,
          center,
          state.stateBuildings,
          'state-building',
          2,
        );
    }
  }
  if (overlays.has('province-buildings')) {
    for (const state of [...index.states].sort((left, right) => left.id - right.id)) {
      for (const [provinceId, buildings] of [...state.provinceBuildings].sort(
        ([left], [right]) => left - right,
      )) {
        signal?.throwIfAborted();
        const center = provinceCenter(index, provinceId);
        if (center !== undefined)
          valueMarkers(
            bytes,
            raster.width,
            raster.height,
            center,
            buildings,
            'province-building',
            4,
          );
      }
    }
  }
  if (overlays.has('supply-nodes')) {
    for (const node of index.supplyNodes) {
      const center = provinceCenter(index, node.provinceId);
      if (center !== undefined)
        marker(
          bytes,
          raster.width,
          raster.height,
          center.centerX,
          center.centerY,
          { r: 241, g: 76, b: 76 },
          3,
        );
    }
  }
  if (overlays.has('railways')) {
    for (const railway of index.railways) {
      for (let position = 1; position < railway.provinces.length; position += 1) {
        const fromId = railway.provinces[position - 1];
        const toId = railway.provinces[position];
        if (fromId === undefined || toId === undefined) continue;
        const from = provinceCenter(index, fromId);
        const to = provinceCenter(index, toId);
        if (from !== undefined && to !== undefined)
          line(bytes, raster.width, raster.height, from, to, { r: 94, g: 233, b: 121 });
      }
    }
  }
  if (overlays.has('adjacencies')) {
    for (const adjacency of index.adjacencies) {
      const from = provinceCenter(index, adjacency.from);
      const to = provinceCenter(index, adjacency.to);
      if (from !== undefined && to !== undefined)
        line(
          bytes,
          raster.width,
          raster.height,
          from,
          to,
          adjacency.type === 'impassable' ? { r: 255, g: 72, b: 72 } : { r: 211, g: 102, b: 255 },
        );
    }
  }
  if (overlays.has('building-positions')) {
    for (const position of index.buildingPositions) {
      const pixel = mapCoordinateToPixel(index, position.x, position.z);
      if (pixel !== undefined)
        marker(bytes, raster.width, raster.height, pixel.x, pixel.y, { r: 255, g: 153, b: 51 }, 2);
    }
  }
  if (overlays.has('unit-positions')) {
    for (const position of index.unitPositions) {
      const pixel = mapCoordinateToPixel(index, position.x, position.z);
      if (pixel !== undefined)
        marker(bytes, raster.width, raster.height, pixel.x, pixel.y, { r: 255, g: 255, b: 255 }, 2);
    }
  }
  if (overlays.has('weather-positions')) {
    for (const position of index.weatherPositions) {
      const pixel = mapCoordinateToPixel(index, position.x, position.z);
      if (pixel !== undefined)
        marker(
          bytes,
          raster.width,
          raster.height,
          pixel.x,
          pixel.y,
          { r: 88, g: 174, b: 255 },
          position.size === 'big' ? 4 : 2,
        );
    }
  }
}

async function renderMetadata(
  index: MapWorkspaceIndex,
  options: Required<Omit<MapRenderOptions, 'signal' | 'budget'>>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const victoryPoints = index.states
    .flatMap((state) =>
      state.victoryPoints.map(({ provinceId, value }) => ({
        stateId: state.id,
        provinceId,
        value,
        sourcePath: state.file.displayPath,
      })),
    )
    .sort(
      (left, right) =>
        left.stateId - right.stateId ||
        left.provinceId - right.provinceId ||
        left.value - right.value,
    );
  const normalAdjacencies = [...(index.raster?.adjacency ?? [])]
    .flatMap(([from, neighbors]) =>
      [...neighbors].flatMap((to) => (from < to ? [{ from, to }] : [])),
    )
    .sort((left, right) => left.from - right.from || left.to - right.to);
  return {
    offline: true,
    renderer: 'hoi4-agent-tools-agent-nudger',
    layer: options.layer,
    overlays: options.overlays,
    scale: options.scale,
    width: index.raster?.width ?? 0,
    height: index.raster?.height ?? 0,
    definitions: index.definitions.map(({ id, color, type, coastal, terrain, continent }) => ({
      id,
      color,
      type,
      coastal,
      terrain,
      continent,
    })),
    states: [...index.states]
      .sort((left, right) => left.id - right.id)
      .map(
        ({
          id,
          name,
          capital,
          provinces,
          resources,
          stateBuildings,
          provinceBuildings,
          owner,
          controller,
          cores,
          claims,
        }) => ({
          id,
          name,
          capital: capital ?? null,
          manpower: index.statesById.get(id)?.manpower ?? 0,
          category: index.statesById.get(id)?.category ?? '',
          provinces: [...provinces].sort((a, b) => a - b),
          resources: Object.fromEntries(
            [...resources].sort(([left], [right]) => compareCodeUnits(left, right)),
          ),
          stateBuildings: Object.fromEntries(
            [...stateBuildings].sort(([left], [right]) => compareCodeUnits(left, right)),
          ),
          provinceBuildings: Object.fromEntries(
            [...provinceBuildings]
              .sort(([left], [right]) => left - right)
              .map(([provinceId, buildings]) => [
                String(provinceId),
                Object.fromEntries(
                  [...buildings].sort(([left], [right]) => compareCodeUnits(left, right)),
                ),
              ]),
          ),
          owner: owner ?? null,
          controller: controller ?? null,
          cores: [...cores].sort(),
          claims: [...claims].sort(),
        }),
      ),
    regions: [...index.regions]
      .sort((left, right) => left.id - right.id)
      .map(({ id, name, provinces }) => ({
        id,
        name,
        provinces: [...provinces].sort((a, b) => a - b),
      })),
    victoryPoints,
    ports: [...index.ports]
      .sort((left, right) => left.stateId - right.stateId || left.provinceId - right.provinceId)
      .map(({ stateId, provinceId, level, coastal, adjacentSeaProvinceIds, positions }) => ({
        stateId,
        provinceId,
        level,
        coastal,
        adjacentSeaProvinceIds: [...adjacentSeaProvinceIds].sort((left, right) => left - right),
        positions: positions.map(
          ({ building, x, y, z, rotation, adjacentSeaProvince, document, line }) => ({
            building,
            x,
            y,
            z,
            rotation,
            adjacentSeaProvince,
            sourcePath: document.file.displayPath,
            line,
          }),
        ),
      })),
    supplyNodes: index.supplyNodes.map(({ level, provinceId, document, line }) => ({
      level,
      provinceId,
      sourcePath: document.file.displayPath,
      line,
    })),
    railways: index.railways.map(
      ({ level, declaredCount, provinces, document, line }, ordinal) => ({
        ordinal,
        level,
        declaredCount,
        provinces: [...provinces],
        sourcePath: document.file.displayPath,
        line,
      }),
    ),
    adjacencies: index.adjacencies.map(
      (
        { from, to, type, through, startX, startY, stopX, stopY, rule, comment, document, line },
        ordinal,
      ) => ({
        ordinal,
        from,
        to,
        type,
        through,
        startX,
        startY,
        stopX,
        stopY,
        rule,
        comment,
        sourcePath: document.file.displayPath,
        line,
      }),
    ),
    normalAdjacencies,
    buildingPositions: index.buildingPositions.map(
      ({ stateId, building, x, y, z, rotation, adjacentSeaProvince, document, line }) => ({
        stateId,
        building,
        x,
        y,
        z,
        rotation,
        adjacentSeaProvince,
        sourcePath: document.file.displayPath,
        line,
      }),
    ),
    unitPositions: index.unitPositions.map(
      ({ provinceId, type, x, y, z, rotation, offset, document, line }) => ({
        provinceId,
        type,
        x,
        y,
        z,
        rotation,
        offset,
        sourcePath: document.file.displayPath,
        line,
      }),
    ),
    weatherPositions: index.weatherPositions.map(
      ({ strategicRegionId, x, y, z, size, document, line }) => ({
        strategicRegionId,
        x,
        y,
        z,
        size,
        sourcePath: document.file.displayPath,
        line,
      }),
    ),
    entityLocators: [...index.entityLocators]
      .sort(
        (left, right) =>
          compareCodeUnits(left.entity, right.entity) || compareCodeUnits(left.name, right.name),
      )
      .map(({ entity, name, position, file }) => ({
        entity,
        name,
        position: [...position],
        sourcePath: file.displayPath,
      })),
    validation: await validateMapAsync(index, signal === undefined ? {} : { signal }),
  };
}

function htmlDocument(title: string, png: Buffer, json: string): string {
  const escapedTitle = title
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const escapedJson = json.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle}</title><style>html{background:#10151b;color:#edf2f7;font:14px system-ui}body{margin:20px}.controls{display:flex;gap:8px;align-items:center;margin:12px 0}button{background:#263241;color:#edf2f7;border:1px solid #526173;border-radius:4px;padding:6px 10px}.viewport{height:70vh;overflow:hidden;border:1px solid #48515c;background:#080b0f;position:relative;touch-action:none}.viewport img{image-rendering:pixelated;transform-origin:0 0;position:absolute;max-width:none;cursor:grab;user-select:none}.viewport img.dragging{cursor:grabbing}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${escapedTitle}</h1><p>Offline deterministic map representation; not an in-game screenshot or source editor.</p><div class="controls"><button id="out" type="button">-</button><button id="reset" type="button">Reset</button><button id="in" type="button">+</button><output id="zoom">100%</output></div><div class="viewport" id="viewport"><img id="map" draggable="false" alt="${escapedTitle}" src="data:image/png;base64,${png.toString('base64')}"></div><details><summary>Render metadata</summary><pre>${escapedJson}</pre></details><script>(()=>{const image=document.getElementById('map'),viewport=document.getElementById('viewport'),label=document.getElementById('zoom');let scale=1,x=0,y=0,drag=false,lastX=0,lastY=0;const draw=()=>{image.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')';label.value=Math.round(scale*100)+'%'};const zoom=(factor,cx=viewport.clientWidth/2,cy=viewport.clientHeight/2)=>{const next=Math.min(16,Math.max(.1,scale*factor));x=cx-(cx-x)*(next/scale);y=cy-(cy-y)*(next/scale);scale=next;draw()};document.getElementById('in').onclick=()=>zoom(1.25);document.getElementById('out').onclick=()=>zoom(.8);document.getElementById('reset').onclick=()=>{scale=1;x=0;y=0;draw()};viewport.addEventListener('wheel',event=>{event.preventDefault();const bounds=viewport.getBoundingClientRect();zoom(event.deltaY<0?1.15:.87,event.clientX-bounds.left,event.clientY-bounds.top)},{passive:false});image.addEventListener('pointerdown',event=>{drag=true;lastX=event.clientX;lastY=event.clientY;image.setPointerCapture(event.pointerId);image.classList.add('dragging')});image.addEventListener('pointermove',event=>{if(!drag)return;x+=event.clientX-lastX;y+=event.clientY-lastY;lastX=event.clientX;lastY=event.clientY;draw()});image.addEventListener('pointerup',()=>{drag=false;image.classList.remove('dragging')});draw()})();</script></body></html>`;
}

async function encodePng(
  raw: Buffer,
  width: number,
  height: number,
  scale: number,
): Promise<Buffer> {
  assertRenderDimensions(width, height, 'map Sharp source raster');
  assertRenderDimensions(width * scale, height * scale, 'map Sharp output raster');
  let pipeline = sharp(raw, {
    raw: { width, height, channels: 4 },
    limitInputPixels: RENDER_MAX_PIXELS,
  });
  if (scale !== 1) pipeline = pipeline.resize(width * scale, height * scale, { kernel: 'nearest' });
  return pipeline.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
}

export async function renderMap(
  index: MapWorkspaceIndex,
  options: MapRenderOptions = {},
): Promise<MapRenderBundle> {
  const raster = index.raster;
  if (raster === undefined) {
    const budgetDiagnostic = index.diagnostics.find(({ code }) => code.startsWith('RENDER_'));
    if (budgetDiagnostic !== undefined) {
      throw new ServiceError(
        budgetDiagnostic.code,
        budgetDiagnostic.message,
        budgetDiagnostic.details ?? {},
      );
    }
    throw new ServiceError(
      'MAP_RENDER_RASTER_MISSING',
      'Cannot render without a valid province bitmap and definitions',
    );
  }
  const resolved: Required<Omit<MapRenderOptions, 'signal' | 'budget'>> = {
    layer: options.layer ?? 'province',
    overlays: [...new Set(options.overlays ?? [])].sort(),
    scale: options.scale ?? 1,
  };
  if (!Number.isInteger(resolved.scale) || resolved.scale < 1 || resolved.scale > 16)
    throw new ServiceError(
      'MAP_RENDER_SCALE_INVALID',
      'Map render scale must be an integer from 1 through 16',
    );
  const budget = options.budget ?? new RenderBudget();
  assertRenderDimensions(raster.width, raster.height, 'map RGBA source plane');
  const outputDimensions = budget.reserve(
    raster.width * resolved.scale,
    raster.height * resolved.scale,
    'map PNG output',
  );
  const raw = Buffer.alloc(raster.width * raster.height * 4);
  for (let offset = 0; offset < raster.provinceIds.length; offset += 1) {
    if (offset % Math.max(raster.width * 32, 1) === 0) await renderCheckpoint(options.signal);
    const color = baseColor(index, raster.provinceIds[offset] ?? -1, resolved.layer);
    const target = offset * 4;
    raw[target] = color.r;
    raw[target + 1] = color.g;
    raw[target + 2] = color.b;
    raw[target + 3] = 255;
  }
  await applyOverlays(index, raw, new Set(resolved.overlays), options.signal);
  options.signal?.throwIfAborted();
  const png = await encodePng(raw, raster.width, raster.height, resolved.scale);
  options.signal?.throwIfAborted();
  const json = `${canonicalJson(await renderMetadata(index, resolved, options.signal))}\n`;
  const html = htmlDocument(`Agent Nudger map - ${resolved.layer}`, png, json);
  return {
    width: outputDimensions.width,
    height: outputDimensions.height,
    png,
    json,
    html,
    hashes: { png: sha256Bytes(png), json: sha256Bytes(json), html: sha256Bytes(html) },
  };
}

function definitionSignature(index: MapWorkspaceIndex, id: number): string | null {
  const value = index.definitionsById.get(id);
  return value === undefined
    ? null
    : canonicalJson({
        color: value.color,
        type: value.type,
        coastal: value.coastal,
        terrain: value.terrain,
        continent: value.continent,
      });
}

function listSignature(value: unknown): string {
  return canonicalJson(value);
}

function stateSignature(index: MapWorkspaceIndex, id: number): string | null {
  const state = index.statesById.get(id);
  return state === undefined
    ? null
    : canonicalJson({
        name: state.name,
        capital: state.capital ?? null,
        manpower: state.manpower,
        category: state.category,
        resources: Object.fromEntries(state.resources),
        owner: state.owner ?? null,
        controller: state.controller ?? null,
        cores: [...state.cores].sort(),
        claims: [...state.claims].sort(),
        victoryPoints: state.victoryPoints
          .map(({ provinceId, value }) => ({ provinceId, value }))
          .sort((left, right) => left.provinceId - right.provinceId || left.value - right.value),
        stateBuildings: Object.fromEntries(state.stateBuildings),
        provinceBuildings: Object.fromEntries(
          [...state.provinceBuildings]
            .sort(([left], [right]) => left - right)
            .map(([provinceId, buildings]) => [String(provinceId), Object.fromEntries(buildings)]),
        ),
      });
}

function diffRecordMaps(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): MapRecordSemanticDiff[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort((left, right) => compareCodeUnits(left, right))
    .flatMap((key) => {
      const left = before.get(key) ?? null;
      const right = after.get(key) ?? null;
      return left === right ? [] : [{ key, before: left, after: right }];
    });
}

function occurrenceRecordMap<T>(
  values: readonly T[],
  groupKey: (value: T) => string,
  signature: (value: T) => unknown,
): Map<string, string> {
  const occurrences = new Map<string, number>();
  const result = new Map<string, string>();
  for (const value of values) {
    const group = groupKey(value);
    const occurrence = occurrences.get(group) ?? 0;
    occurrences.set(group, occurrence + 1);
    result.set(`${group}:${occurrence}`, canonicalJson(signature(value)));
  }
  return result;
}

export function semanticMapDiff(
  before: MapWorkspaceIndex,
  after: MapWorkspaceIndex,
): MapSemanticDiff {
  const provinceIds = uniqueNumbers([
    ...before.definitionsById.keys(),
    ...after.definitionsById.keys(),
  ]);
  const definitions = provinceIds.flatMap((id) => {
    const left = definitionSignature(before, id);
    const right = definitionSignature(after, id);
    return left === right ? [] : [{ id, before: left, after: right }];
  });
  const stateMembership = provinceIds.flatMap((provinceId) => {
    const left = before
      .stateForProvince(provinceId)
      .map(({ id }) => id)
      .sort((a, b) => a - b);
    const right = after
      .stateForProvince(provinceId)
      .map(({ id }) => id)
      .sort((a, b) => a - b);
    return listSignature(left) === listSignature(right)
      ? []
      : [{ provinceId, before: left, after: right }];
  });
  const regionMembership = provinceIds.flatMap((provinceId) => {
    const left = before
      .regionForProvince(provinceId)
      .map(({ id }) => id)
      .sort((a, b) => a - b);
    const right = after
      .regionForProvince(provinceId)
      .map(({ id }) => id)
      .sort((a, b) => a - b);
    return listSignature(left) === listSignature(right)
      ? []
      : [{ provinceId, before: left, after: right }];
  });
  const stateIds = uniqueNumbers([...before.statesById.keys(), ...after.statesById.keys()]);
  const states = stateIds.flatMap((id) => {
    const left = stateSignature(before, id);
    const right = stateSignature(after, id);
    return left === right ? [] : [{ key: String(id), before: left, after: right }];
  });
  const portRecords = (index: MapWorkspaceIndex): Map<string, string> =>
    new Map(
      index.ports.map((port) => [
        `${port.stateId}:${port.provinceId}`,
        canonicalJson({
          level: port.level,
          coastal: port.coastal,
          adjacentSeaProvinceIds: port.adjacentSeaProvinceIds,
          positionCount: port.positions.length,
        }),
      ]),
    );
  const buildingPositionRecords = (index: MapWorkspaceIndex): Map<string, string> =>
    occurrenceRecordMap(
      index.buildingPositions,
      ({ stateId, building }) => `${stateId}:${building}`,
      ({ stateId, building, x, y, z, rotation, adjacentSeaProvince }) => ({
        stateId,
        building,
        x,
        y,
        z,
        rotation,
        adjacentSeaProvince,
      }),
    );
  const unitPositionRecords = (index: MapWorkspaceIndex): Map<string, string> =>
    occurrenceRecordMap(
      index.unitPositions,
      ({ provinceId, type }) => `${provinceId}:${type}`,
      ({ provinceId, type, x, y, z, rotation, offset }) => ({
        provinceId,
        type,
        x,
        y,
        z,
        rotation,
        offset,
      }),
    );
  const weatherPositionRecords = (index: MapWorkspaceIndex): Map<string, string> =>
    occurrenceRecordMap(
      index.weatherPositions,
      ({ strategicRegionId, size }) => `${strategicRegionId}:${size}`,
      ({ strategicRegionId, x, y, z, size }) => ({ strategicRegionId, x, y, z, size }),
    );
  const entityLocatorRecords = (index: MapWorkspaceIndex): Map<string, string> =>
    occurrenceRecordMap(
      index.entityLocators,
      ({ entity, name }) => `${entity}:${name}`,
      ({ entity, name, position }) => ({ entity, name, position }),
    );
  const supplyNodeRecords = (index: MapWorkspaceIndex): Map<string, string> =>
    occurrenceRecordMap(
      index.supplyNodes,
      ({ provinceId }) => String(provinceId),
      ({ level, provinceId }) => ({ level, provinceId }),
    );
  const railwayRecords = (index: MapWorkspaceIndex): Map<string, string> =>
    new Map(
      index.railways.map(({ level, provinces }, position) => [
        String(position),
        canonicalJson({ level, provinces }),
      ]),
    );
  const adjacencyRecords = (index: MapWorkspaceIndex): Map<string, string> =>
    occurrenceRecordMap(
      index.adjacencies,
      ({ from, to, type }) => `${Math.min(from, to)}:${Math.max(from, to)}:${type}`,
      ({ from, to, type, through, startX, startY, stopX, stopY, rule, comment }) => ({
        from,
        to,
        type,
        through,
        startX,
        startY,
        stopX,
        stopY,
        rule,
        comment,
      }),
    );
  const normalAdjacencyRecords = (index: MapWorkspaceIndex): Map<string, string> => {
    const result = new Map<string, string>();
    for (const [from, neighbors] of index.raster?.adjacency ?? []) {
      for (const to of neighbors) {
        if (from >= to) continue;
        result.set(`${from}:${to}`, canonicalJson({ from, to }));
      }
    }
    return result;
  };
  const beforeNormalAdjacencies = normalAdjacencyRecords(before);
  const afterNormalAdjacencies = normalAdjacencyRecords(after);
  const normalAdjacencies = diffRecordMaps(beforeNormalAdjacencies, afterNormalAdjacencies);
  return {
    definitions,
    stateMembership,
    regionMembership,
    states,
    ports: diffRecordMaps(portRecords(before), portRecords(after)),
    buildingPositions: diffRecordMaps(
      buildingPositionRecords(before),
      buildingPositionRecords(after),
    ),
    unitPositions: diffRecordMaps(unitPositionRecords(before), unitPositionRecords(after)),
    weatherPositions: diffRecordMaps(weatherPositionRecords(before), weatherPositionRecords(after)),
    entityLocators: diffRecordMaps(entityLocatorRecords(before), entityLocatorRecords(after)),
    supplyNodes: diffRecordMaps(supplyNodeRecords(before), supplyNodeRecords(after)),
    railways: diffRecordMaps(railwayRecords(before), railwayRecords(after)),
    adjacencies: diffRecordMaps(adjacencyRecords(before), adjacencyRecords(after)),
    normalAdjacencies,
    supplyNodesChanged:
      listSignature(before.supplyNodes.map(({ level, provinceId }) => ({ level, provinceId }))) !==
      listSignature(after.supplyNodes.map(({ level, provinceId }) => ({ level, provinceId }))),
    railwaysChanged:
      listSignature(before.railways.map(({ level, provinces }) => ({ level, provinces }))) !==
      listSignature(after.railways.map(({ level, provinces }) => ({ level, provinces }))),
    adjacenciesChanged:
      listSignature(
        before.adjacencies.map(({ from, to, type, through, rule }) => ({
          from,
          to,
          type,
          through,
          rule,
        })),
      ) !==
      listSignature(
        after.adjacencies.map(({ from, to, type, through, rule }) => ({
          from,
          to,
          type,
          through,
          rule,
        })),
      ),
    normalAdjacenciesChanged: normalAdjacencies.length > 0,
  };
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

export async function renderMapDiff(
  before: MapWorkspaceIndex,
  after: MapWorkspaceIndex,
  options: Pick<MapRenderOptions, 'scale' | 'signal' | 'budget'> & {
    review?: MapDiffReviewContext;
  } = {},
): Promise<MapDiffBundle> {
  const left = before.provinceBitmap;
  const right = after.provinceBitmap;
  if (left === undefined || right?.width !== left.width || left.height !== right.height) {
    const budgetDiagnostic = [...before.diagnostics, ...after.diagnostics].find(({ code }) =>
      code.startsWith('RENDER_'),
    );
    if (budgetDiagnostic !== undefined) {
      throw new ServiceError(
        budgetDiagnostic.code,
        budgetDiagnostic.message,
        budgetDiagnostic.details ?? {},
      );
    }
    throw new ServiceError(
      'MAP_DIFF_BITMAP_MISMATCH',
      'Map diff requires same-sized baseline and proposed province bitmaps',
    );
  }
  const scale = options.scale ?? 1;
  if (!Number.isInteger(scale) || scale < 1 || scale > 16)
    throw new ServiceError(
      'MAP_RENDER_SCALE_INVALID',
      'Map render scale must be an integer from 1 through 16',
    );
  const budget = options.budget ?? new RenderBudget();
  assertRenderDimensions(left.width, left.height, 'map diff RGBA source plane');
  const outputDimensions = budget.reserve(
    left.width * scale,
    left.height * scale,
    'map diff PNG output',
  );
  const raw = Buffer.alloc(left.width * left.height * 4);
  const changedProvinceIds = new Set<number>();
  for (let y = 0; y < left.height; y += 1) {
    if (y % 32 === 0) await renderCheckpoint(options.signal);
    for (let x = 0; x < left.width; x += 1) {
      const beforeColor = left.rgbAt(x, y);
      const afterColor = right.rgbAt(x, y);
      const changed =
        beforeColor.r !== afterColor.r ||
        beforeColor.g !== afterColor.g ||
        beforeColor.b !== afterColor.b;
      setPixel(
        raw,
        left.width,
        left.height,
        x,
        y,
        changed ? { r: 255, g: 54, b: 124 } : { r: 43, g: 48, b: 55 },
        255,
      );
      if (changed) {
        const offset = y * left.width + x;
        const beforeId = before.raster?.provinceIds[offset] ?? -1;
        const afterId = after.raster?.provinceIds[offset] ?? -1;
        if (beforeId >= 0) changedProvinceIds.add(beforeId);
        if (afterId >= 0) changedProvinceIds.add(afterId);
      }
    }
  }
  options.signal?.throwIfAborted();
  const png = await encodePng(raw, left.width, left.height, scale);
  options.signal?.throwIfAborted();
  const semantic = semanticMapDiff(before, after);
  const changedBounds = left.diffBounds(right);
  const metadata = {
    offline: true,
    renderer: 'hoi4-agent-tools-agent-nudger-diff',
    changedBounds: changedBounds ?? null,
    changedProvinceIds: [...changedProvinceIds].sort((a, b) => a - b),
    semantic,
    ...(options.review === undefined ? {} : { review: options.review }),
  };
  const json = `${canonicalJson(metadata)}\n`;
  const html = htmlDocument('Agent Nudger pixel and semantic diff', png, json);
  return {
    width: outputDimensions.width,
    height: outputDimensions.height,
    png,
    json,
    html,
    hashes: { png: sha256Bytes(png), json: sha256Bytes(json), html: sha256Bytes(html) },
    ...(changedBounds === undefined ? {} : { changedBounds }),
    changedProvinceIds: metadata.changedProvinceIds,
    semantic,
    ...(options.review === undefined ? {} : { review: options.review }),
  };
}
