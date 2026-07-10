import { assertRenderDimensions } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface PixelPoint {
  x: number;
  y: number;
}

export interface RgbPixelChange extends PixelPoint {
  color: RgbColor;
}

export interface IndexedPixelChange extends PixelPoint {
  index: number;
}

export interface PixelDiffBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
}

export interface CreateBmpOptions {
  width: number;
  height: number;
  bitsPerPixel: 8 | 24;
  dibSize?: 40 | 124;
  topDown?: boolean;
  palette?: readonly RgbColor[];
  rgbPixels?: readonly RgbColor[];
  indexedPixels?: Uint8Array;
}

function assertByte(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new ServiceError('MAP_BMP_CHANNEL_INVALID', `${label} must be an integer from 0 to 255`, {
      value,
    });
  }
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ServiceError(
      'MAP_BMP_DIMENSIONS_INVALID',
      'BMP dimensions must be positive integers',
      {
        width,
        height,
      },
    );
  }
  assertRenderDimensions(width, height, 'map BMP');
}

function rowStride(width: number, bitsPerPixel: number): number {
  return Math.ceil((width * bitsPerPixel) / 32) * 4;
}

/**
 * Preservation-oriented decoder for the uncompressed BMP variants used by HOI4 maps.
 * Coordinates exposed by this class are always top-left based, independently of storage order.
 */
export class BmpImage {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly topDown: boolean;
  readonly bitsPerPixel: 8 | 24;
  readonly dibSize: 40 | 124;
  readonly pixelOffset: number;
  readonly rowStride: number;
  readonly palette: readonly RgbColor[];

  private constructor(input: {
    bytes: Buffer;
    width: number;
    height: number;
    topDown: boolean;
    bitsPerPixel: 8 | 24;
    dibSize: 40 | 124;
    pixelOffset: number;
    rowStride: number;
    palette: RgbColor[];
  }) {
    this.bytes = input.bytes;
    this.width = input.width;
    this.height = input.height;
    this.topDown = input.topDown;
    this.bitsPerPixel = input.bitsPerPixel;
    this.dibSize = input.dibSize;
    this.pixelOffset = input.pixelOffset;
    this.rowStride = input.rowStride;
    this.palette = input.palette;
  }

  static decode(input: Uint8Array): BmpImage {
    const bytes = Buffer.isBuffer(input)
      ? input
      : Buffer.from(input.buffer as ArrayBuffer, input.byteOffset, input.byteLength);
    if (bytes.length < 54 || bytes.toString('ascii', 0, 2) !== 'BM') {
      throw new ServiceError('MAP_BMP_SIGNATURE_INVALID', 'File is not a Windows BMP');
    }
    const pixelOffset = bytes.readUInt32LE(10);
    const dibSize = bytes.readUInt32LE(14);
    if (dibSize !== 40 && dibSize !== 124) {
      throw new ServiceError(
        'MAP_BMP_DIB_UNSUPPORTED',
        'Only DIB40 and DIB124 BMP headers are supported',
        {
          dibSize,
        },
      );
    }
    if (bytes.length < 14 + dibSize) {
      throw new ServiceError('MAP_BMP_TRUNCATED', 'BMP ends inside its DIB header');
    }
    const width = bytes.readInt32LE(18);
    const signedHeight = bytes.readInt32LE(22);
    if (signedHeight === -2_147_483_648) {
      throw new ServiceError('MAP_BMP_DIMENSIONS_INVALID', 'BMP height cannot be INT32_MIN');
    }
    const height = Math.abs(signedHeight);
    assertDimensions(width, height);
    if (bytes.readUInt16LE(26) !== 1) {
      throw new ServiceError('MAP_BMP_PLANES_INVALID', 'BMP must contain exactly one plane');
    }
    const rawBitsPerPixel = bytes.readUInt16LE(28);
    if (rawBitsPerPixel !== 8 && rawBitsPerPixel !== 24) {
      throw new ServiceError(
        'MAP_BMP_BPP_UNSUPPORTED',
        'HOI4 map BMP codec supports only 8-bit indexed and 24-bit RGB files',
        { bitsPerPixel: rawBitsPerPixel },
      );
    }
    if (bytes.readUInt32LE(30) !== 0) {
      throw new ServiceError(
        'MAP_BMP_COMPRESSION_UNSUPPORTED',
        'Compressed map BMP files are not supported',
      );
    }
    const bitsPerPixel = rawBitsPerPixel;
    const stride = rowStride(width, bitsPerPixel);
    const pixelBytes = stride * height;
    if (pixelOffset < 14 + dibSize || pixelOffset + pixelBytes > bytes.length) {
      throw new ServiceError('MAP_BMP_TRUNCATED', 'BMP pixel array is outside the file bounds', {
        pixelOffset,
        pixelBytes,
        fileSize: bytes.length,
      });
    }
    const palette: RgbColor[] = [];
    if (bitsPerPixel === 8) {
      const availableEntries = Math.floor((pixelOffset - (14 + dibSize)) / 4);
      const colorsUsed = bytes.readUInt32LE(46);
      const entryCount = colorsUsed === 0 ? Math.min(256, availableEntries) : colorsUsed;
      if (entryCount > 256 || entryCount > availableEntries) {
        throw new ServiceError('MAP_BMP_PALETTE_INVALID', 'Indexed BMP palette is incomplete', {
          colorsUsed,
          availableEntries,
        });
      }
      for (let index = 0; index < entryCount; index += 1) {
        const offset = 14 + dibSize + index * 4;
        palette.push({
          r: bytes.readUInt8(offset + 2),
          g: bytes.readUInt8(offset + 1),
          b: bytes.readUInt8(offset),
        });
      }
    }
    return new BmpImage({
      bytes: Buffer.from(bytes),
      width,
      height,
      topDown: signedHeight < 0,
      bitsPerPixel,
      dibSize,
      pixelOffset,
      rowStride: stride,
      palette,
    });
  }

