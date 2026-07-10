import { RenderBudget, RENDER_MAX_DECODED_PIXELS } from '../core/render-budget.js';
import { sha256Bytes } from '../core/canonical.js';

export interface DecodedTga {
  width: number;
  height: number;
  data: Buffer;
  format: string;
}

export interface UnsupportedTga {
  unsupported: true;
  reason: string;
  format: string;
}

export type TgaDecodeResult = DecodedTga | UnsupportedTga;

function unsupported(format: string, reason: string): UnsupportedTga {
  return { unsupported: true, format, reason };
}

/** Decode the true-colour, greyscale, and indexed TGA variants used by vanilla GUI assets. */
export function decodeTga(
  bytes: Buffer,
  budget = new RenderBudget(),
  operationKey = `tga:${sha256Bytes(bytes)}`,
): TgaDecodeResult {
  if (bytes.length < 18) return unsupported('tga', 'The TGA header is truncated.');
  const idLength = bytes.readUInt8(0);
  const colourMapType = bytes.readUInt8(1);
  const imageType = bytes.readUInt8(2);
  const colourMapFirst = bytes.readUInt16LE(3);
  const colourMapLength = bytes.readUInt16LE(5);
  const colourMapDepth = bytes.readUInt8(7);
  const width = bytes.readUInt16LE(12);
  const height = bytes.readUInt16LE(14);
  const depth = bytes.readUInt8(16);
  const descriptor = bytes.readUInt8(17);
  if (width === 0 || height === 0)
    return unsupported('tga', `Invalid TGA dimensions ${width}x${height}.`);
  budget.reserveRasterOperation(operationKey, 'TGA texture decode');
  budget.reserve(width, height, 'TGA texture decode', {
    maximumPixels: RENDER_MAX_DECODED_PIXELS,
  });
  const rle = imageType === 9 || imageType === 10 || imageType === 11;
  const baseType = rle ? imageType - 8 : imageType;
  if (![1, 2, 3].includes(baseType))
    return unsupported(
      `tga-type-${imageType}`,
      `TGA image type ${imageType} is not indexed, true-colour, or greyscale.`,
    );
  if (baseType === 1 && colourMapType !== 1)
    return unsupported('tga-indexed', 'Indexed TGA data does not declare a colour map.');
  if (baseType === 2 && depth !== 16 && depth !== 24 && depth !== 32)
    return unsupported(`tga-rgb${depth}`, `TGA true-colour depth ${depth} is unsupported.`);
  if (baseType === 3 && depth !== 8 && depth !== 16)
    return unsupported(`tga-gray${depth}`, `TGA greyscale depth ${depth} is unsupported.`);
  if (baseType === 1 && depth !== 8 && depth !== 16)
    return unsupported(`tga-index${depth}`, `TGA index depth ${depth} is unsupported.`);

  let cursor = 18 + idLength;
  const palette: (readonly [number, number, number, number])[] = [];
  if (colourMapType === 1) {
    const entryBytes = Math.ceil(colourMapDepth / 8);
    if (![2, 3, 4].includes(entryBytes))
      return unsupported(
        `tga-palette${colourMapDepth}`,
        `TGA palette depth ${colourMapDepth} is unsupported.`,
      );
    if (bytes.length < cursor + colourMapLength * entryBytes)
      return unsupported('tga-palette', 'The TGA colour map is truncated.');
    for (let index = 0; index < colourMapLength; index += 1) {
      const source = cursor + index * entryBytes;
      if (entryBytes === 2) {
        const packed = bytes.readUInt16LE(source);
        palette[colourMapFirst + index] = [
          Math.round((((packed >> 10) & 0x1f) * 255) / 31),
          Math.round((((packed >> 5) & 0x1f) * 255) / 31),
          Math.round(((packed & 0x1f) * 255) / 31),
          (descriptor & 0x0f) === 0 || (packed & 0x8000) !== 0 ? 255 : 0,
        ];
      } else {
        palette[colourMapFirst + index] = [
          bytes.readUInt8(source + 2),
          bytes.readUInt8(source + 1),
          bytes.readUInt8(source),
          entryBytes === 4 ? bytes.readUInt8(source + 3) : 255,
        ];
      }
    }
    cursor += colourMapLength * entryBytes;
  }

  const pixelBytes = Math.ceil(depth / 8);
  const totalPixels = width * height;
  const output = Buffer.alloc(totalPixels * 4);
  const topOrigin = (descriptor & 0x20) !== 0;
  const rightOrigin = (descriptor & 0x10) !== 0;
  let decodedPixels = 0;
  const writeDecodedPixel = (colour: readonly [number, number, number, number]): void => {
    const sourceX = decodedPixels % width;
    const sourceY = Math.floor(decodedPixels / width);
    const targetX = rightOrigin ? width - sourceX - 1 : sourceX;
    const targetY = topOrigin ? sourceY : height - sourceY - 1;
    const target = (targetY * width + targetX) * 4;
    output[target] = colour[0];
    output[target + 1] = colour[1];
    output[target + 2] = colour[2];
    output[target + 3] = colour[3];
    decodedPixels += 1;
  };
  const readPixel = (): readonly [number, number, number, number] | undefined => {
    if (cursor + pixelBytes > bytes.length) return undefined;
    let colour: readonly [number, number, number, number];
    if (baseType === 1) {
      const index = depth === 8 ? bytes.readUInt8(cursor) : bytes.readUInt16LE(cursor);
      colour = palette[index] ?? [255, 0, 255, 255];
    } else if (baseType === 3) {
      const grey = bytes.readUInt8(cursor);
      colour = [grey, grey, grey, depth === 16 ? bytes.readUInt8(cursor + 1) : 255];
    } else if (depth === 16) {
      const packed = bytes.readUInt16LE(cursor);
      colour = [
        Math.round((((packed >> 10) & 0x1f) * 255) / 31),
        Math.round((((packed >> 5) & 0x1f) * 255) / 31),
        Math.round(((packed & 0x1f) * 255) / 31),
        (descriptor & 0x0f) === 0 || (packed & 0x8000) !== 0 ? 255 : 0,
      ];
    } else {
      colour = [
        bytes.readUInt8(cursor + 2),
        bytes.readUInt8(cursor + 1),
        bytes.readUInt8(cursor),
        depth === 32 ? bytes.readUInt8(cursor + 3) : 255,
      ];
    }
    cursor += pixelBytes;
    return colour;
  };

  if (rle) {
    while (decodedPixels < totalPixels) {
      if (cursor >= bytes.length) return unsupported('tga-rle', 'The TGA RLE stream is truncated.');
      const packet = bytes.readUInt8(cursor);
      cursor += 1;
      const count = (packet & 0x7f) + 1;
      if ((packet & 0x80) !== 0) {
        const colour = readPixel();
        if (colour === undefined) return unsupported('tga-rle', 'The TGA RLE pixel is truncated.');
        for (let index = 0; index < count && decodedPixels < totalPixels; index += 1)
          writeDecodedPixel(colour);
      } else {
        for (let index = 0; index < count && decodedPixels < totalPixels; index += 1) {
          const colour = readPixel();
          if (colour === undefined)
            return unsupported('tga-rle', 'The TGA raw RLE packet is truncated.');
          writeDecodedPixel(colour);
        }
      }
    }
  } else {
    for (let index = 0; index < totalPixels; index += 1) {
      const colour = readPixel();
      if (colour === undefined) return unsupported('tga', 'The TGA pixel data is truncated.');
      writeDecodedPixel(colour);
    }
  }
  return {
    width,
    height,
    data: output,
    format: `tga-${rle ? 'rle-' : ''}${baseType === 1 ? 'indexed' : baseType === 2 ? 'rgba' : 'gray'}${depth}`,
  };
}
