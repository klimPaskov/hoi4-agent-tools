import type { Diagnostic } from '../../src/hoi4_agent_tools/core/diagnostics.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import { indexWithProposedChanges } from '../../src/hoi4_agent_tools/map/operations.js';
import type { ReferenceWorldRaster } from '../../src/hoi4_agent_tools/map/reference-world.js';
import { validateMap } from '../../src/hoi4_agent_tools/map/validation.js';
import {
  generateWorld,
  type GeneratedWorld,
  type WorldContext,
  type WorldSpec,
} from '../../src/hoi4_agent_tools/map/world.js';

export const APPEARANCE_CODE =
  /^MAP_(RIVER|TERRAIN_BITMAP|HEIGHT|TREES|COLORMAP|WATER|NORMAL|CITIES|LAKE|EDGE|SEAM|POLAR)_/u;

export const plainContext: WorldContext = {
  palettes: {},
  mapRoot: 'map',
  statesRoot: 'history/states',
  localisationRoot: 'localisation',
};

export interface SyntheticLand {
  /** Return 0 sea, 1 land or 2 lake for a pixel. */
  at: (x: number, y: number) => 0 | 1 | 2;
  /** Reference terrain code (0 plains, 1 forest, 2 desert, 3 mountain, 4 snow, ...). */
  terrain?: (x: number, y: number) => number;
}

/** A reference raster built from a function; no picture or game data is involved. */
export function syntheticRaster(
  width: number,
  height: number,
  land: SyntheticLand,
): ReferenceWorldRaster {
  const surface: ReferenceWorldRaster = {
    width,
    height,
    sourceWidth: width,
    sourceHeight: height,
    referenceBounds: { x: 0, y: 0, width, height },
    kind: new Uint8Array(width * height),
    terrain: new Uint8Array(width * height),
    elevation: new Float32Array(width * height).fill(-0.15),
    moisture: new Float32Array(width * height).fill(0.5),
    country: new Uint16Array(width * height),
    rivers: [],
    diagnostics: [],
    inferredCountries: [],
  };
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const kind = land.at(x, y);
      surface.kind[pixel] = kind;
      surface.terrain[pixel] = land.terrain?.(x, y) ?? 0;
      surface.elevation[pixel] = kind === 1 ? 0.1 : kind === 2 ? -0.02 : -0.15;
      surface.moisture[pixel] = 0.3 + (0.4 * ((x * 7 + y * 13) % 17)) / 16;
    }
  return surface;
}

export function worldSpec(
  surface: ReferenceWorldRaster,
  overrides: Partial<WorldSpec> = {},
): WorldSpec {
  return {
    width: surface.width,
    height: surface.height,
    seed: 11,
    landCoverage: 0.4,
    continents: 1,
    landProvincePixels: 250,
    seaProvincePixels: 800,
    provincesPerState: 5,
    landProvincesPerRegion: 20,
    seaProvincesPerRegion: 10,
    rivers: 0,
    startDate: '1936.1.1',
    countries: [{ tag: 'AAA', name: 'Alpha' }],
    referenceSurface: surface,
    ...overrides,
  };
}

/** One continent with a lake of the given radius, and the sea around. */
export function lakeWorld(
  width = 256,
  height = 256,
  overrides: Partial<WorldSpec> = {},
  lakeRadius = 24,
): GeneratedWorld {
  const surface = syntheticRaster(width, height, {
    at: (x, y) => {
      if (Math.hypot(x - width / 2, y - height / 2) <= lakeRadius) return 2;
      return x > width * 0.15 && x < width * 0.85 && y > height * 0.15 && y < height * 0.85 ? 1 : 0;
    },
    terrain: (x) => (x < width / 2 ? 0 : 1),
  });
  return generateWorld(worldSpec(surface, overrides), plainContext);
}

export function filesOf(world: GeneratedWorld): Map<string, Buffer> {
  return new Map(world.files.map((file) => [file.relativePath, Buffer.from(file.content)]));
}

export function indexOfFiles(files: ReadonlyMap<string, Buffer>): MapWorkspaceIndex {
  return indexWithProposedChanges(
    MapWorkspaceIndex.build([]),
    [...files].map(([relativePath, content]) => ({ relativePath, content })),
  );
}

export function appearanceDiagnostics(
  files: ReadonlyMap<string, Buffer>,
  edgeMode?: 'sea-band' | 'rim' | 'none',
): Diagnostic[] {
  return validateMap(
    indexOfFiles(files),
    edgeMode === undefined ? {} : { edgeMode },
  ).diagnostics.filter(({ code }) => APPEARANCE_CODE.test(code));
}
