import sharp from 'sharp';
import { compareCodeUnits, canonicalJson, sha256Bytes } from '../core/canonical.js';
import { assertRenderDimensions, RenderBudget, RENDER_MAX_PIXELS } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import type { PixelDiffBounds, RgbColor } from './bmp.js';
import { buildMapCatalog } from './catalog.js';
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
  const catalog = buildMapCatalog(index);
  return {
    ...catalog,
    renderer: 'hoi4-agent-tools-map-workbench',
    layer: options.layer,
    overlays: options.overlays,
    scale: options.scale,
    width: index.raster?.width ?? 0,
    height: index.raster?.height ?? 0,
    definitions: catalog.provinces.map(({ id, definition }) => ({ id, ...definition })),
    regions: catalog.strategicRegions,
    adjacencies: catalog.specialAdjacencies,
    validation: await validateMapAsync(index, signal === undefined ? {} : { signal }),
  };
}

function htmlDocument(
  title: string,
  png: Buffer,
  provinceHitMap: Buffer,
  json: string,
  renderScale: number,
): string {
  const escapedTitle = title
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const scriptJson = json.replaceAll('<', '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle}</title><style>html{background:#10151b;color:#edf2f7;font:14px system-ui}body{margin:0;height:100vh;display:grid;grid-template-columns:minmax(0,1fr) 360px;overflow:hidden}.main{min-width:0;padding:14px;display:flex;flex-direction:column}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}button,input,select{background:#202b38;color:#edf2f7;border:1px solid #526173;border-radius:4px;padding:6px 9px}input{min-width:260px;flex:1}.viewport{flex:1;min-height:0;overflow:hidden;border:1px solid #48515c;background:#080b0f;position:relative;touch-action:none}.viewport img{image-rendering:pixelated;transform-origin:0 0;position:absolute;max-width:none;cursor:grab;user-select:none}.viewport img.dragging{cursor:grabbing}.cursor{position:absolute;left:8px;bottom:8px;background:#10151bd9;padding:4px 7px;border-radius:3px;pointer-events:none}.side{border-left:1px solid #48515c;padding:14px;overflow:auto;background:#151d26}.results{display:grid;gap:4px;margin:8px 0 14px}.result{text-align:left;width:100%}.kind{color:#8fb7d9}.muted{color:#9ca9b5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}h1{font-size:18px;margin:0 12px 0 0}h2{font-size:15px}</style></head><body><main class="main"><div class="toolbar"><h1>${escapedTitle}</h1><button id="out" type="button">-</button><button id="fit" type="button">Fit</button><button id="in" type="button">+</button><output id="zoom">100%</output><select id="kind"><option value="all">All IDs</option><option value="province">Provinces</option><option value="state">States</option><option value="strategic-region">Strategic regions</option></select><input id="search" type="search" placeholder="Find ID, localisation key, or name" autocomplete="off"></div><div class="viewport" id="viewport"><img id="map" draggable="false" alt="${escapedTitle}" src="data:image/png;base64,${png.toString('base64')}"><div class="cursor" id="cursor">Move over the map to inspect coordinates; click for IDs.</div></div></main><aside class="side"><h2>Search results</h2><div class="results" id="results"><span class="muted">Search by ID or name.</span></div><h2>Selection</h2><pre id="selection">Click a province or choose a search result.</pre><p class="muted">The complete source-linked catalog is embedded for navigation and is also available as the linked JSON resource.</p></aside><img id="hit" hidden src="data:image/png;base64,${provinceHitMap.toString('base64')}"><canvas id="hitCanvas" hidden></canvas><script>(()=>{const data=${scriptJson};const renderScale=${renderScale};const image=document.getElementById('map'),hit=document.getElementById('hit'),canvas=document.getElementById('hitCanvas'),viewport=document.getElementById('viewport'),zoomLabel=document.getElementById('zoom'),cursor=document.getElementById('cursor'),search=document.getElementById('search'),kind=document.getElementById('kind'),results=document.getElementById('results'),selection=document.getElementById('selection');const provinces=new Map(data.provinces.map(value=>[value.id,value])),states=new Map(data.states.map(value=>[value.id,value])),regions=new Map(data.strategicRegions.map(value=>[value.id,value]));let scale=1,x=0,y=0,drag=false,moved=false,lastX=0,lastY=0,hitContext=null;const draw=()=>{image.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')';zoomLabel.value=Math.round(scale*100)+'%'};const fit=()=>{scale=Math.min(viewport.clientWidth/image.naturalWidth,viewport.clientHeight/image.naturalHeight);x=(viewport.clientWidth-image.naturalWidth*scale)/2;y=(viewport.clientHeight-image.naturalHeight*scale)/2;draw()};const zoom=(factor,cx=viewport.clientWidth/2,cy=viewport.clientHeight/2)=>{const next=Math.min(32,Math.max(.03,scale*factor));x=cx-(cx-x)*(next/scale);y=cy-(cy-y)*(next/scale);scale=next;draw()};const entity=(entityKind,id)=>entityKind==='province'?provinces.get(id):entityKind==='state'?states.get(id):regions.get(id);const linked=(province)=>({province,states:province.stateIds.map(id=>states.get(id)),strategicRegions:province.regionIds.map(id=>regions.get(id))});const show=(entityKind,id)=>{const value=entity(entityKind,id);selection.textContent=value?JSON.stringify(entityKind==='province'?linked(value):value,null,2):'No matching record.';if(value?.geometry){const g=value.geometry;x=viewport.clientWidth/2-g.centerX*renderScale*scale;y=viewport.clientHeight/2-g.centerY*renderScale*scale;draw()}};const searchable=[...data.provinces,...data.states,...data.strategicRegions].map(value=>({...value,search:[String(value.id),value.name.key,value.name.displayName,...value.name.values.map(item=>item.value)].join(' ').toLocaleLowerCase('en-US')}));const message=(text)=>Object.assign(document.createElement('span'),{className:'muted',textContent:text});const updateSearch=()=>{const query=search.value.trim().toLocaleLowerCase('en-US'),filter=kind.value;if(!query){results.replaceChildren(message('Search by ID or name.'));return}const matches=searchable.filter(value=>(filter==='all'||value.kind===filter)&&value.search.includes(query)).slice(0,100);results.replaceChildren(...matches.map(value=>{const button=document.createElement('button'),label=document.createElement('span');button.type='button';button.className='result';label.className='kind';label.textContent=value.kind;button.replaceChildren(label,document.createTextNode(' '+value.id+' — '+value.name.displayName));button.onclick=()=>show(value.kind,value.id);return button}),...(matches.length?[]:[message('No matches.')]))};const point=(event)=>{const bounds=viewport.getBoundingClientRect();const imageX=(event.clientX-bounds.left-x)/scale/renderScale,imageY=(event.clientY-bounds.top-y)/scale/renderScale;return{x:Math.floor(imageX),y:Math.floor(imageY)}};const provinceAt=(point)=>{if(!hitContext||point.x<0||point.y<0||point.x>=canvas.width||point.y>=canvas.height)return null;const pixel=hitContext.getImageData(point.x,point.y,1,1).data;const encoded=(pixel[0]<<16)|(pixel[1]<<8)|pixel[2];return encoded===0?null:encoded-1};hit.onload=()=>{canvas.width=hit.naturalWidth;canvas.height=hit.naturalHeight;hitContext=canvas.getContext('2d',{willReadFrequently:true});hitContext.drawImage(hit,0,0)};search.oninput=updateSearch;kind.onchange=updateSearch;document.getElementById('in').onclick=()=>zoom(1.25);document.getElementById('out').onclick=()=>zoom(.8);document.getElementById('fit').onclick=fit;viewport.addEventListener('wheel',event=>{event.preventDefault();const bounds=viewport.getBoundingClientRect();zoom(event.deltaY<0?1.15:.87,event.clientX-bounds.left,event.clientY-bounds.top)},{passive:false});image.addEventListener('pointerdown',event=>{drag=true;moved=false;lastX=event.clientX;lastY=event.clientY;image.setPointerCapture(event.pointerId);image.classList.add('dragging')});image.addEventListener('pointermove',event=>{const p=point(event),provinceId=provinceAt(p),province=provinceId===null?null:provinces.get(provinceId);cursor.textContent='pixel '+p.x+','+p.y+' | map '+p.x+','+(data.height-1-p.y)+(province?' | province '+province.id+' '+province.name.displayName+' | state '+province.stateIds.join(',')+' | region '+province.regionIds.join(','):'');if(!drag)return;const dx=event.clientX-lastX,dy=event.clientY-lastY;if(Math.abs(dx)+Math.abs(dy)>2)moved=true;x+=dx;y+=dy;lastX=event.clientX;lastY=event.clientY;draw()});image.addEventListener('pointerup',event=>{drag=false;image.classList.remove('dragging');if(!moved){const provinceId=provinceAt(point(event));if(provinceId!==null)show('province',provinceId)}});image.onload=fit;window.addEventListener('resize',fit);draw()})();</script></body></html>`;
}

