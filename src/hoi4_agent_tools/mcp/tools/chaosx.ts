import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import sharp from 'sharp';
import { z } from 'zod/v4';
import { type ArtifactWrite, publicArtifactLink } from '../../core/artifacts.js';
import { compareCodeUnits } from '../../core/canonical.js';
import type { CoreEngine, ScanSnapshot } from '../../core/engine.js';
import type { ScannedFile } from '../../core/scanner.js';
import { emptyServiceResult } from '../../core/result.js';
import { RenderBudget } from '../../core/render-budget.js';
import { workspaceIdSchema } from '../../schemas/common.js';
import { GuiAssetCatalog } from '../../gui/assets.js';
import { buildGuiSourceGraph } from '../../gui/source-graph.js';
import { PACKAGE_VERSION } from '../../version.js';
import type { ServerContext } from '../server/base-tools.js';
import { compactValidatedInputSchema } from '../server/context-schemas.js';
import { nonNegativeIntegerSchema, sha256Schema } from '../server/output-schemas.js';
import { progressReporter } from '../server/progress.js';
import {
  errorResult,
  setInlineFilesScanned,
  strictOperationResultSchema,
  toolResult,
} from '../server/result.js';

const countryTagSchema = z
  .string()
  .regex(/^[A-Z0-9]{3}$/u)
  .describe('Exact HOI4 country tag selected by ChaosX');

const chaosxCountryAssetsInput = compactValidatedInputSchema(
  z
    .object({
      workspaceId: workspaceIdSchema,
      countryTags: z.array(countryTagSchema).min(1).max(4),
      eventId: z.number().int().min(0).max(999).optional(),
      treeId: z.string().min(1).max(256).optional(),
    })
    .strict(),
  'ChaosX-only country tags and optional event/focus identity',
);

const chaosxCountryAssetsOutput = strictOperationResultSchema(
  z
    .object({
      revision: sha256Schema,
      countries: z
        .array(
          z
            .object({
              tag: countryTagSchema,
              flagArtifactName: z.string().max(128).optional(),
              leaderPortraitArtifactName: z.string().max(128).optional(),
              leaderSprite: z.string().max(256).optional(),
            })
            .strict(),
        )
        .max(4),
      artifactCount: nonNegativeIntegerSchema,
    })
    .strict(),
);

const artifactProducing = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

interface CountryAssetSelection {
  tag: string;
  flagPath?: string;
  leaderSprite?: string;
  leaderTexturePath?: string;
  discoverySourcePath?: string;
  spriteSourcePath?: string;
}

function activeFiles(snapshot: ScanSnapshot): ScannedFile[] {
  return snapshot.files.filter(({ shadowedBy }) => shadowedBy === undefined);
}

function historyFile(snapshot: ScanSnapshot, tag: string): ScannedFile | undefined {
  const prefix = `history/countries/${tag.toLowerCase()} `;
  return activeFiles(snapshot)
    .filter(({ relativePath }) => relativePath.toLowerCase().startsWith(prefix))
    .sort((left, right) => {
      const ownership = Number(right.rootKind === 'mod') - Number(left.rootKind === 'mod');
      return (
        ownership ||
        right.loadOrder - left.loadOrder ||
        compareCodeUnits(left.displayPath, right.displayPath)
      );
    })[0];
}

function pictureFromText(
  file: ScannedFile,
  tag: string,
  requireTagPrefix: boolean,
): string | undefined {
  const text = file.bytes.toString('utf8');
  const pattern = requireTagPrefix
    ? new RegExp(`\\bpicture\\s*=\\s*"?(GFX_portrait_${tag}_[A-Za-z0-9_.:-]+)"?`, 'u')
    : /\bpicture\s*=\s*"?(GFX_[A-Za-z0-9_.:-]+)"?/u;
  return pattern.exec(text)?.[1];
}

function eventPictureSource(
  snapshot: ScanSnapshot,
  tag: string,
  eventId: number | undefined,
): { sprite: string; path: string } | undefined {
  const eventPrefix = eventId === undefined ? undefined : String(eventId).padStart(3, '0');
  const candidates = activeFiles(snapshot)
    .filter(({ relativePath, bytes }) => {
      const normalized = relativePath.toLowerCase();
      return (
        normalized.endsWith('.txt') &&
        (normalized.startsWith('events/') || normalized.startsWith('common/scripted_effects/')) &&
        bytes.includes(Buffer.from(`GFX_portrait_${tag}_`, 'utf8'))
      );
    })
    .sort((left, right) => {
      const leftPreferred =
        eventPrefix !== undefined && path.posix.basename(left.relativePath).startsWith(eventPrefix);
      const rightPreferred =
        eventPrefix !== undefined &&
        path.posix.basename(right.relativePath).startsWith(eventPrefix);
      return (
        Number(rightPreferred) - Number(leftPreferred) ||
        compareCodeUnits(left.displayPath, right.displayPath)
      );
    });
  for (const file of candidates) {
    const sprite = pictureFromText(file, tag, true);
    if (sprite !== undefined) return { sprite, path: file.displayPath };
  }
  return undefined;
}