  encode(): Buffer {
    assertRenderDimensions(this.width, this.height, 'map BMP encode');
    return Buffer.from(this.bytes);
  }

  rgbAt(x: number, y: number): RgbColor {
    const offset = this.offsetAt(x, y);
    if (this.bitsPerPixel === 24) {
      return {
        r: this.bytes.readUInt8(offset + 2),
        g: this.bytes.readUInt8(offset + 1),
        b: this.bytes.readUInt8(offset),
      };
    }
    const index = this.bytes.readUInt8(offset);
    const color = this.palette[index];
    if (color === undefined) {
      throw new ServiceError(
        'MAP_BMP_PALETTE_INDEX_INVALID',
        'Pixel refers outside the BMP palette',
        {
          x,
          y,
          index,
        },
      );
    }
    return color;
  }

  paletteIndexAt(x: number, y: number): number {
    if (this.bitsPerPixel !== 8) {
      throw new ServiceError(
        'MAP_BMP_NOT_INDEXED',
        'Palette indexes are available only for 8-bit BMP files',
      );
    }
    return this.bytes.readUInt8(this.offsetAt(x, y));
  }

  withRgbChanges(changes: readonly RgbPixelChange[]): BmpImage {
    if (this.bitsPerPixel !== 24) {
      throw new ServiceError('MAP_BMP_NOT_RGB', 'RGB changes require a 24-bit BMP');
    }
    assertRenderDimensions(this.width, this.height, 'map BMP RGB mutation');
    const bytes = Buffer.from(this.bytes);
    for (const change of changes) {
      assertByte(change.color.r, 'red');
      assertByte(change.color.g, 'green');
      assertByte(change.color.b, 'blue');
      const offset = this.offsetAt(change.x, change.y);
      bytes[offset] = change.color.b;
      bytes[offset + 1] = change.color.g;
      bytes[offset + 2] = change.color.r;
    }
    return BmpImage.decode(bytes);
  }

  withRgbOffsets(offsets: Uint32Array, color: RgbColor): BmpImage {
    if (this.bitsPerPixel !== 24) {
      throw new ServiceError('MAP_BMP_NOT_RGB', 'RGB changes require a 24-bit BMP');
    }
    assertRenderDimensions(this.width, this.height, 'map BMP RGB offset mutation');
    assertByte(color.r, 'red');
    assertByte(color.g, 'green');
    assertByte(color.b, 'blue');
    const bytes = Buffer.from(this.bytes);
    for (const logicalOffset of offsets) {
      const byteOffset = this.byteOffsetForLogicalOffset(logicalOffset);
      bytes[byteOffset] = color.b;
      bytes[byteOffset + 1] = color.g;
      bytes[byteOffset + 2] = color.r;
    }
    return BmpImage.decode(bytes);
  }

