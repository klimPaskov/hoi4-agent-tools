import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  GuiAssetCatalog,
  defaultPreviewScenario,
  parseBmFont,
  renderGuiScene,
  type GuiFontDefinition,
  type GuiScene,
  type GuiSceneElement,
  type GuiSourceGraph,
} from '../../src/hoi4_agent_tools/gui/index.js';

const gameRoot = process.env.HOI4_GAME_ROOT;
const local = gameRoot === undefined ? describe.skip : describe;
const fontRoot = gameRoot === undefined ? '' : path.join(gameRoot, 'gfx', 'fonts');

function scanned(relativePath: string, bytes: Buffer): ScannedFile {
  return {
    absolutePath: path.join(gameRoot!, relativePath),
    displayPath: `game:${relativePath.replaceAll('\\', '/')}`,
    relativePath: relativePath.replaceAll('\\', '/'),
    rootKind: 'game',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

function emptyGraph(fonts: GuiFontDefinition[], files: readonly ScannedFile[]): GuiSourceGraph {
  return {
    complete: true,
    skippedSourceCount: 0,
    skippedSources: [],
    skippedPossibleSymbolKinds: [],
    nodes: [],
    edges: [],
    elements: [],
    sprites: [],
    fonts,
    textColours: {},
    scriptedGuis: [],
    animationSources: [],
    scriptedLocalisation: [],
    localisation: [],
    sourceHashes: Object.fromEntries(files.map(({ displayPath, sha256 }) => [displayPath, sha256])),
    filesScanned: files.map(({ displayPath }) => displayPath),
    diagnostics: [],
  };
}

local('installed vanilla bitmap fonts', () => {
  it('parses every locale descriptor and resolves every declared atlas page', async () => {
    await access(fontRoot);
    const descriptors = (await readdir(fontRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.fnt'))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
    expect(descriptors.length).toBeGreaterThan(300);
    for (const descriptor of descriptors) {
      const parsed = parseBmFont(await readFile(descriptor, 'utf8'));
      expect(parsed, descriptor).toBeDefined();
      expect(parsed!.characters.size, descriptor).toBeGreaterThan(0);
      const pages = parsed!.pages.length === 0 ? [''] : parsed!.pages;
      for (const [pageIndex, page] of pages.entries()) {
        const declared = path.join(path.dirname(descriptor), page);
        const extension = path.extname(declared);
        const descriptorStem = descriptor.slice(0, -path.extname(descriptor).length);
        const candidates = [
          ...(page.length === 0
            ? []
            : extension.length === 0
              ? ['.dds', '.png', '.tga', '.bmp'].map((suffix) => `${declared}${suffix}`)
              : [declared]),
          ...(pageIndex === 0
            ? ['.dds', '.png', '.tga', '.bmp'].map((suffix) => `${descriptorStem}${suffix}`)
            : []),
        ];
        let found = false;
        for (const candidate of candidates) {
          try {
            found = (await stat(candidate)).isFile();
          } catch {
            // Try the remaining page variants.
          }
          if (found) break;
        }
        expect(found, `${descriptor} -> ${page}`).toBe(true);
      }
    }
  }, 120_000);

  it('renders every base font with isolated native glyphs, crisp scaling, and mixed colours', async () => {
    const entries = (await readdir(fontRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    const files = await Promise.all(
      entries.map(async (name) =>
        scanned(`gfx/fonts/${name}`, await readFile(path.join(fontRoot, name))),
      ),
    );
    const descriptorFiles = files.filter(({ relativePath }) => relativePath.endsWith('.fnt'));
    expect(descriptorFiles.length).toBeGreaterThan(50);
    const fonts = descriptorFiles.map((file, index): GuiFontDefinition => ({
      id: `font-audit-${index}`,
      name: path.basename(file.relativePath, '.fnt'),
      sourcePath: 'game:interface/font-audit.gfx',
      kind: 'bmfont',
      override: false,
      languages: [],
      assetPaths: [file.relativePath],
    }));
    const graph = emptyGraph(fonts, files);
    const catalog = new GuiAssetCatalog(graph, files);
    const elements: GuiSceneElement[] = [];
    const colours = ['#f5f2e8ff', '#ff3232ff', '#65d665ff', '#ffbd00ff'];
    let y = 0;
    for (const font of fonts) {
      const descriptor = parseBmFont(
        descriptorFiles
          .find(({ relativePath }) => relativePath === font.assetPaths[0])!
          .bytes.toString('utf8'),
      )!;
      const preferred = [65, 103, 77, 87, 48, 57, 1040, 1072, 1046].filter((codePoint) =>
        descriptor.characters.has(codePoint),
      );
      const fallback = [...descriptor.characters.keys()]
        .filter((codePoint) => codePoint > 32)
        .slice(0, 6);
      const codePoints = preferred.length >= 2 ? preferred : fallback;
      expect(codePoints.length, font.name).toBeGreaterThan(0);
      const sample = String.fromCodePoint(...codePoints);
      const metrics = catalog.resolvedFontMetrics(font.name);
      expect(metrics.source, font.name).toBe('bmfont');
      const nativeSize = metrics.nativeSize!;
      for (const scale of [1, 2]) {
        const fontSize = nativeSize * scale;
        const text = Array.from({ length: colours.length }, () => sample).join('');
        const shaped = await catalog.shapeText(font.name, text, fontSize);
        expect(shaped.source, font.name).toBe('bmfont-atlas');
        expect(shaped.missingGlyphs, font.name).toEqual([]);
        expect(shaped.glyphs.length, font.name).toBe(text.length);
        for (const glyph of shaped.glyphs) {
          if (glyph.kind !== 'bitmap') continue;
          const decoded = await sharp(Buffer.from(glyph.dataUri.split(',')[1]!, 'base64'))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          const alpha = Array.from(
            { length: decoded.info.width * decoded.info.height },
            (_value, index) => decoded.data[index * 4 + 3] ?? 0,
          );
          expect(
            alpha.some((value) => value > 0),
            `${font.name}:${glyph.key}`,
          ).toBe(true);
          expect(
            alpha.some((value) => value === 0),
            `${font.name}:${glyph.key}`,
          ).toBe(true);
        }
        const chunkWidth = catalog.measureText(font.name, sample, fontSize).width;
        const lineHeight = (metrics.nativeLineHeight ?? nativeSize) * scale;
        const rect = { x: 8, y, width: 1900, height: lineHeight + 4 };
        elements.push({
          id: `${font.name}-${scale}`,
          sourceId: font.id,
          name: `${font.name}-${scale}`,
          elementType: 'instantTextBoxType',
          depth: 0,
          zIndex: elements.length,
          visible: true,
          clickable: false,
          clickThrough: false,
          rect,
          unclippedRect: rect,
          clipped: false,
          scale: 1,
          state: 'normal',
          text: {
            text,
            lines: [text],
            lineWidths: [shaped.width],
            lineHeight,
            fontSize,
            measuredWidth: shaped.width,
            measuredHeight: lineHeight,
            metricSource: 'bmfont',
            horizontalAlignment: 'left',
            verticalAlignment: 'top',
            fontName: font.name,
            colour: colours[0]!,
            borderColour: '#000000ff',
            glyphLines: [shaped],
            overflowX: false,
            overflowY: false,
            fixedSize: false,
            unresolvedTokens: [],
            colourRuns: [
              colours.map((colour, index) => ({
                text: sample,
                colour,
                offsetX: chunkWidth * index,
                width: chunkWidth,
              })),
            ],
          },
          sourcePath: font.sourcePath,
          unsupportedAttributes: [],
        });
        y += lineHeight + 6;
      }
    }
    const scenario = defaultPreviewScenario('all-vanilla-fonts');
    scenario.resolution = { width: 1920, height: Math.ceil(y) };
    const scene: GuiScene = {
      windowName: 'all-vanilla-fonts',
      scenario,
      resolution: scenario.resolution,
      elements,
      bounds: { x: 0, y: 0, width: 1920, height: Math.ceil(y) },
      fidelity: {
        modelled: [],
        approximated: [],
        ignored: [],
        missing: [],
        unsupported: [],
        unresolved: [],
      },
      diagnostics: [],
      sourceRevision: sha256Bytes(fonts.map(({ name }) => name).join('\n')),
    };
    const first = await renderGuiScene(scene, ['cropped']);
    const second = await renderGuiScene(scene, ['cropped']);
    expect(first.images[0]!.png.equals(second.images[0]!.png)).toBe(true);
    expect(first.images[0]!.svg.match(/image-rendering="optimizeSpeed"/gu)?.length).toBeGreaterThan(
      100,
    );
    for (const colour of colours)
      expect(first.images[0]!.svg, colour).toContain(`data-font-colour="${colour}"`);
    const raster = await sharp(first.images[0]!.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const hasColour = (red: number, green: number, blue: number): boolean => {
      for (let offset = 0; offset < raster.data.length; offset += 4)
        if (
          Math.abs((raster.data[offset] ?? 0) - red) < 20 &&
          Math.abs((raster.data[offset + 1] ?? 0) - green) < 20 &&
          Math.abs((raster.data[offset + 2] ?? 0) - blue) < 20 &&
          (raster.data[offset + 3] ?? 0) > 128
        )
          return true;
      return false;
    };
    expect(hasColour(255, 50, 50)).toBe(true);
    expect(hasColour(101, 214, 101)).toBe(true);
    expect(hasColour(255, 189, 0)).toBe(true);
  }, 600_000);

  it('shapes every locale font override at native and enlarged sizes without blurred glyph data', async () => {
    const requestedFilter = process.env.HOI4_FONT_TEST_FILTER;
    const descriptorPaths = (await readdir(fontRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.fnt'))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((descriptor) => requestedFilter === undefined || descriptor.includes(requestedFilter))
      .sort();
    if (requestedFilter === undefined) expect(descriptorPaths.length).toBeGreaterThan(300);
    else expect(descriptorPaths.length).toBeGreaterThan(0);
    const colours = ['#f5f2e8ff', '#ff3232ff', '#65d665ff', '#ffbd00ff'];
    let colourAuditElements: GuiSceneElement[] = [];
    let colourAuditHeight = 0;
    let colourAuditBatch = 0;
    const flushColourAudit = async (): Promise<void> => {
      if (colourAuditElements.length === 0) return;
      const scenario = defaultPreviewScenario(`locale-font-colours-${colourAuditBatch}`);
      scenario.resolution = { width: 1920, height: Math.ceil(colourAuditHeight) };
      const scene: GuiScene = {
        windowName: scenario.id,
        scenario,
        resolution: scenario.resolution,
        elements: colourAuditElements,
        bounds: { x: 0, y: 0, width: 1920, height: Math.ceil(colourAuditHeight) },
        fidelity: {
          modelled: [],
          approximated: [],
          ignored: [],
          missing: [],
          unsupported: [],
          unresolved: [],
        },
        diagnostics: [],
        sourceRevision: sha256Bytes(
          colourAuditElements.map(({ sourcePath }) => sourcePath).join('\n'),
        ),
      };
      const rendered = await renderGuiScene(scene, ['cropped']);
      const raster = await sharp(rendered.images[0]!.png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (const element of colourAuditElements) {
        const text = element.text!;
        for (const [index, expected] of [
          [0, [245, 242, 232]],
          [1, [255, 50, 50]],
          [2, [101, 214, 101]],
          [3, [255, 189, 0]],
        ] as const) {
          const run = text.colourRuns![0]![index]!;
          const startX = Math.max(0, Math.floor(element.rect.x + run.offsetX));
          const endX = Math.min(
            raster.info.width,
            Math.ceil(element.rect.x + run.offsetX + run.width),
          );
          const startY = Math.max(0, Math.floor(element.rect.y));
          const endY = Math.min(
            raster.info.height,
            Math.ceil(element.rect.y + element.rect.height),
          );
          let found = false;
          let nearestDistance = Number.POSITIVE_INFINITY;
          let nearestPixel = [0, 0, 0, 0];
          for (let y = startY; y < endY && !found; y += 1)
            for (let x = startX; x < endX; x += 1) {
              const offset = (y * raster.info.width + x) * 4;
              const actual = [
                raster.data[offset] ?? 0,
                raster.data[offset + 1] ?? 0,
                raster.data[offset + 2] ?? 0,
                raster.data[offset + 3] ?? 0,
              ];
              const denominator = expected[0] ** 2 + expected[1] ** 2 + expected[2] ** 2;
              const scale =
                (actual[0]! * expected[0] + actual[1]! * expected[1] + actual[2]! * expected[2]) /
                denominator;
              const distance = Math.sqrt(
                (actual[0]! - expected[0] * scale) ** 2 +
                  (actual[1]! - expected[1] * scale) ** 2 +
                  (actual[2]! - expected[2] * scale) ** 2,
              );
              if (actual[3]! > 0 && distance < nearestDistance) {
                nearestDistance = distance;
                nearestPixel = actual;
              }
              if (scale > 0.15 && distance < 24 && actual[3]! > 96) {
                found = true;
                break;
              }
            }
          expect(
            found,
            `${element.sourcePath}:${colours[index]} nearest=${nearestPixel.join(',')} distance=${nearestDistance}`,
          ).toBe(true);
        }
      }
      expect(
        rendered.images[0]!.svg.match(/image-rendering="optimizeSpeed"/gu)?.length,
      ).toBeGreaterThan(colourAuditElements.length);
      colourAuditElements = [];
      colourAuditHeight = 0;
      colourAuditBatch += 1;
    };
    for (const descriptorPath of descriptorPaths) {
      const descriptorBytes = await readFile(descriptorPath);
      const descriptor = parseBmFont(descriptorBytes.toString('utf8'))!;
      const descriptorRelativePath = path.relative(gameRoot!, descriptorPath).replaceAll('\\', '/');
      const sourceFiles = [scanned(descriptorRelativePath, descriptorBytes)];
      const pageNames = descriptor.pages.length === 0 ? [''] : descriptor.pages;
      for (const [pageIndex, pageName] of pageNames.entries()) {
        const declared = path.join(path.dirname(descriptorPath), pageName);
        const extension = path.extname(declared);
        const descriptorStem = descriptorPath.slice(0, -path.extname(descriptorPath).length);
        const candidates = [
          ...(pageName.length === 0
            ? []
            : extension.length === 0
              ? ['.dds', '.png', '.tga', '.bmp'].map((suffix) => `${declared}${suffix}`)
              : [declared]),
          ...(pageIndex === 0
            ? ['.dds', '.png', '.tga', '.bmp'].map((suffix) => `${descriptorStem}${suffix}`)
            : []),
        ];
        for (const candidate of candidates) {
          try {
            const bytes = await readFile(candidate);
            sourceFiles.push(
              scanned(path.relative(gameRoot!, candidate).replaceAll('\\', '/'), bytes),
            );
            break;
          } catch {
            // Try the remaining declared and descriptor-stem page variants.
          }
        }
      }
      const fontName = `locale-font-${sha256Bytes(descriptorRelativePath).slice(0, 16)}`;
      const font: GuiFontDefinition = {
        id: fontName,
        name: fontName,
        sourcePath: 'game:interface/locale-font-audit.gfx',
        kind: 'bmfont',
        override: false,
        languages: [],
        assetPaths: [descriptorRelativePath],
      };
      const catalog = new GuiAssetCatalog(emptyGraph([font], sourceFiles), sourceFiles);
      const preferred = [65, 103, 77, 87, 48, 57, 1040, 1072, 1046, 20013, 22269].filter(
        (codePoint) => descriptor.characters.has(codePoint),
      );
      const fallback = [...descriptor.characters.keys()]
        .filter((codePoint) => codePoint > 32)
        .slice(0, 4);
      const codePoints = preferred.length > 0 ? preferred.slice(0, 4) : fallback;
      expect(codePoints.length, descriptorRelativePath).toBeGreaterThan(0);
      const sample = String.fromCodePoint(...codePoints);
      const nativeSize = catalog.resolvedFontMetrics(fontName).nativeSize!;
      for (const scale of [1, 2, 4]) {
        const shaped = await catalog.shapeText(fontName, sample, nativeSize * scale);
        expect(shaped.source, descriptorRelativePath).toBe('bmfont-atlas');
        expect(shaped.missingGlyphs, descriptorRelativePath).toEqual([]);
        expect(shaped.glyphs.length, descriptorRelativePath).toBe(sample.length);
        for (const glyph of shaped.glyphs) {
          if (glyph.kind !== 'bitmap') continue;
          const decoded = await sharp(Buffer.from(glyph.dataUri.split(',')[1]!, 'base64'))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          const alpha = Array.from(
            { length: decoded.info.width * decoded.info.height },
            (_value, index) => decoded.data[index * 4 + 3] ?? 0,
          );
          expect(
            alpha.some((value) => value > 0),
            `${descriptorRelativePath}:${glyph.key}`,
          ).toBe(true);
          expect(
            alpha.some((value) => value === 0),
            `${descriptorRelativePath}:${glyph.key}`,
          ).toBe(true);
        }
      }
      const colouredText = sample.repeat(colours.length);
      const colouredShape = await catalog.shapeText(fontName, colouredText, nativeSize);
      const sampleWidth = catalog.measureText(fontName, sample, nativeSize).width;
      const lineHeight = catalog.resolvedFontMetrics(fontName).nativeLineHeight ?? nativeSize;
      const rect = {
        x: 4,
        y: colourAuditHeight,
        width: Math.min(1912, Math.max(1, sampleWidth * colours.length)),
        height: lineHeight + 2,
      };
      colourAuditElements.push({
        id: `${fontName}-colours`,
        sourceId: font.id,
        name: `${fontName}-colours`,
        elementType: 'instantTextBoxType',
        depth: 0,
        zIndex: colourAuditElements.length,
        visible: true,
        clickable: false,
        clickThrough: false,
        rect,
        unclippedRect: rect,
        clipped: false,
        scale: 1,
        state: 'normal',
        text: {
          text: colouredText,
          lines: [colouredText],
          lineWidths: [colouredShape.width],
          lineHeight,
          fontSize: nativeSize,
          measuredWidth: colouredShape.width,
          measuredHeight: lineHeight,
          metricSource: 'bmfont',
          horizontalAlignment: 'left',
          verticalAlignment: 'top',
          fontName,
          colour: colours[0]!,
          borderColour: '#000000ff',
          glyphLines: [colouredShape],
          overflowX: false,
          overflowY: false,
          fixedSize: false,
          unresolvedTokens: [],
          colourRuns: [
            colours.map((colour, index) => ({
              text: sample,
              colour,
              offsetX: sampleWidth * index,
              width: sampleWidth,
            })),
          ],
        },
        sourcePath: descriptorRelativePath,
        unsupportedAttributes: [],
      });
      colourAuditHeight += lineHeight + 4;
      if (colourAuditHeight > 5000) await flushColourAudit();
    }
    await flushColourAudit();
  }, 600_000);
});
