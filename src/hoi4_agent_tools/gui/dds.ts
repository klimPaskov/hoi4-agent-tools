import { RenderBudget, RENDER_MAX_DECODED_PIXELS } from '../core/render-budget.js';
import { sha256Bytes } from '../core/canonical.js';

export type DdsPixelFormat =
  'rgb24' | 'rgba32' | 'dxt1' | 'dxt3' | 'dxt5' | 'dx10-rgba8-srgb' | 'dx10-bgra8-srgb';

export interface DecodedDds {
  width: number;
  height: number;
  data: Buffer;
  format: DdsPixelFormat;
}

export interface UnsupportedDds {
  unsupported: true;
  format: string;
  reason: string;
}

export type DdsDecodeResult = DecodedDds | UnsupportedDds;

const DDS_MAGIC = 0x2053_4444;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;

function fourCc(bytes: Buffer, offset: number): string {
  return bytes
    .subarray(offset, offset + 4)
    .toString('ascii')
    .replaceAll('\0', '');
}

function byte(bytes: Buffer, offset: number): number {
  return bytes.readUInt8(offset);
}

function unsupported(format: string, reason: string): UnsupportedDds {
  return { unsupported: true, format, reason };
}

function expand5(value: number): number {
  return (value << 3) | (value >> 2);
}

function expand6(value: number): number {
  return (value << 2) | (value >> 4);
}

function colour565(value: number): readonly [number, number, number, number] {
  return [expand5((value >> 11) & 0x1f), expand6((value >> 5) & 0x3f), expand5(value & 0x1f), 255];
}

function writePixel(
  output: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  colour: readonly [number, number, number, number],
): void {
  if (x >= width || y >= height) return;
  const target = (y * width + x) * 4;
  output[target] = colour[0];
  output[target + 1] = colour[1];
  output[target + 2] = colour[2];
  output[target + 3] = colour[3];
}

function colourTable(
  colour0: number,
  colour1: number,
  transparentMode: boolean,
): (readonly [number, number, number, number])[] {
  const first = colour565(colour0);
  const second = colour565(colour1);
  if (transparentMode && colour0 <= colour1) {
    return [
      first,
      second,
      [
        Math.round((first[0] + second[0]) / 2),
        Math.round((first[1] + second[1]) / 2),
        Math.round((first[2] + second[2]) / 2),
        255,
      ],
      [0, 0, 0, 0],
    ];
  }
  return [
    first,
    second,
    [
      Math.round((2 * first[0] + second[0]) / 3),
      Math.round((2 * first[1] + second[1]) / 3),
      Math.round((2 * first[2] + second[2]) / 3),
      255,
    ],
    [
      Math.round((first[0] + 2 * second[0]) / 3),
      Math.round((first[1] + 2 * second[1]) / 3),
      Math.round((first[2] + 2 * second[2]) / 3),
      255,
    ],
  ];
}

