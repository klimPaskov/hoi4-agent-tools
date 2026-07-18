import { compareCodeUnits } from '../core/canonical.js';
import path from 'node:path';
import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';
import { sortDiagnostics } from '../core/diagnostics.js';
import type { SymbolIndex } from '../core/index.js';
import type { ScannedFile, WorkspaceScanner } from '../core/scanner.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import type { RenderBudget } from '../core/render-budget.js';
import { GuiAssetCatalog } from '../gui/assets.js';
import { buildGuiSourceGraph } from '../gui/source-graph.js';
import type { GuiSpriteDefinition } from '../gui/types.js';
import type {
  ContinuousFocusPalettePlan,
  FocusPresentationResolution,
  FocusResolvedIcon,
  FocusTreePlan,
} from './model.js';

export type FocusResolvedIconEvidence = Omit<FocusResolvedIcon, 'dataUri'>;

export interface FocusPresentationEvidence extends Omit<FocusPresentationResolution, 'icons'> {
  icons: Record<string, FocusResolvedIconEvidence>;
}

export function focusResolvedIconEvidence(icon: FocusResolvedIcon): FocusResolvedIconEvidence {
  return {
    sprite: icon.sprite,
    sourcePath: icon.sourcePath,
    texturePath: icon.texturePath,
    frame: icon.frame,
    frameCount: icon.frameCount,
    width: icon.width,
    height: icon.height,
    format: icon.format,
  };
}

export function focusPresentationEvidence(
  presentation: FocusPresentationResolution,
): FocusPresentationEvidence {
  return {
    ...presentation,
    icons: Object.fromEntries(
      Object.entries(presentation.icons)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([sprite, icon]) => [sprite, focusResolvedIconEvidence(icon)]),
    ),
  };
}

interface PresentationTarget {
  id: string;
  fallbackTitle: string;
  titleKey: string;
  descriptionKey: string;
  sprite?: string;
  iconLocation?: SourceLocation;
  sourceLocation?: SourceLocation;
}

export interface ResolveFocusPresentationInput {
  plans: readonly FocusTreePlan[];
  palettes?: readonly ContinuousFocusPalettePlan[];
  language?: string;
  files: readonly ScannedFile[];
  index: SymbolIndex;
  scanner: WorkspaceScanner;
  workspace: ResolvedWorkspace;
  /** Decode source textures only when a raster-capable caller needs embedded icon pixels. */
  decodeIcons?: boolean;
  budget?: RenderBudget;
  signal?: AbortSignal;
}

function presentationTargets(
  plans: readonly FocusTreePlan[],
  palettes: readonly ContinuousFocusPalettePlan[],
): PresentationTarget[] {
  return [
    ...plans.flatMap((plan) =>
      plan.focuses.map((focus) => ({
        id: focus.id,
        fallbackTitle: focus.localisation.workingLabel ?? focus.label,
        titleKey: focus.localisation.titleKey,
        descriptionKey: focus.localisation.descriptionKey,
        ...(focus.icons[0] === undefined ? {} : { sprite: focus.icons[0].sprite }),
        ...(focus.icons[0]?.sourceLocation === undefined
          ? {}
          : { iconLocation: focus.icons[0].sourceLocation }),
        ...(focus.sourceLocation === undefined ? {} : { sourceLocation: focus.sourceLocation }),
      })),
    ),
    ...palettes.flatMap((palette) =>
      palette.focuses.map((focus) => ({
        id: focus.id,
        fallbackTitle: focus.localisation.workingLabel ?? focus.id,
        titleKey: focus.localisation.titleKey,
        descriptionKey: focus.localisation.descriptionKey,
        ...(focus.icons[0] === undefined ? {} : { sprite: focus.icons[0].sprite }),
        ...(focus.icons[0]?.sourceLocation === undefined
          ? {}
          : { iconLocation: focus.icons[0].sourceLocation }),
        ...(focus.sourceLocation === undefined ? {} : { sourceLocation: focus.sourceLocation }),
      })),
    ),
  ].sort((left, right) => compareCodeUnits(left.id, right.id));
}

