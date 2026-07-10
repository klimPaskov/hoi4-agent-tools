import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { create as createFont } from 'fontkit';
import type { Font } from 'fontkit';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..', 'fixtures', 'gui');
const output = path.join(root, 'workspace', 'gfx', 'interface', 'synthetic_gui');
const fonts = path.join(root, 'workspace', 'fonts');
const animationSources = path.join(
  root,
  'workspace',
  'hoi4_agent',
  'animation_sources',
  'synthetic_pulse',
);
await mkdir(output, { recursive: true });
await mkdir(fonts, { recursive: true });
await mkdir(animationSources, { recursive: true });

async function svgPng(
  name: string,
  width: number,
  height: number,
  body: string,
  target = output,
): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toFile(path.join(target, name));
}

await svgPng(
  'panel.png',
  96,
  96,
  '<defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#253746"/><stop offset="1" stop-color="#101820"/></linearGradient></defs><rect width="96" height="96" rx="7" fill="url(#g)"/><path d="M0 20h96M0 76h96" stroke="#5c7181" opacity=".3"/>',
);
await svgPng(
  'card.png',
  96,
  96,
  '<rect x="1" y="1" width="94" height="94" rx="8" fill="#263846" stroke="#60798a" stroke-width="2"/><path d="M9 30h78M9 72h78" stroke="#7892a3" opacity=".22"/>',
);
await svgPng(
  'meter.png',
  120,
  18,
  '<rect x="1" y="1" width="118" height="16" rx="7" fill="#0c141b" stroke="#597183" stroke-width="2"/><path d="M8 9h104" stroke="#344b5b" stroke-width="4"/>',
);
await svgPng(
  'modal.png',
  96,
  96,
  '<rect x="2" y="2" width="92" height="92" rx="10" fill="#182630" stroke="#f1c75b" stroke-width="3"/><path d="M10 34h76" stroke="#f1c75b" opacity=".38"/>',
);

const buttonFrames = ['#34536b', '#4d7591', '#9a7b2f', '#343b42']
  .map(
    (fill, index) =>
      `<g transform="translate(${index * 180} 0)"><rect x="1" y="1" width="178" height="32" rx="6" fill="${fill}" stroke="#b8cad5" stroke-width="2"/><path d="M10 7h160" stroke="#fff" opacity=".16"/></g>`,
  )
  .join('');
await svgPng('button_states.png', 720, 34, buttonFrames);

const iconFrames = ['#55d6be', '#f1c75b', '#8aa4ff', '#79838b']
  .map(
    (fill, index) =>
      `<g transform="translate(${index * 32} 0)"><rect x="2" y="2" width="28" height="28" rx="6" fill="#0d161d" stroke="${fill}" stroke-width="2"/><circle cx="16" cy="16" r="${5 + index}" fill="${fill}"/></g>`,
  )
  .join('');
await svgPng('icon_states.png', 128, 32, iconFrames);

const animationFrameBodies = [
  '<circle cx="24" cy="24" r="7" fill="#55d6be"/><circle cx="24" cy="24" r="12" fill="none" stroke="#55d6be" stroke-width="2" opacity=".45"/>',
  '<path d="M24 10 38 24 24 38 10 24Z" fill="#f1c75b"/><circle cx="24" cy="24" r="5" fill="#17202a"/>',
  '<path d="M19 8h10v11h11v10H29v11H19V29H8V19h11Z" fill="#ff7a72"/><circle cx="24" cy="24" r="4" fill="#fff3d1"/>',
  '<circle cx="24" cy="24" r="15" fill="none" stroke="#8aa4ff" stroke-width="6"/><circle cx="24" cy="24" r="4" fill="#8aa4ff"/>',
  '<path d="m24 7 4.7 10.5L40 18.7l-8.4 7.7L34 38l-10-5.8L14 38l2.4-11.6L8 18.7l11.3-1.2Z" fill="#df8cff"/>',
  '<path d="M24 7 41 37H7Z" fill="#60d394"/><path d="M24 17 31 31H17Z" fill="#17202a"/>',
];
await Promise.all(
  animationFrameBodies.map((body, index) =>
    svgPng(`pulse-frame-${index}.png`, 48, 48, body, animationSources),
  ),
);
const frames = await Promise.all(
  animationFrameBodies.map((_body, index) =>
    readFile(path.join(animationSources, `pulse-frame-${index}.png`)),
  ),
);
const decodedFrames = await Promise.all(
  frames.map((input) => sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })),
);
const sheet = Buffer.alloc(288 * 48 * 4);
for (const [index, frame] of decodedFrames.entries()) {
  if (frame.info.width !== 48 || frame.info.height !== 48 || frame.info.channels !== 4)
    throw new Error(`Synthetic animation frame ${index} is not a 48x48 RGBA frame.`);
  for (let y = 0; y < 48; y += 1) {
    frame.data.copy(sheet, (y * 288 + index * 48) * 4, y * 48 * 4, (y + 1) * 48 * 4);
  }
}
await sharp(sheet, { raw: { width: 288, height: 48, channels: 4 } })
  .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
  .toFile(path.join(output, 'pulse_animation.png'));