  withPackedRgbOffsetChanges(
    offsets: ArrayLike<number>,
    packedColors: ArrayLike<number>,
  ): BmpImage {
    if (this.bitsPerPixel !== 24) {
      throw new ServiceError('MAP_BMP_NOT_RGB', 'RGB changes require a 24-bit BMP');
    }
    if (offsets.length !== packedColors.length) {
      throw new ServiceError(
        'MAP_BMP_CHANGE_LENGTH_MISMATCH',
        'RGB offset and color buffers must have identical lengths',
        { offsets: offsets.length, colors: packedColors.length },
      );
    }
    assertRenderDimensions(this.width, this.height, 'map BMP packed RGB offset mutation');
    const bytes = Buffer.from(this.bytes);
    for (let index = 0; index < offsets.length; index += 1) {
      const packed = packedColors[index];
      if (packed === undefined || !Number.isInteger(packed) || packed < 0 || packed > 0xffffff) {
        throw new ServiceError(
          'MAP_BMP_CHANNEL_INVALID',
          'Packed RGB color must be an integer from 0 to 0xFFFFFF',
          { packed },
        );
      }
      const byteOffset = this.byteOffsetForLogicalOffset(offsets[index]);
      bytes[byteOffset] = packed & 0xff;
      bytes[byteOffset + 1] = (packed >>> 8) & 0xff;
      bytes[byteOffset + 2] = (packed >>> 16) & 0xff;
    }
    return BmpImage.decode(bytes);
  }

  withIndexedChanges(changes: readonly IndexedPixelChange[]): BmpImage {
    if (this.bitsPerPixel !== 8) {
      throw new ServiceError('MAP_BMP_NOT_INDEXED', 'Indexed changes require an 8-bit BMP');
    }
    assertRenderDimensions(this.width, this.height, 'map BMP indexed mutation');
    const bytes = Buffer.from(this.bytes);
    for (const change of changes) {
      assertByte(change.index, 'palette index');
      if (change.index >= this.palette.length) {
        throw new ServiceError(
          'MAP_BMP_PALETTE_INDEX_INVALID',
          'Change refers outside the BMP palette',
          {
            ...change,
            paletteSize: this.palette.length,
          },
        );
      }
      bytes[this.offsetAt(change.x, change.y)] = change.index;
    }
    return BmpImage.decode(bytes);
  }

  diffBounds(other: BmpImage): PixelDiffBounds | undefined {
    if (this.width !== other.width || this.height !== other.height) {
      throw new ServiceError(
        'MAP_BMP_DIMENSION_MISMATCH',
        'Cannot diff BMPs with different dimensions',
      );
    }
    let minX = this.width;
    let minY = this.height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const left = this.rgbAt(x, y);
        const right = other.rgbAt(x, y);
        if (left.r === right.r && left.g === right.g && left.b === right.b) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
      }
    }
    return count === 0 ? undefined : { minX, minY, maxX, maxY, count };
  }

  private offsetAt(x: number, y: number): number {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= this.width ||
      y >= this.height
    ) {
      throw new ServiceError('MAP_BMP_COORDINATE_INVALID', 'Pixel coordinate is outside the BMP', {
        x,
        y,
        width: this.width,
        height: this.height,
      });
    }
    const storedRow = this.topDown ? y : this.height - 1 - y;
    const bytesPerPixel = this.bitsPerPixel / 8;
    return this.pixelOffset + storedRow * this.rowStride + x * bytesPerPixel;
  }

  private byteOffsetForLogicalOffset(logicalOffset: number | undefined): number {
    const pixelCount = this.width * this.height;
    if (
      logicalOffset === undefined ||
      !Number.isInteger(logicalOffset) ||
      logicalOffset < 0 ||
      logicalOffset >= pixelCount
    ) {
      throw new ServiceError(
        'MAP_BMP_COORDINATE_INVALID',
        'Logical pixel offset is outside the BMP',
        { logicalOffset, pixelCount },
      );
    }
    return this.offsetAt(logicalOffset % this.width, Math.floor(logicalOffset / this.width));
  }
}