function decodeDxt(
  bytes: Buffer,
  dataOffset: number,
  width: number,
  height: number,
  format: 'dxt1' | 'dxt3' | 'dxt5',
): Buffer | undefined {
  const blockSize = format === 'dxt1' ? 8 : 16;
  const blockWidth = Math.ceil(width / 4);
  const blockHeight = Math.ceil(height / 4);
  const required = dataOffset + blockWidth * blockHeight * blockSize;
  if (bytes.length < required) return undefined;
  const output = Buffer.alloc(width * height * 4);
  let cursor = dataOffset;
  for (let blockY = 0; blockY < blockHeight; blockY += 1) {
    for (let blockX = 0; blockX < blockWidth; blockX += 1) {
      const alphas = new Array<number>(16).fill(255);
      if (format === 'dxt3') {
        for (let index = 0; index < 16; index += 1) {
          const nibbleByte = byte(bytes, cursor + Math.floor(index / 2));
          alphas[index] = ((nibbleByte >> ((index % 2) * 4)) & 0xf) * 17;
        }
        cursor += 8;
      } else if (format === 'dxt5') {
        const alpha0 = byte(bytes, cursor);
        const alpha1 = byte(bytes, cursor + 1);
        const table = [alpha0, alpha1];
        if (alpha0 > alpha1) {
          for (let index = 1; index <= 6; index += 1)
            table.push(Math.round(((7 - index) * alpha0 + index * alpha1) / 7));
        } else {
          for (let index = 1; index <= 4; index += 1)
            table.push(Math.round(((5 - index) * alpha0 + index * alpha1) / 5));
          table.push(0, 255);
        }
        let alphaBits = 0n;
        for (let index = 0; index < 6; index += 1)
          alphaBits |= BigInt(byte(bytes, cursor + 2 + index)) << BigInt(index * 8);
        for (let index = 0; index < 16; index += 1)
          alphas[index] = table[Number((alphaBits >> BigInt(index * 3)) & 0x7n)] ?? 255;
        cursor += 8;
      }
      const colour0 = bytes.readUInt16LE(cursor);
      const colour1 = bytes.readUInt16LE(cursor + 2);
      const colours = colourTable(colour0, colour1, format === 'dxt1');
      const indices = bytes.readUInt32LE(cursor + 4);
      cursor += 8;
      for (let pixelY = 0; pixelY < 4; pixelY += 1) {
        for (let pixelX = 0; pixelX < 4; pixelX += 1) {
          const pixel = pixelY * 4 + pixelX;
          const colour = colours[(indices >> (pixel * 2)) & 0x3] ?? [0, 0, 0, 0];
          writePixel(output, width, height, blockX * 4 + pixelX, blockY * 4 + pixelY, [
            colour[0],
            colour[1],
            colour[2],
            format === 'dxt1' ? colour[3] : (alphas[pixel] ?? 255),
          ]);
        }
      }
    }
  }
  return output;
}

function countTrailingZeros(mask: number): number {
  if (mask === 0) return 0;
  let result = 0;
  let value = mask >>> 0;
  while ((value & 1) === 0) {
    result += 1;
    value >>>= 1;
  }
  return result;
}

function extractChannel(pixel: number, mask: number, fallback: number): number {
  if (mask === 0) return fallback;
  const shift = countTrailingZeros(mask);
  const normalizedMask = mask >>> shift;
  const value = (pixel & mask) >>> shift;
  return Math.round((value * 255) / normalizedMask);
}

function decodeRgb(
  bytes: Buffer,
  dataOffset: number,
  width: number,
  height: number,
  bitCount: 24 | 32,
  pitch: number,
  masks: readonly [number, number, number, number],
): Buffer | undefined {
  const bytesPerPixel = bitCount / 8;
  const rowPitch = Math.max(pitch, width * bytesPerPixel);
  if (bytes.length < dataOffset + rowPitch * height) return undefined;
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = dataOffset + y * rowPitch + x * bytesPerPixel;
      const pixel =
        bitCount === 32
          ? bytes.readUInt32LE(source)
          : byte(bytes, source) | (byte(bytes, source + 1) << 8) | (byte(bytes, source + 2) << 16);
      const target = (y * width + x) * 4;
      output[target] = extractChannel(pixel, masks[0], 0);
      output[target + 1] = extractChannel(pixel, masks[1], 0);
      output[target + 2] = extractChannel(pixel, masks[2], 0);
      output[target + 3] = extractChannel(pixel, masks[3], 255);
    }
  }
  return output;
}