const staticFrame = decodedFrames[0];
if (staticFrame === undefined) throw new Error('Synthetic animation frame zero is missing.');
await sharp(staticFrame.data, {
  raw: {
    width: staticFrame.info.width,
    height: staticFrame.info.height,
    channels: 4,
  },
})
  .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
  .toFile(path.join(output, 'pulse_static.png'));

const fontValue = createFont(
  await readFile(
    new URL(
      import.meta.resolve('@fontsource-variable/roboto/files/roboto-latin-wght-normal.woff2'),
    ),
  ),
);
const fixtureFont: Font | undefined = 'fonts' in fontValue ? fontValue.fonts[0] : fontValue;
if (fixtureFont === undefined) throw new Error('Synthetic fixture font face is missing.');
const fixtureFontSize = 16;
const fixtureLineHeight = 20;
const fixtureBaseline = 16;
const fixtureAtlasWidth = 512;
const fontScale = fixtureFontSize / fixtureFont.unitsPerEm;
let glyphX = 1;
let glyphY = 1;
const glyphRecords: string[] = [];
const glyphPaths: string[] = [];
for (let codePoint = 32; codePoint <= 126; codePoint += 1) {
  const character = String.fromCodePoint(codePoint);
  const run = fixtureFont.layout(character);
  const advance = Math.max(4, Math.ceil(run.advanceWidth * fontScale) + 2);
  const cellWidth = Math.max(advance, 5);
  if (glyphX + cellWidth + 1 > fixtureAtlasWidth) {
    glyphX = 1;
    glyphY += fixtureLineHeight;
  }
  const glyph = run.glyphs[0];
  if (codePoint !== 32 && glyph !== undefined) {
    glyphPaths.push(
      `<path d="${glyph.path.toSVG()}" transform="translate(${glyphX + 1} ${glyphY + fixtureBaseline}) scale(${fontScale} ${-fontScale})"/>`,
    );
  }
  glyphRecords.push(
    `char id=${codePoint} x=${glyphX} y=${glyphY} width=${codePoint === 32 ? 0 : cellWidth} height=${codePoint === 32 ? 0 : fixtureLineHeight} xoffset=0 yoffset=0 xadvance=${advance} page=0 chnl=15`,
  );
  glyphX += cellWidth + 1;
}
const fixtureAtlasHeight = glyphY + fixtureLineHeight + 1;
await svgPng(
  'synthetic_fixture_font.png',
  fixtureAtlasWidth,
  fixtureAtlasHeight,
  `<rect width="${fixtureAtlasWidth}" height="${fixtureAtlasHeight}" fill="transparent"/><g fill="#fff">${glyphPaths.join('')}</g>`,
  fonts,
);
await writeFile(
  path.join(fonts, 'synthetic_fixture_font.fnt'),
  `info face="Synthetic Roboto" size=${fixtureFontSize}\ncommon lineHeight=${fixtureLineHeight} base=${fixtureBaseline} scaleW=${fixtureAtlasWidth} scaleH=${fixtureAtlasHeight} pages=1 packed=0\npage id=0 file="synthetic_fixture_font.png"\nchars count=${glyphRecords.length}\n${glyphRecords.join('\n')}\nkernings count=1\nkerning first=65 second=86 amount=-1\n`,
  'utf8',
);