export function createBmp(options: CreateBmpOptions): Buffer {
  assertDimensions(options.width, options.height);
  const dibSize = options.dibSize ?? 40;
  const topDown = options.topDown ?? false;
  const palette = options.palette ?? [];
  if (options.bitsPerPixel === 8 && (palette.length === 0 || palette.length > 256)) {
    throw new ServiceError(
      'MAP_BMP_PALETTE_INVALID',
      'An 8-bit BMP requires 1 to 256 palette entries',
    );
  }
  if (options.bitsPerPixel === 24 && palette.length > 0) {
    throw new ServiceError(
      'MAP_BMP_PALETTE_INVALID',
      'A 24-bit BMP cannot contain an indexed palette',
    );
  }
  const pixelCount = options.width * options.height;
  if (options.bitsPerPixel === 24 && (options.rgbPixels?.length ?? 0) !== pixelCount) {
    throw new ServiceError(
      'MAP_BMP_PIXEL_COUNT_INVALID',
      'RGB pixel count does not match BMP dimensions',
    );
  }
  if (options.bitsPerPixel === 8 && (options.indexedPixels?.length ?? 0) !== pixelCount) {
    throw new ServiceError(
      'MAP_BMP_PIXEL_COUNT_INVALID',
      'Indexed pixel count does not match BMP dimensions',
    );
  }
  for (const color of palette) {
    assertByte(color.r, 'red');
    assertByte(color.g, 'green');
    assertByte(color.b, 'blue');
  }
  const stride = rowStride(options.width, options.bitsPerPixel);
  const pixelOffset = 14 + dibSize + palette.length * 4;
  const fileSize = pixelOffset + stride * options.height;
  const bytes = Buffer.alloc(fileSize);
  bytes.write('BM', 0, 'ascii');
  bytes.writeUInt32LE(fileSize, 2);
  bytes.writeUInt32LE(pixelOffset, 10);
  bytes.writeUInt32LE(dibSize, 14);
  bytes.writeInt32LE(options.width, 18);
  bytes.writeInt32LE(topDown ? -options.height : options.height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(options.bitsPerPixel, 28);
  bytes.writeUInt32LE(0, 30);
  bytes.writeUInt32LE(stride * options.height, 34);
  if (options.bitsPerPixel === 8)
    bytes.writeUInt32LE(palette.length === 256 ? 256 : palette.length, 46);
  for (const [index, color] of palette.entries()) {
    const offset = 14 + dibSize + index * 4;
    bytes[offset] = color.b;
    bytes[offset + 1] = color.g;
    bytes[offset + 2] = color.r;
  }
  for (let y = 0; y < options.height; y += 1) {
    const storedRow = topDown ? y : options.height - 1 - y;
    const rowOffset = pixelOffset + storedRow * stride;
    for (let x = 0; x < options.width; x += 1) {
      const logicalIndex = y * options.width + x;
      if (options.bitsPerPixel === 8) {
        const index = options.indexedPixels?.[logicalIndex];
        if (index === undefined) {
          throw new ServiceError('MAP_BMP_PIXEL_COUNT_INVALID', 'Indexed pixel is missing');
        }
        if (index >= palette.length) {
          throw new ServiceError(
            'MAP_BMP_PALETTE_INDEX_INVALID',
            'Pixel refers outside the supplied palette',
            {
              x,
              y,
              index,
            },
          );
        }
        bytes[rowOffset + x] = index;
      } else {
        const color = options.rgbPixels?.[logicalIndex];
        if (color === undefined) {
          throw new ServiceError('MAP_BMP_PIXEL_COUNT_INVALID', 'RGB pixel is missing');
        }
        assertByte(color.r, 'red');
        assertByte(color.g, 'green');
        assertByte(color.b, 'blue');
        const offset = rowOffset + x * 3;
        bytes[offset] = color.b;
        bytes[offset + 1] = color.g;
        bytes[offset + 2] = color.r;
      }
    }
  }
  return bytes;
}

export function rgbKey(color: RgbColor): string {
  return `${color.r},${color.g},${color.b}`;
}