function leaderSelection(
  snapshot: ScanSnapshot,
  tag: string,
  eventId: number | undefined,
): Pick<
  CountryAssetSelection,
  'leaderSprite' | 'leaderTexturePath' | 'discoverySourcePath' | 'spriteSourcePath'
> {
  const countryHistory = historyFile(snapshot, tag);
  const historyPicture =
    countryHistory === undefined ? undefined : pictureFromText(countryHistory, tag, false);
  const eventPicture =
    historyPicture === undefined ? eventPictureSource(snapshot, tag, eventId) : undefined;
  const fallbackSprite = snapshot.index
    .findAll('sprite')
    .filter(({ overridden, id }) => !overridden && id.startsWith(`GFX_portrait_${tag}_`))
    .sort((left, right) => compareCodeUnits(left.id, right.id))[0];
  const leaderSprite = historyPicture ?? eventPicture?.sprite ?? fallbackSprite?.id;
  if (leaderSprite === undefined) return {};
  const sprite = snapshot.index.find('sprite', leaderSprite);
  const texture =
    typeof sprite?.metadata.texture === 'string' ? sprite.metadata.texture : undefined;
  return {
    leaderSprite,
    ...(texture === undefined ? {} : { leaderTexturePath: texture }),
    ...(countryHistory !== undefined
      ? { discoverySourcePath: countryHistory.displayPath }
      : eventPicture === undefined
        ? {}
        : { discoverySourcePath: eventPicture.path }),
    ...(sprite === undefined ? {} : { spriteSourcePath: sprite.path }),
  };
}

function flagCandidates(tag: string): string[] {
  return ['tga', 'dds', 'png'].flatMap((extension) => [
    `gfx/flags/${tag}.${extension}`,
    `gfx/flags/medium/${tag}.${extension}`,
    `gfx/flags/small/${tag}.${extension}`,
  ]);
}

