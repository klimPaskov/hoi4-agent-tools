import { compareCodeUnits } from '../core/canonical.js';
import { nodeLocation } from '../core/source/parser.js';
import type { IndexedMapLocalisationEntry, MapWorkspaceIndex, ProvinceGeometry } from './model.js';

export interface MapLocalisedValue {
  language: string;
  value: string;
  sourcePath: string;
  line: number;
}

export interface MapResolvedName {
  key: string;
  displayName: string;
  values: MapLocalisedValue[];
}

export interface MapCatalogGeometry extends Omit<ProvinceGeometry, 'id'> {
  mapX: number;
  mapZ: number;
}

export interface MapCatalogProvince {
  kind: 'province';
  id: number;
  name: MapResolvedName;
  definition: {
    color: { r: number; g: number; b: number };
    type: string;
    coastal: boolean;
    terrain: string;
    continent: number;
    sourcePath: string;
    line: number;
  };
  geometry: MapCatalogGeometry | null;
  stateIds: number[];
  regionIds: number[];
  neighborProvinceIds: number[];
  victoryPoints: { stateId: number; value: number }[];
  provinceBuildings: { stateId: number; buildings: Record<string, number> }[];
  port: {
    stateId: number;
    level: number;
    coastal: boolean;
    adjacentSeaProvinceIds: number[];
  } | null;
  supplyNodeLevels: number[];
  railwayOrdinals: number[];
  specialAdjacencyOrdinals: number[];
  buildingPositionOrdinals: number[];
  unitPositionOrdinals: number[];
}

export interface MapCatalogState {
  kind: 'state';
  id: number;
  name: MapResolvedName;
  geometry: MapCatalogGeometry | null;
  capital: number | null;
  manpower: number;
  category: string;
  provinceIds: number[];
  regionIds: number[];
  resources: Record<string, number>;
  owner: string | null;
  controller: string | null;
  cores: string[];
  claims: string[];
  victoryPoints: { provinceId: number; value: number }[];
  stateBuildings: Record<string, number>;
  provinceBuildings: Record<string, Record<string, number>>;
  sourcePath: string;
  sourceLine: number;
}

export interface MapCatalogRegion {
  kind: 'strategic-region';
  id: number;
  name: MapResolvedName;
  geometry: MapCatalogGeometry | null;
  provinceIds: number[];
  stateIds: number[];
  navalTerrain: string | null;
  sourcePath: string;
  sourceLine: number;
}

export interface MapCatalog {
  schemaVersion: 2;
  dimensions: { width: number; height: number };
  coordinateSystems: {
    pixel: { origin: 'top-left'; xDirection: 'right'; yDirection: 'down' };
    map: { origin: 'bottom-left'; xDirection: 'right'; zDirection: 'up' };
  };
  counts: {
    provinces: number;
    states: number;
    strategicRegions: number;
    normalAdjacencies: number;
    specialAdjacencies: number;
    supplyNodes: number;
    railways: number;
    ports: number;
    victoryPoints: number;
    buildingPositions: number;
    unitPositions: number;
    weatherPositions: number;
    entityLocators: number;
  };
  provinces: MapCatalogProvince[];
  states: MapCatalogState[];
  strategicRegions: MapCatalogRegion[];
  normalAdjacencies: { from: number; to: number }[];
  specialAdjacencies: {
    ordinal: number;
    from: number;
    to: number;
    type: string;
    through: number;
    startX: number;
    startY: number;
    stopX: number;
    stopY: number;
    rule: string;
    comment: string;
    sourcePath: string;
    line: number;
  }[];
  supplyNodes: {
    ordinal: number;
    level: number;
    provinceId: number;
    sourcePath: string;
    line: number;
  }[];
  railways: {
    ordinal: number;
    level: number;
    declaredCount: number;
    provinceIds: number[];
    sourcePath: string;
    line: number;
  }[];
  ports: {
    stateId: number;
    provinceId: number;
    level: number;
    coastal: boolean;
    adjacentSeaProvinceIds: number[];
  }[];
  victoryPoints: { stateId: number; provinceId: number; value: number }[];
  buildingPositions: {
    ordinal: number;
    stateId: number;
    building: string;
    x: number;
    y: number;
    z: number;
    rotation: number;
    adjacentSeaProvince: number;
    sourcePath: string;
    line: number;
  }[];
  unitPositions: {
    ordinal: number;
    provinceId: number;
    type: number;
    x: number;
    y: number;
    z: number;
    rotation: number;
    offset: number;
    sourcePath: string;
    line: number;
  }[];
  weatherPositions: {
    ordinal: number;
    strategicRegionId: number;
    x: number;
    y: number;
    z: number;
    size: string;
    sourcePath: string;
    line: number;
  }[];
  entityLocators: {
    entity: string;
    name: string;
    position: number[];
    sourcePath: string;
  }[];
}