/** Decode the first DDS mip level used by HOI4 GUI atlases. */
export function decodeDds(
  bytes: Buffer,
  budget = new RenderBudget(),
  operationKey = `dds:${sha256Bytes(bytes)}`,
): DdsDecodeResult {
  if (bytes.length < 128 || bytes.readUInt32LE(0) !== DDS_MAGIC)
    return unsupported('not-dds', 'The file does not contain a complete DDS header.');
  if (bytes.readUInt32LE(4) !== 124 || bytes.readUInt32LE(76) !== 32)
    return unsupported(
      'invalid-header',
      'The DDS header or pixel format header has an unsupported size.',
    );
  const height = bytes.readUInt32LE(12);
  const width = bytes.readUInt32LE(16);
  if (width === 0 || height === 0)
    return unsupported('invalid-dimensions', `Invalid DDS dimensions ${width}x${height}.`);
  budget.reserveRasterOperation(operationKey, 'DDS texture decode');
  budget.reserve(width, height, 'DDS texture decode', {
    maximumPixels: RENDER_MAX_DECODED_PIXELS,
  });
  const pitch = bytes.readUInt32LE(20);
  const flags = bytes.readUInt32LE(80);
  const code = fourCc(bytes, 84).toUpperCase();
  if ((flags & DDPF_FOURCC) !== 0) {
    if (code === 'RXGB')
      return unsupported(
        'RXGB',
        'RXGB is a map-oriented swizzled DXT5 format and is intentionally not interpreted as GUI colour artwork.',
      );
    if (code === 'DX10') {
      if (bytes.length < 148)
        return unsupported('DX10', 'The DDS DX10 extension header is truncated.');
      const dxgiFormat = bytes.readUInt32LE(128);
      const arraySize = bytes.readUInt32LE(140);
      if (arraySize !== 1)
        return unsupported(
          `DX10/${dxgiFormat}`,
          'DDS texture arrays are not supported by the offline GUI renderer.',
        );
      const format =
        dxgiFormat === 29 ? 'dx10-rgba8-srgb' : dxgiFormat === 91 ? 'dx10-bgra8-srgb' : undefined;
      if (format === undefined)
        return unsupported(
          `DX10/${dxgiFormat}`,
          `DXGI format ${dxgiFormat} is not one of the vanilla GUI formats (29 or 91).`,
        );
      const required = 148 + width * height * 4;
      if (bytes.length < required) return unsupported(format, 'The DDS pixel data is truncated.');
      const output = Buffer.alloc(width * height * 4);
      for (let index = 0; index < width * height; index += 1) {
        const source = 148 + index * 4;
        const target = index * 4;
        if (format === 'dx10-rgba8-srgb') {
          output[target] = byte(bytes, source);
          output[target + 1] = byte(bytes, source + 1);
          output[target + 2] = byte(bytes, source + 2);
        } else {
          output[target] = byte(bytes, source + 2);
          output[target + 1] = byte(bytes, source + 1);
          output[target + 2] = byte(bytes, source);
        }
        output[target + 3] = byte(bytes, source + 3);
      }
      return { width, height, data: output, format };
    }
    const format =
      code === 'DXT1' ? 'dxt1' : code === 'DXT3' ? 'dxt3' : code === 'DXT5' ? 'dxt5' : undefined;
    if (format === undefined)
      return unsupported(
        code || 'fourcc-empty',
        `DDS FourCC ${code || '<empty>'} is not supported for GUI rendering.`,
      );
    const output = decodeDxt(bytes, 128, width, height, format);
    return output === undefined
      ? unsupported(format, 'The DDS block data is truncated.')
      : { width, height, data: output, format };
  }
  if ((flags & DDPF_RGB) === 0)
    return unsupported('non-rgb', 'The DDS is neither RGB nor a recognised compressed format.');
  const bitCount = bytes.readUInt32LE(88);
  if (bitCount !== 24 && bitCount !== 32)
    return unsupported(
      `rgb${bitCount}`,
      `RGB DDS bit depth ${bitCount} is unsupported; expected 24 or 32.`,
    );
  const masks = [
    bytes.readUInt32LE(92),
    bytes.readUInt32LE(96),
    bytes.readUInt32LE(100),
    bytes.readUInt32LE(104),
  ] as const;
  const output = decodeRgb(bytes, 128, width, height, bitCount, pitch, masks);
  const format = bitCount === 24 ? 'rgb24' : 'rgba32';
  return output === undefined
    ? unsupported(format, 'The DDS RGB pixel data is truncated.')
    : { width, height, data: output, format };
}