function diffHtmlDocument(title: string, png: Buffer, json: string): string {
  const escapedTitle = title
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const escapedJson = json.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle}</title><style>html{background:#10151b;color:#edf2f7;font:14px system-ui}body{margin:20px}.viewport{height:70vh;overflow:auto;border:1px solid #48515c;background:#080b0f}.viewport img{image-rendering:pixelated;max-width:none}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${escapedTitle}</h1><div class="viewport"><img alt="${escapedTitle}" src="data:image/png;base64,${png.toString('base64')}"></div><details><summary>Diff metadata</summary><pre>${escapedJson}</pre></details></body></html>`;
}

async function encodeProvinceHitMap(index: MapWorkspaceIndex): Promise<Buffer> {
  const raster = index.raster;
  if (raster === undefined)
    throw new ServiceError(
      'MAP_RENDER_RASTER_MISSING',
      'Cannot build a province hit map without a valid province raster',
    );
  const raw = Buffer.alloc(raster.width * raster.height * 3);
  for (let offset = 0; offset < raster.provinceIds.length; offset += 1) {
    const encoded = (raster.provinceIds[offset] ?? -1) + 1;
    const target = offset * 3;
    raw[target] = (encoded >> 16) & 255;
    raw[target + 1] = (encoded >> 8) & 255;
    raw[target + 2] = encoded & 255;
  }
  return sharp(raw, {
    raw: { width: raster.width, height: raster.height, channels: 3 },
    limitInputPixels: RENDER_MAX_PIXELS,
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
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
  const provinceHitMap = await encodeProvinceHitMap(index);
  const html = htmlDocument(
    `HOI4 map - ${resolved.layer}`,
    png,
    provinceHitMap,
    json,
    resolved.scale,
  );
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
    renderer: 'hoi4-agent-tools-map-diff',
    changedBounds: changedBounds ?? null,
    changedProvinceIds: [...changedProvinceIds].sort((a, b) => a - b),
    semantic,
    ...(options.review === undefined ? {} : { review: options.review }),
  };
  const json = `${canonicalJson(metadata)}\n`;
  const html = diffHtmlDocument('HOI4 map pixel and semantic diff', png, json);
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