export interface MapCatalogSearchResult {
  kind: 'province' | 'state' | 'strategic-region';
  id: number;
  key: string;
  displayName: string;
  geometry: MapCatalogGeometry | null;
  score: number;
}

export interface MapCoordinateLookup {
  coordinate: { kind: 'pixel'; x: number; y: number } | { kind: 'map'; x: number; z: number };
  pixel: { x: number; y: number } | null;
  provinceId: number | null;
  stateIds: number[];
  regionIds: number[];
}

function localisedValues(entries: readonly IndexedMapLocalisationEntry[]): MapLocalisedValue[] {
  return entries
    .map(({ file, entry }) => ({
      language: entry.language,
      value: entry.value,
      sourcePath: file.displayPath,
      line: entry.line,
      loadOrder: file.loadOrder,
    }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.language, right.language) ||
        left.loadOrder - right.loadOrder ||
        compareCodeUnits(left.sourcePath, right.sourcePath) ||
        left.line - right.line,
    )
    .map(({ loadOrder: _loadOrder, ...value }) => value);
}

function resolvedName(
  entriesByKey: ReadonlyMap<string, readonly IndexedMapLocalisationEntry[]>,
  keys: readonly string[],
  fallback: string,
): MapResolvedName {
  for (const key of keys) {
    const values = localisedValues(entriesByKey.get(key) ?? []);
    if (values.length === 0) continue;
    const english = values.filter(({ language }) => language === 'l_english').at(-1);
    return { key, displayName: english?.value ?? values.at(-1)?.value ?? fallback, values };
  }
  const key = keys[0] ?? fallback;
  return { key, displayName: fallback, values: [] };
}

function aggregateGeometry(
  index: MapWorkspaceIndex,
  provinceIds: readonly number[],
): MapCatalogGeometry | null {
  const geometries = provinceIds.flatMap((id) => {
    const geometry = index.raster?.geometry.get(id);
    return geometry === undefined ? [] : [geometry];
  });
  if (geometries.length === 0 || index.raster === undefined) return null;
  const pixelCount = geometries.reduce((total, { pixelCount: count }) => total + count, 0);
  if (pixelCount <= 0) return null;
  const centerX =
    geometries.reduce((total, geometry) => total + geometry.centerX * geometry.pixelCount, 0) /
    pixelCount;
  const centerY =
    geometries.reduce((total, geometry) => total + geometry.centerY * geometry.pixelCount, 0) /
    pixelCount;
  return {
    pixelCount,
    minX: geometries.reduce((value, geometry) => Math.min(value, geometry.minX), Infinity),
    minY: geometries.reduce((value, geometry) => Math.min(value, geometry.minY), Infinity),
    maxX: geometries.reduce((value, geometry) => Math.max(value, geometry.maxX), -Infinity),
    maxY: geometries.reduce((value, geometry) => Math.max(value, geometry.maxY), -Infinity),
    centerX,
    centerY,
    mapX: centerX,
    mapZ: index.raster.height - 1 - centerY,
  };
}

function sortedObject(values: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...values].sort(([left], [right]) => compareCodeUnits(left, right)));
}