async function rasterPng(catalog: GuiAssetCatalog, assetPath: string): Promise<Buffer | undefined> {
  const raster = await catalog.loadRaster(assetPath);
  if (!raster.supported || raster.width < 1 || raster.height < 1) return undefined;
  return sharp(raster.data, {
    raw: { width: raster.width, height: raster.height, channels: 4 },
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

async function selectCountryAssets(
  engine: CoreEngine,
  snapshot: ScanSnapshot,
  workspaceId: string,
  tags: readonly string[],
  eventId: number | undefined,
  context: ServerContext,
  signal: AbortSignal | undefined,
): Promise<{
  selections: CountryAssetSelection[];
  catalog: GuiAssetCatalog;
}> {
  const selections: CountryAssetSelection[] = tags.map((tag) => ({
    tag,
    ...leaderSelection(snapshot, tag, eventId),
  }));
  const patterns = [
    ...new Set(
      selections.flatMap(({ tag, leaderTexturePath }) => [
        ...flagCandidates(tag),
        ...(leaderTexturePath === undefined ? [] : [leaderTexturePath]),
      ]),
    ),
  ].sort(compareCodeUnits);
  const workspace = engine.resolver.get(workspaceId, context.principal);
  const scannedAssets =
    patterns.length === 0
      ? []
      : await engine.scanner.scan(workspace, {
          patterns,
          ...(signal === undefined ? {} : { signal }),
        });
  const graph = buildGuiSourceGraph([], snapshot.index);
  const catalog = new GuiAssetCatalog(graph, scannedAssets, new RenderBudget());
  for (const selection of selections) {
    const flagPath = flagCandidates(selection.tag).find(
      (candidate) => catalog.resolveFile(candidate) !== undefined,
    );
    if (flagPath !== undefined) selection.flagPath = flagPath;
  }
  return { selections, catalog };
}

export function registerChaosxTools(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  server.registerTool(
    'chaosx.focus_country_assets',
    {
      title: 'Render ChaosX focus country assets',
      description:
        'Private ChaosX Discord integration endpoint. Returns country flags and leader portraits to accompany a focus-tree raster; it is not intended for coding-agent workflows.',
      inputSchema: chaosxCountryAssetsInput,
      outputSchema: chaosxCountryAssetsOutput,
      annotations: artifactProducing,
    },
    async (input, extra) => {
      const workspaceId = engine.resolver.resolveWorkspaceId(input.workspaceId, context.principal);
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Resolving ChaosX country assets');
        const snapshot = await engine.scan(workspaceId, {}, context.principal, progress.signal);
        const tags = [...new Set(input.countryTags)];
        const { selections, catalog } = await selectCountryAssets(
          engine,
          snapshot,
          workspaceId,
          tags,
          input.eventId,
          context,
          progress.signal,
        );
        await progress.report(1, 3, 'Rasterizing ChaosX country assets');
        const writes: ArtifactWrite[] = [];
        const countries: Array<{
          tag: string;
          flagArtifactName?: string;
          leaderPortraitArtifactName?: string;
          leaderSprite?: string;
        }> = [];
        const filesScanned = new Set<string>();

        for (const selection of selections) {
          const country: (typeof countries)[number] = { tag: selection.tag };
          const sourcePaths = [selection.discoverySourcePath, selection.spriteSourcePath].filter(
            (value): value is string => value !== undefined,
          );
          for (const sourcePath of sourcePaths) filesScanned.add(sourcePath);

          if (selection.flagPath !== undefined) {
            const png = await rasterPng(catalog, selection.flagPath);
            const source = catalog.resolveFile(selection.flagPath);
            if (png !== undefined && source !== undefined) {
              filesScanned.add(source.displayPath);
              const name = `chaosx-${selection.tag}-flag.png`;
              country.flagArtifactName = name;
              writes.push({
                name,
                mimeType: 'image/png',
                content: png,
                provenance: {
                  kind: 'chaosx-country-flag',
                  toolVersion: PACKAGE_VERSION,
                  schemaVersion: 'chaosx-country-assets.v1',
                  sourceHashes: { [source.displayPath]: source.sha256 },
                  metadata: {
                    tag: selection.tag,
                    eventId: input.eventId ?? null,
                    treeId: input.treeId ?? null,
                  },
                },
                description: `ChaosX country flag for ${selection.tag}`,
              });
            }
          }

          if (selection.leaderTexturePath !== undefined) {
            const png = await rasterPng(catalog, selection.leaderTexturePath);
            const source = catalog.resolveFile(selection.leaderTexturePath);
            if (png !== undefined && source !== undefined) {
              filesScanned.add(source.displayPath);
              const name = `chaosx-${selection.tag}-leader.png`;
              country.leaderPortraitArtifactName = name;
              const leaderSprite = selection.leaderSprite;
              if (leaderSprite !== undefined) country.leaderSprite = leaderSprite;
              const sourceHashes: Record<string, string> = { [source.displayPath]: source.sha256 };
              for (const sourcePath of sourcePaths) {
                const file = snapshot.files.find(({ displayPath }) => displayPath === sourcePath);
                if (file !== undefined) sourceHashes[sourcePath] = file.sha256;
              }
              writes.push({
                name,
                mimeType: 'image/png',
                content: png,
                provenance: {
                  kind: 'chaosx-leader-portrait',
                  toolVersion: PACKAGE_VERSION,
                  schemaVersion: 'chaosx-country-assets.v1',
                  sourceHashes,
                  metadata: {
                    tag: selection.tag,
                    leaderSprite: selection.leaderSprite ?? null,
                    eventId: input.eventId ?? null,
                    treeId: input.treeId ?? null,
                  },
                },
                description: `ChaosX leader portrait for ${selection.tag}`,
              });
            }
          }
          countries.push(country);
        }

        const workspace = engine.resolver.get(workspaceId, context.principal);
        const artifacts =
          writes.length === 0
            ? []
            : await engine.artifacts.withAtomicChunkedWrites(
                workspace,
                writes,
                (stored) => Promise.resolve([...stored]),
                progress.signal,
              );
        const result = emptyServiceResult(workspaceId, {
          revision: snapshot.revision,
          countries,
          artifactCount: artifacts.length,
        });
        result.code = 'CHAOSX_COUNTRY_ASSETS_RENDERED';
        setInlineFilesScanned(result, [...filesScanned].sort(compareCodeUnits));
        result.artifacts = artifacts.map(publicArtifactLink);
        await progress.report(3, 3, 'ChaosX country assets complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );
}