function safeExactAssetPath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/^\/+/, '');
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').some((segment) => segment === '..') ||
    /[*?[\]{}!]/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function relevantSprite(
  spriteName: string,
  graphSprites: readonly GuiSpriteDefinition[],
  index: SymbolIndex,
): GuiSpriteDefinition | undefined {
  const active = index.find('sprite', spriteName);
  return graphSprites.find(
    (sprite) =>
      sprite.name === spriteName && (active === undefined || sprite.sourcePath === active.path),
  );
}

function diagnosticLocation(target: PresentationTarget): { location?: SourceLocation } {
  return target.iconLocation === undefined
    ? target.sourceLocation === undefined
      ? {}
      : { location: target.sourceLocation }
    : { location: target.iconLocation };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  callback: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await callback(values[index]!);
      }
    }),
  );
  return results;
}

export async function resolveFocusPresentation(
  input: ResolveFocusPresentationInput,
): Promise<FocusPresentationResolution> {
  input.signal?.throwIfAborted();
  const language = input.language ?? 'l_english';
  const palettes = input.palettes ?? [];
  const targets = presentationTargets(input.plans, palettes);
  const spriteNames = [
    ...new Set(targets.flatMap(({ sprite }) => (sprite === undefined ? [] : [sprite]))),
  ];
  // Focus presentation needs sprite declarations, not the entire GUI, decision, and
  // localisation graph. Localised focus text is resolved directly through the shared index.
  const spriteSourcePaths = new Set(
    spriteNames.flatMap((spriteName) => {
      const symbol = input.index.find('sprite', spriteName);
      return symbol === undefined ? [] : [symbol.path];
    }),
  );
  const presentationFiles = input.files.filter(({ displayPath }) =>
    spriteSourcePaths.has(displayPath),
  );
  const baseGraph = buildGuiSourceGraph(presentationFiles, input.index);
  const texturePaths = new Set<string>();
  for (const spriteName of spriteNames) {
    const sprite = relevantSprite(spriteName, baseGraph.sprites, input.index);
    for (const candidate of [sprite?.texturePath, sprite?.texturePath2]) {
      if (candidate === undefined) continue;
      const exact = safeExactAssetPath(candidate);
      if (exact !== undefined) texturePaths.add(exact);
    }
  }
  const assets =
    texturePaths.size === 0
      ? []
      : await input.scanner.scan(input.workspace, {
          patterns: [...texturePaths].sort((left, right) => compareCodeUnits(left, right)),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
  const combined = new Map<string, ScannedFile>();
  for (const file of [...presentationFiles, ...assets]) combined.set(file.displayPath, file);
  const files = [...combined.values()].sort((left, right) =>
    compareCodeUnits(left.displayPath, right.displayPath),
  );
  const graph = baseGraph;
  const catalog = new GuiAssetCatalog(graph, files, input.budget);
  const diagnostics: Diagnostic[] = [];
  const entries: FocusPresentationResolution['entries'] = {};
  const icons: FocusPresentationResolution['icons'] = {};
  const sourceHashes: Record<string, string> = {};
  const relevantPaths = new Set<string>();
  const iconTargets = new Map<string, PresentationTarget>();

  for (const target of targets) {
    input.signal?.throwIfAborted();
    const title = input.index.find('localisation', `${language}:${target.titleKey}`);
    const description = input.index.find('localisation', `${language}:${target.descriptionKey}`);
    const titleValue =
      typeof title?.metadata.value === 'string' ? title.metadata.value : target.fallbackTitle;
    const descriptionValue =
      typeof description?.metadata.value === 'string' ? description.metadata.value : undefined;
    entries[target.id] = {
      id: target.id,
      title: titleValue,
      ...(descriptionValue === undefined ? {} : { description: descriptionValue }),
      titleKey: target.titleKey,
      descriptionKey: target.descriptionKey,
      ...(title?.location === undefined ? {} : { titleSourceLocation: title.location }),
      ...(description?.location === undefined
        ? {}
        : { descriptionSourceLocation: description.location }),
      ...(target.sprite === undefined ? {} : { iconSprite: target.sprite }),
    };
    if (target.sprite !== undefined && !iconTargets.has(target.sprite))
      iconTargets.set(target.sprite, target);
    for (const [key, symbol] of [
      [target.titleKey, title],
      [target.descriptionKey, description],
    ] as const) {
      if (symbol !== undefined) {
        relevantPaths.add(symbol.path);
        continue;
      }
      const partial = input.index.hasSkippedSourceForKind('localisation');
      diagnostics.push({
        code: partial
          ? 'FOCUS_LOCALISATION_REFERENCE_PARTIAL'
          : 'FOCUS_LOCALISATION_REFERENCE_MISSING',
        severity: 'warning',
        category: 'reference',
        message: partial
          ? `The partial shared inventory cannot verify ${language} localisation ${key} for focus ${target.id}`
          : `Focus ${target.id} has no ${language} localisation for ${key}`,
        ...(target.sourceLocation === undefined ? {} : { location: target.sourceLocation }),
        details: { language, key, focusId: target.id },
      });
    }
  }

  const iconEntries = [...iconTargets.entries()];
  const iconResults = await mapWithConcurrency(iconEntries, 8, async ([spriteName, target]) => {
    const sprite = relevantSprite(spriteName, graph.sprites, input.index);
    if (sprite === undefined) {
      const partial = input.index.hasSkippedSourceForKind('sprite');
      return {
        paths: [] as string[],
        diagnostic: {
          code: partial ? 'FOCUS_ICON_REFERENCE_PARTIAL' : 'FOCUS_ICON_REFERENCE_MISSING',
          severity: partial ? ('warning' as const) : ('error' as const),
          category: 'reference' as const,
          message: partial
            ? `The partial shared inventory cannot verify sprite ${spriteName} for focus ${target.id}`
            : `Focus ${target.id} references missing sprite ${spriteName}`,
          ...diagnosticLocation(target),
          details: { focusId: target.id, sprite: spriteName },
        } satisfies Diagnostic,
      };
    }
    const paths = [sprite.sourcePath];
    if (input.decodeIcons === false) {
      const texturePath = sprite.texturePath;
      const asset =
        texturePath === undefined ? undefined : catalog.resolveFile(texturePath, sprite.sourcePath);
      if (asset !== undefined) return { paths: [...paths, asset.displayPath] };
      return {
        paths,
        diagnostic: {
          code: 'FOCUS_ICON_TEXTURE_MISSING',
          severity: 'error' as const,
          category: 'reference' as const,
          message: `Focus ${target.id} cannot resolve sprite texture ${texturePath ?? '<missing>'}`,
          ...diagnosticLocation(target),
          details: { focusId: target.id, sprite: spriteName, texturePath: texturePath ?? null },
        } satisfies Diagnostic,
      };
    }
    const frame = await catalog.loadSpriteFrame(sprite, 0);
    if (frame?.supported !== true || frame.dataUri === undefined) {
      return {
        paths,
        diagnostic: {
          code: 'FOCUS_ICON_TEXTURE_MISSING',
          severity: 'error' as const,
          category: 'reference' as const,
          message: `Focus ${target.id} cannot load sprite texture ${sprite.texturePath ?? '<missing>'}: ${frame?.reason ?? 'texturefile is missing'}`,
          ...diagnosticLocation(target),
          details: {
            focusId: target.id,
            sprite: spriteName,
            texturePath: sprite.texturePath ?? null,
          },
        } satisfies Diagnostic,
      };
    }
    const asset = catalog.resolveFile(frame.texturePath, sprite.sourcePath);
    if (asset !== undefined) paths.push(asset.displayPath);
    return {
      paths,
      icon: {
        sprite: spriteName,
        sourcePath: sprite.sourcePath,
        texturePath: frame.texturePath,
        frame: frame.frame,
        frameCount: frame.frameCount,
        width: frame.width,
        height: frame.height,
        format: frame.format,
        dataUri: frame.dataUri,
      },
    };
  });
  for (const [index, result] of iconResults.entries()) {
    for (const sourcePath of result.paths) relevantPaths.add(sourcePath);
    if (result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
    if (result.icon !== undefined) icons[iconEntries[index]![0]] = result.icon;
  }

  for (const file of files) {
    if (relevantPaths.has(file.displayPath)) sourceHashes[file.displayPath] = file.sha256;
  }
  return {
    language,
    entries,
    icons,
    diagnostics: sortDiagnostics(diagnostics),
    sourceHashes: Object.fromEntries(
      Object.entries(sourceHashes).sort(([left], [right]) => compareCodeUnits(left, right)),
    ),
    filesScanned: [...relevantPaths].sort((left, right) => compareCodeUnits(left, right)),
  };
}