export function buildMapCatalog(index: MapWorkspaceIndex): MapCatalog {
  const raster = index.raster;
  const width = raster?.width ?? 0;
  const height = raster?.height ?? 0;
  const localisationEntriesByKey = new Map<string, IndexedMapLocalisationEntry[]>();
  for (const entry of index.localisationEntries) {
    const values = localisationEntriesByKey.get(entry.entry.key) ?? [];
    values.push(entry);
    localisationEntriesByKey.set(entry.entry.key, values);
  }
  const portsByProvince = new Map(index.ports.map((port) => [port.provinceId, port]));
  const supplyNodeLevelsByProvince = new Map<number, number[]>();
  for (const node of index.supplyNodes) {
    const levels = supplyNodeLevelsByProvince.get(node.provinceId) ?? [];
    levels.push(node.level);
    supplyNodeLevelsByProvince.set(node.provinceId, levels);
  }
  const buildingPositionsByProvince = new Map<number, number[]>();
  for (const [ordinal, position] of index.buildingPositions.entries()) {
    const provinceId = index.provinceAtMapCoordinate(position.x, position.z);
    if (provinceId === undefined) continue;
    const ordinals = buildingPositionsByProvince.get(provinceId) ?? [];
    ordinals.push(ordinal);
    buildingPositionsByProvince.set(provinceId, ordinals);
  }
  const unitPositionsByProvince = new Map<number, number[]>();
  for (const [ordinal, position] of index.unitPositions.entries()) {
    const ordinals = unitPositionsByProvince.get(position.provinceId) ?? [];
    ordinals.push(ordinal);
    unitPositionsByProvince.set(position.provinceId, ordinals);
  }
  const railwayOrdinalsByProvince = new Map<number, number[]>();
  for (const [ordinal, railway] of index.railways.entries()) {
    for (const provinceId of new Set(railway.provinces)) {
      const ordinals = railwayOrdinalsByProvince.get(provinceId) ?? [];
      ordinals.push(ordinal);
      railwayOrdinalsByProvince.set(provinceId, ordinals);
    }
  }
  const specialAdjacencyOrdinalsByProvince = new Map<number, number[]>();
  for (const [ordinal, adjacency] of index.adjacencies.entries()) {
    for (const provinceId of new Set([adjacency.from, adjacency.to, adjacency.through])) {
      if (provinceId < 0) continue;
      const ordinals = specialAdjacencyOrdinalsByProvince.get(provinceId) ?? [];
      ordinals.push(ordinal);
      specialAdjacencyOrdinalsByProvince.set(provinceId, ordinals);
    }
  }
  const provinces: MapCatalogProvince[] = [...index.definitions]
    .sort((left, right) => left.id - right.id)
    .map((definition) => {
      const id = definition.id;
      const port = portsByProvince.get(id);
      return {
        kind: 'province',
        id,
        name: resolvedName(
          localisationEntriesByKey,
          [`PROV${id}`, `VICTORY_POINTS_${id}`],
          `Province ${id}`,
        ),
        definition: {
          color: definition.color,
          type: definition.type,
          coastal: definition.coastal,
          terrain: definition.terrain,
          continent: definition.continent,
          sourcePath: definition.document.file.displayPath,
          line: definition.line,
        },
        geometry: aggregateGeometry(index, [id]),
        stateIds: index.stateForProvince(id).map(({ id: stateId }) => stateId),
        regionIds: index.regionForProvince(id).map(({ id: regionId }) => regionId),
        neighborProvinceIds: [...(raster?.adjacency.get(id) ?? [])].sort((a, b) => a - b),
        victoryPoints:
          index.victoryPointsByProvince
            .get(id)
            ?.map(({ stateId, value }) => ({ stateId, value })) ?? [],
        provinceBuildings:
          index.provinceBuildingsByProvince.get(id)?.map(({ stateId, buildings }) => ({
            stateId,
            buildings: sortedObject(buildings),
          })) ?? [],
        port:
          port === undefined
            ? null
            : {
                stateId: port.stateId,
                level: port.level,
                coastal: port.coastal,
                adjacentSeaProvinceIds: [...port.adjacentSeaProvinceIds],
              },
        supplyNodeLevels: supplyNodeLevelsByProvince.get(id) ?? [],
        railwayOrdinals: railwayOrdinalsByProvince.get(id) ?? [],
        specialAdjacencyOrdinals: specialAdjacencyOrdinalsByProvince.get(id) ?? [],
        buildingPositionOrdinals: buildingPositionsByProvince.get(id) ?? [],
        unitPositionOrdinals: unitPositionsByProvince.get(id) ?? [],
      };
    });
  const states: MapCatalogState[] = [...index.states]
    .sort((left, right) => left.id - right.id)
    .map((state) => ({
      kind: 'state',
      id: state.id,
      name: resolvedName(localisationEntriesByKey, [state.name], state.name),
      geometry: aggregateGeometry(index, state.provinces),
      capital: state.capital ?? null,
      manpower: state.manpower,
      category: state.category,
      provinceIds: [...state.provinces].sort((a, b) => a - b),
      regionIds: [
        ...new Set(
          state.provinces.flatMap((provinceId) =>
            index.regionForProvince(provinceId).map(({ id }) => id),
          ),
        ),
      ].sort((a, b) => a - b),
      resources: sortedObject(state.resources),
      owner: state.owner ?? null,
      controller: state.controller ?? null,
      cores: [...state.cores].sort(compareCodeUnits),
      claims: [...state.claims].sort(compareCodeUnits),
      victoryPoints: state.victoryPoints
        .map(({ provinceId, value }) => ({ provinceId, value }))
        .sort((left, right) => left.provinceId - right.provinceId || left.value - right.value),
      stateBuildings: sortedObject(state.stateBuildings),
      provinceBuildings: Object.fromEntries(
        [...state.provinceBuildings]
          .sort(([left], [right]) => left - right)
          .map(([provinceId, buildings]) => [String(provinceId), sortedObject(buildings)]),
      ),
      sourcePath: state.file.displayPath,
      sourceLine: nodeLocation(state.document, state.assignment).start.line,
    }));
  const strategicRegions: MapCatalogRegion[] = [...index.regions]
    .sort((left, right) => left.id - right.id)
    .map((region) => ({
      kind: 'strategic-region',
      id: region.id,
      name: resolvedName(localisationEntriesByKey, [region.name], region.name),
      geometry: aggregateGeometry(index, region.provinces),
      provinceIds: [...region.provinces].sort((a, b) => a - b),
      stateIds: [
        ...new Set(
          region.provinces.flatMap((provinceId) =>
            index.stateForProvince(provinceId).map(({ id }) => id),
          ),
        ),
      ].sort((a, b) => a - b),
      navalTerrain: region.navalTerrain ?? null,
      sourcePath: region.file.displayPath,
      sourceLine: nodeLocation(region.document, region.assignment).start.line,
    }));
  const normalAdjacencies = [...(raster?.adjacency ?? [])]
    .flatMap(([from, neighbors]) =>
      [...neighbors].flatMap((to) => (from < to ? [{ from, to }] : [])),
    )
    .sort((left, right) => left.from - right.from || left.to - right.to);
  return {
    schemaVersion: 2,
    dimensions: { width, height },
    coordinateSystems: {
      pixel: { origin: 'top-left', xDirection: 'right', yDirection: 'down' },
      map: { origin: 'bottom-left', xDirection: 'right', zDirection: 'up' },
    },
    counts: {
      provinces: provinces.length,
      states: states.length,
      strategicRegions: strategicRegions.length,
      normalAdjacencies: normalAdjacencies.length,
      specialAdjacencies: index.adjacencies.length,
      supplyNodes: index.supplyNodes.length,
      railways: index.railways.length,
      ports: index.ports.length,
      victoryPoints: [...index.victoryPointsByProvince.values()].reduce(
        (count, entries) => count + entries.length,
        0,
      ),
      buildingPositions: index.buildingPositions.length,
      unitPositions: index.unitPositions.length,
      weatherPositions: index.weatherPositions.length,
      entityLocators: index.entityLocators.length,
    },
    provinces,
    states,
    strategicRegions,
    normalAdjacencies,
    specialAdjacencies: index.adjacencies.map((adjacency, ordinal) => ({
      ordinal,
      from: adjacency.from,
      to: adjacency.to,
      type: adjacency.type,
      through: adjacency.through,
      startX: adjacency.startX,
      startY: adjacency.startY,
      stopX: adjacency.stopX,
      stopY: adjacency.stopY,
      rule: adjacency.rule,
      comment: adjacency.comment,
      sourcePath: adjacency.document.file.displayPath,
      line: adjacency.line,
    })),
    supplyNodes: index.supplyNodes.map((node, ordinal) => ({
      ordinal,
      level: node.level,
      provinceId: node.provinceId,
      sourcePath: node.document.file.displayPath,
      line: node.line,
    })),
    railways: index.railways.map((railway, ordinal) => ({
      ordinal,
      level: railway.level,
      declaredCount: railway.declaredCount,
      provinceIds: [...railway.provinces],
      sourcePath: railway.document.file.displayPath,
      line: railway.line,
    })),
    ports: index.ports.map(({ stateId, provinceId, level, coastal, adjacentSeaProvinceIds }) => ({
      stateId,
      provinceId,
      level,
      coastal,
      adjacentSeaProvinceIds: [...adjacentSeaProvinceIds].sort((left, right) => left - right),
    })),
    victoryPoints: [...index.victoryPointsByProvince.values()]
      .flatMap((entries) =>
        entries.map(({ stateId, provinceId, value }) => ({ stateId, provinceId, value })),
      )
      .sort(
        (left, right) =>
          left.stateId - right.stateId ||
          left.provinceId - right.provinceId ||
          left.value - right.value,
      ),
    buildingPositions: index.buildingPositions.map((position, ordinal) => ({
      ordinal,
      stateId: position.stateId,
      building: position.building,
      x: position.x,
      y: position.y,
      z: position.z,
      rotation: position.rotation,
      adjacentSeaProvince: position.adjacentSeaProvince,
      sourcePath: position.document.file.displayPath,
      line: position.line,
    })),
    unitPositions: index.unitPositions.map((position, ordinal) => ({
      ordinal,
      provinceId: position.provinceId,
      type: position.type,
      x: position.x,
      y: position.y,
      z: position.z,
      rotation: position.rotation,
      offset: position.offset,
      sourcePath: position.document.file.displayPath,
      line: position.line,
    })),
    weatherPositions: index.weatherPositions.map((position, ordinal) => ({
      ordinal,
      strategicRegionId: position.strategicRegionId,
      x: position.x,
      y: position.y,
      z: position.z,
      size: position.size,
      sourcePath: position.document.file.displayPath,
      line: position.line,
    })),
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
  };
}

