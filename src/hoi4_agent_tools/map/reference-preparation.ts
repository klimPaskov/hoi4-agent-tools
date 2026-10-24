import {
  readReferenceImageSource,
  type ReferenceImageSource,
  type ReferenceWorkingSize,
} from '../core/bounded-source.js';
import type { WorkspaceResolver } from '../core/workspace.js';
import { extractReferenceLabels } from './reference-labels.js';
import { extractReferenceWorld } from './reference-world.js';
import type { CreateWorldOperation, PreparedReferenceWorld } from './operations.js';
import type { WorldCountry } from './world.js';
import { ServiceError } from '../core/result.js';

export interface LoadedReferenceWorld {
  prepared: PreparedReferenceWorld;
  images: ReferenceImageSource[];
}

/** Analyze only bounded, authorized sources; the transaction retains the original source hashes. */
export async function prepareReferenceWorld(
  resolver: WorkspaceResolver,
  workspaceId: string,
  operation: CreateWorldOperation,
  principal?: string,
  signal?: AbortSignal,
): Promise<LoadedReferenceWorld> {
  const reference = operation.reference;
  if (reference === undefined)
    throw new ServiceError('MAP_REFERENCE_REQUIRED', 'Reference preparation requires imagePath');
  const frame = reference.fit === 'frame';
  const exact = reference.paletteMatch === 'exact';
  if (frame && (operation.width === undefined || operation.height === undefined))
    throw new ServiceError(
      'MAP_REFERENCE_FRAME_SIZE_REQUIRED',
      'A reference fitted to the frame needs explicit width and height',
    );
  // A frame-fitted picture keeps the frame's resolution instead of the default 3,072-pixel
  // working copy; an exact palette is never resampled between colours.
  const working: ReferenceWorkingSize | undefined = frame
    ? {
        size: (originalWidth, originalHeight) => {
          const cropWidth = reference.crop?.width ?? originalWidth;
          const cropHeight = reference.crop?.height ?? originalHeight;
          return {
            width: Math.ceil((originalWidth * operation.width!) / cropWidth),
            height: Math.ceil((originalHeight * operation.height!) / cropHeight),
          };
        },
        kernel: exact ? 'nearest' : 'area',
      }
    : undefined;
  const images: ReferenceImageSource[] = [];
  const load = async (relativePath: string) => {
    const image = await readReferenceImageSource(
      resolver,
      workspaceId,
      relativePath,
      principal,
      signal,
      working,
    );
    images.push(image);
    return image;
  };
  const main = await load(reference.imagePath);
  if (frame) {
    const sourceAspect =
      (reference.crop?.width ?? main.originalWidth) /
      (reference.crop?.height ?? main.originalHeight);
    const frameAspect = operation.width! / operation.height!;
    if (Math.abs(sourceAspect - frameAspect) > frameAspect * 0.01)
      throw new ServiceError(
        'MAP_REFERENCE_FRAME_ASPECT',
        `The reference (${reference.crop?.width ?? main.originalWidth} x ${reference.crop?.height ?? main.originalHeight}) does not have the frame's shape (${operation.width} x ${operation.height}); fitting it would distort the map. Crop or resize the picture, or use the default fit.`,
        {
          sourceWidth: reference.crop?.width ?? main.originalWidth,
          sourceHeight: reference.crop?.height ?? main.originalHeight,
          width: operation.width,
          height: operation.height,
        },
      );
  }
  if (
    reference.crop !== undefined &&
    (reference.crop.x + reference.crop.width > main.originalWidth ||
      reference.crop.y + reference.crop.height > main.originalHeight)
  )
    throw new ServiceError(
      'MAP_REFERENCE_CROP_BLOCKED',
      'Reference crop exceeds the original image bounds',
    );
  const political =
    reference.politicalImagePath === undefined
      ? undefined
      : await load(reference.politicalImagePath);
  const terrain =
    reference.terrainImagePath === undefined ? undefined : await load(reference.terrainImagePath);
  const height =
    reference.heightImagePath === undefined ? undefined : await load(reference.heightImagePath);
  const crop =
    reference.crop === undefined
      ? undefined
      : {
          x: Math.floor((reference.crop.x * main.workingWidth) / main.originalWidth),
          y: Math.floor((reference.crop.y * main.workingHeight) / main.originalHeight),
          width: Math.max(
            1,
            Math.round((reference.crop.width * main.workingWidth) / main.originalWidth),
          ),
          height: Math.max(
            1,
            Math.round((reference.crop.height * main.workingHeight) / main.originalHeight),
          ),
        };
  // Text recognition masks labels out of heuristic classification; an exact palette has none.
  const text = exact ? { labels: [], warnings: [] } : await extractReferenceLabels(main.bytes);
  signal?.throwIfAborted();
  const textMasks = text.labels
    .slice(0, Math.max(0, 256 - (reference.ignoreMasks?.length ?? 0)))
    .map((label) => {
      const left = Math.max(0, label.x - label.width / 2 - 3 / main.workingWidth),
        right = Math.min(1, label.x + label.width / 2 + 3 / main.workingWidth);
      const top = Math.max(0, label.y - label.height / 2 - 3 / main.workingHeight),
        bottom = Math.min(1, label.y + label.height / 2 + 3 / main.workingHeight);
      return [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ];
    });
  const surface = await extractReferenceWorld(main.bytes, {
    width: operation.width ?? 5_632,
    height: operation.height ?? 2_048,
    seed: operation.seed ?? 1,
    ...(reference.mode === undefined ? {} : { mode: reference.mode }),
    ...(crop === undefined ? {} : { crop }),
    ignoreMasks: [...(reference.ignoreMasks ?? []), ...textMasks],
    ...(reference.annotations === undefined ? {} : { annotations: reference.annotations }),
    ...(reference.riverAnnotations === undefined
      ? {}
      : { riverAnnotations: reference.riverAnnotations }),
    ...(reference.palette === undefined ? {} : { palette: reference.palette }),
    ...(frame ? { fit: 'stretch' as const } : {}),
    ...(exact ? { paletteMatch: 'exact' as const } : {}),
    ...(reference.coastDetail === undefined ? {} : { coastDetail: reference.coastDetail }),
    ...(political === undefined ? {} : { politicalImageBytes: political.bytes }),
    ...(terrain === undefined ? {} : { terrainImageBytes: terrain.bytes }),
    ...(height === undefined ? {} : { heightImageBytes: height.bytes }),
  });
  signal?.throwIfAborted();
  const warnings = [
    ...surface.diagnostics,
    ...text.warnings,
    'Reference interpretation uses visual heuristics. Terrain, borders, labels and generated demographic values are approximations; review the offline previews.',
    ...(textMasks.length === 0
      ? []
      : [
          'Recognized text bounds are excluded from terrain classification; nearby coastlines may need review.',
        ]),
  ];
  const toTarget = (x: number, y: number) => ({
    x:
      ((x * main.workingWidth - (crop?.x ?? 0)) / (crop?.width ?? main.workingWidth)) *
        surface.referenceBounds.width +
      surface.referenceBounds.x,
    y:
      ((y * main.workingHeight - (crop?.y ?? 0)) / (crop?.height ?? main.workingHeight)) *
        surface.referenceBounds.height +
      surface.referenceBounds.y,
  });
  const nearestLand = (x: number, y: number) => {
    const cx = Math.round(x),
      cy = Math.round(y);
    const radius = Math.max(2, Math.round(Math.min(surface.width, surface.height) * 0.02));
    let best: { x: number; y: number; distance: number } | undefined;
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const px = cx + dx,
          py = cy + dy,
          distance = dx * dx + dy * dy;
        if (
          px < 0 ||
          py < 0 ||
          px >= surface.width ||
          py >= surface.height ||
          surface.kind[py * surface.width + px] !== 1
        )
          continue;
        if (best === undefined || distance < best.distance) best = { x: px, y: py, distance };
      }
    return best;
  };
  const reviewedLabels: PreparedReferenceWorld['labels'] = (reference.labels ?? []).map(
    (label) => ({ ...label, ...toTarget(label.x, label.y) }),
  );
  const nearReviewed = (point: { x: number; y: number }) =>
    reviewedLabels.some(
      (reviewed) =>
        Math.hypot(reviewed.x - point.x, reviewed.y - point.y) <
        Math.min(surface.width, surface.height) * 0.025,
    );
  // An explicit review is authoritative, including an empty list. OCR still helps mask ink,
  // but must not reintroduce discarded or uncertain names outside the supplied label set.
  const automaticText = reference.labels === undefined ? text.labels : [];
  const labels = automaticText
    .filter(
      ({ text: label }) =>
        !/\b(?:map|world|sea|ocean|bay|strait|channel|flow|belt|signature|north|south|east|west|compass)\b/iu.test(
          label,
        ),
    )
    .slice(0, 200)
    .flatMap((label) => {
      const point = toTarget(label.x, label.y);
      const land = nearestLand(point.x, point.y);
      return land === undefined ? [] : [{ name: label.text, x: land.x, y: land.y }];
    });
  const reviewedCountries = reviewedLabels.filter((label) => label.kind === 'country');
  const countryNames = [...reviewedCountries, ...labels.filter((label) => !nearReviewed(label))];
  const defaults = ['Aster', 'Brum', 'Corvel', 'Doran', 'Evin', 'Faron', 'Galen', 'Haven'];
  const politicalRegionAt = (point: { x: number; y: number }): number | undefined => {
    const x = Math.floor(point.x),
      y = Math.floor(point.y);
    if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return undefined;
    const pixel = y * surface.width + x;
    if (surface.kind[pixel] !== 1) return undefined;
    const id = surface.country[pixel];
    return id === 0 ? undefined : id;
  };
  let countries: WorldCountry[];
  if (operation.countries !== undefined) countries = operation.countries;
  else if (surface.inferredCountries.length > 1) {
    countries = surface.inferredCountries.slice(0, 200).map((country, index) => ({
      tag: `X${(index + 1).toString(36).toUpperCase().padStart(2, '0')}`,
      name: country.name,
      color: country.color,
    }));
    const centres = new Map<number, { x: number; y: number; n: number }>();
    for (let pixel = 0; pixel < surface.country.length; pixel++) {
      const id = surface.country[pixel]!;
      if (id === 0) continue;
      const centre = centres.get(id) ?? { x: 0, y: 0, n: 0 };
      centre.x += pixel % surface.width;
      centre.y += Math.floor(pixel / surface.width);
      centre.n++;
      centres.set(id, centre);
    }
    const used = new Set<string>();
    for (const [index, country] of countries.entries()) {
      const regionId = surface.inferredCountries[index]!.id;
      const centre = centres.get(regionId);
      if (centre === undefined) continue;
      const label = countryNames
        .filter((label) => !used.has(label.name) && politicalRegionAt(label) === regionId)
        .sort(
          (a, b) =>
            Math.hypot(a.x - centre.x / centre.n, a.y - centre.y / centre.n) -
            Math.hypot(b.x - centre.x / centre.n, b.y - centre.y / centre.n),
        )[0];
      if (label !== undefined) {
        country.name = label.name;
        used.add(label.name);
      } else
        warnings.push(
          `Political region ${regionId} had no reliable name label within its borders; ${country.name} was retained.`,
        );
    }
    warnings.push(
      'Flat political colors define inferred countries; text within each region is an uncertain country-name candidate.',
    );
  } else {
    const count = reviewedCountries.length || Math.max(4, Math.min(8, countryNames.length || 4));
    countries = Array.from({ length: count }, (_, index) => ({
      tag: `X${(index + 1).toString(36).toUpperCase().padStart(2, '0')}`,
      name: countryNames[index]?.name ?? defaults[index]!,
    }));
    warnings.push(
      'Political borders were not reliably encoded; generated countries and ownership use deterministic defaults.',
    );
  }
  const automaticLabels: PreparedReferenceWorld['labels'] = automaticText
    .filter(
      ({ text: label }) =>
        !/\b(?:map|world|signature|compass|north|south|east|west|flow|belt)\b/iu.test(label),
    )
    .map((label) => ({
      ...toTarget(label.x, label.y),
      name: label.text,
      kind: /\b(?:sea|ocean|bay|strait|channel)\b/iu.test(label.text)
        ? 'sea'
        : /\b(?:mountain|mountains|range)\b/iu.test(label.text)
          ? 'mountain'
          : 'city',
    }));
  const geographicLabels = [
    ...reviewedLabels,
    ...automaticLabels.filter(
      (label) =>
        !reviewedLabels.some(
          (reviewed) =>
            Math.hypot(reviewed.x - label.x, reviewed.y - label.y) <
            Math.min(surface.width, surface.height) * 0.025,
        ),
    ),
  ].slice(0, 2048);
  const cityInputs =
    reference.cities === undefined
      ? geographicLabels
          .filter((label) => label.kind === 'city')
          .map(({ name, x, y }) => ({ name, x, y }))
      : reference.cities.map((city) => ({ ...city, ...toTarget(city.x, city.y) }));
  const cities: PreparedReferenceWorld['cities'] = cityInputs.flatMap((city) => {
    if (
      'countryTag' in city &&
      city.countryTag !== undefined &&
      !countries.some((country) => country.tag === city.countryTag)
    )
      throw new ServiceError(
        'MAP_REFERENCE_CITY_COUNTRY_INVALID',
        'City countryTag must name a generated country',
      );
    const land = nearestLand(city.x, city.y);
    if (land === undefined) {
      warnings.push(`City ${city.name} is outside nearby land and was omitted.`);
      return [];
    }
    return [{ ...city, x: land.x, y: land.y }];
  });
  for (const [index, country] of countries.entries()) {
    let candidates = cities;
    if (surface.inferredCountries.length > 1) {
      const color = country.color;
      const matches =
        color === undefined
          ? []
          : surface.inferredCountries
              .map((region) => ({
                id: region.id,
                distance:
                  (region.color.r - color.r) ** 2 +
                  (region.color.g - color.g) ** 2 +
                  (region.color.b - color.b) ** 2,
              }))
              .sort((a, b) => a.distance - b.distance || a.id - b.id);
      const regionId =
        matches[0] !== undefined &&
        matches[0].distance <= 3 * 24 ** 2 &&
        (matches[1] === undefined || matches[0].distance < matches[1].distance)
          ? matches[0].id
          : undefined;
      if (regionId === undefined) continue;
      candidates = cities.filter(
        (city) => city.countryTag === undefined && politicalRegionAt(city) === regionId,
      );
    }
    const city =
      candidates.find(({ name }) => name === country.name) ??
      (surface.inferredCountries.length > 1 ? candidates[0] : candidates[index]);
    if (city !== undefined && city.countryTag === undefined) city.countryTag = country.tag;
  }
  return {
    prepared: {
      surface,
      countries,
      cities,
      labels: geographicLabels,
      diagnostics: [...new Set(warnings)],
    },
    images,
  };
}