function searchScore(
  query: string,
  id: number,
  key: string,
  displayName: string,
  alternatives: readonly string[],
): number | undefined {
  const idText = String(id);
  const normalizedKey = key.toLocaleLowerCase('en-US');
  const normalizedName = displayName.toLocaleLowerCase('en-US');
  const normalizedAlternatives = alternatives.map((value) => value.toLocaleLowerCase('en-US'));
  if (
    query === idText ||
    query === normalizedKey ||
    query === normalizedName ||
    normalizedAlternatives.includes(query)
  )
    return 0;
  if (
    idText.startsWith(query) ||
    normalizedKey.startsWith(query) ||
    normalizedName.startsWith(query) ||
    normalizedAlternatives.some((value) => value.startsWith(query))
  )
    return 1;
  if (
    normalizedKey.includes(query) ||
    normalizedName.includes(query) ||
    normalizedAlternatives.some((value) => value.includes(query))
  )
    return 2;
  return undefined;
}

export function searchMapCatalog(
  catalog: MapCatalog,
  query: string,
  limit = 100,
): MapCatalogSearchResult[] {
  const normalized = query.trim().toLocaleLowerCase('en-US');
  if (normalized === '') return [];
  const entries = [
    ...catalog.provinces.map(({ id, name, geometry }) => ({
      kind: 'province' as const,
      id,
      key: name.key,
      displayName: name.displayName,
      alternatives: name.values.map(({ value }) => value),
      geometry,
    })),
    ...catalog.states.map(({ id, name, geometry }) => ({
      kind: 'state' as const,
      id,
      key: name.key,
      displayName: name.displayName,
      alternatives: name.values.map(({ value }) => value),
      geometry,
    })),
    ...catalog.strategicRegions.map(({ id, name, geometry }) => ({
      kind: 'strategic-region' as const,
      id,
      key: name.key,
      displayName: name.displayName,
      alternatives: name.values.map(({ value }) => value),
      geometry,
    })),
  ];
  return entries
    .flatMap((entry): MapCatalogSearchResult[] => {
      const score = searchScore(
        normalized,
        entry.id,
        entry.key,
        entry.displayName,
        entry.alternatives,
      );
      if (score === undefined) return [];
      const { alternatives: _alternatives, ...result } = entry;
      return [{ ...result, score }];
    })
    .sort(
      (left, right) =>
        left.score - right.score || compareCodeUnits(left.kind, right.kind) || left.id - right.id,
    )
    .slice(0, Math.max(0, limit));
}

export function lookupMapCoordinate(
  index: MapWorkspaceIndex,
  coordinate: MapCoordinateLookup['coordinate'],
): MapCoordinateLookup {
  const raster = index.raster;
  const pixel =
    coordinate.kind === 'pixel'
      ? { x: Math.floor(coordinate.x), y: Math.floor(coordinate.y) }
      : raster === undefined
        ? null
        : { x: Math.floor(coordinate.x), y: raster.height - 1 - Math.floor(coordinate.z) };
  if (
    raster === undefined ||
    pixel === null ||
    pixel.x < 0 ||
    pixel.y < 0 ||
    pixel.x >= raster.width ||
    pixel.y >= raster.height
  ) {
    return { coordinate, pixel: null, provinceId: null, stateIds: [], regionIds: [] };
  }
  const provinceId = raster.provinceIds[pixel.y * raster.width + pixel.x] ?? -1;
  if (provinceId < 0) return { coordinate, pixel, provinceId: null, stateIds: [], regionIds: [] };
  return {
    coordinate,
    pixel,
    provinceId,
    stateIds: index.stateForProvince(provinceId).map(({ id }) => id),
    regionIds: index.regionForProvince(provinceId).map(({ id }) => id),
  };
}
