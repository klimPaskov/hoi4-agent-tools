import { describe, expect, it } from 'vitest';
import { BmpImage, createBmp, type RgbColor } from '../../src/hoi4_agent_tools/map/bmp.js';

const colors: RgbColor[] = [
  { r: 10, g: 20, b: 30 },
  { r: 40, g: 50, b: 60 },
  { r: 70, g: 80, b: 90 },
  { r: 100, g: 110, b: 120 },
  { r: 130, g: 140, b: 150 },
  { r: 160, g: 170, b: 180 },
];

function markRowPadding(bytes: Buffer, value: number): Buffer {
  const result = Buffer.from(bytes);
  const image = BmpImage.decode(result);
  const pixelBytes = (image.width * image.bitsPerPixel) / 8;
  for (let row = 0; row < image.height; row += 1) {
    result.fill(
      value,
      image.pixelOffset + row * image.rowStride + pixelBytes,
      image.pixelOffset + (row + 1) * image.rowStride,
    );
  }
  return result;
}

describe('preservation-oriented HOI4 BMP codec', () => {
  it('blocks hostile BMP header and create dimensions before copying or allocating pixels', () => {
    const header = Buffer.alloc(54);
    header.write('BM', 0, 'ascii');
    header.writeUInt32LE(54, 2);
    header.writeUInt32LE(54, 10);
    header.writeUInt32LE(40, 14);
    header.writeInt32LE(8_192, 18);
    header.writeInt32LE(6_145, 22);
    header.writeUInt16LE(1, 26);
    header.writeUInt16LE(24, 28);
    expect(() => BmpImage.decode(header)).toThrowError(
      expect.objectContaining({ code: 'RENDER_PIXELS_BLOCKED' }),
    );
    expect(() =>
      createBmp({
        width: 8_192,
        height: 6_145,
        bitsPerPixel: 24,
        rgbPixels: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'RENDER_PIXELS_BLOCKED' }));
  });

  for (const dibSize of [40, 124] as const) {
    for (const topDown of [false, true]) {
      it(`round-trips byte-exact DIB${dibSize} 24-bit ${topDown ? 'top-down' : 'bottom-up'} rows with padding`, () => {
        let bytes = createBmp({
          width: 3,
          height: 2,
          bitsPerPixel: 24,
          dibSize,
          topDown,
          rgbPixels: colors,
        });
        bytes = markRowPadding(bytes, 0xa5);
        if (dibSize === 124) {
          for (let offset = 54; offset < 14 + 124; offset += 1)
            bytes[offset] = (offset * 17) & 0xff;
        }
        const image = BmpImage.decode(bytes);
        expect(image.dibSize).toBe(dibSize);
        expect(image.topDown).toBe(topDown);
        expect(image.rowStride).toBe(12);
        expect(image.rgbAt(0, 0)).toEqual(colors[0]);
        expect(image.rgbAt(2, 1)).toEqual(colors[5]);
        expect(image.encode()).toEqual(bytes);

        const changed = image.withRgbChanges([{ x: 1, y: 0, color: { r: 201, g: 202, b: 203 } }]);
        const differing = [...changed.bytes.keys()].filter(
          (offset) => changed.bytes[offset] !== bytes[offset],
        );
        expect(differing).toHaveLength(3);
        expect(changed.rgbAt(1, 0)).toEqual({ r: 201, g: 202, b: 203 });
        expect(changed.diffBounds(image)).toEqual({ minX: 1, minY: 0, maxX: 1, maxY: 0, count: 1 });

        const offsetChanged = image.withRgbOffsets(Uint32Array.of(1, 5), {
          r: 201,
          g: 202,
          b: 203,
        });
        expect(offsetChanged.rgbAt(1, 0)).toEqual({ r: 201, g: 202, b: 203 });
        expect(offsetChanged.rgbAt(2, 1)).toEqual({ r: 201, g: 202, b: 203 });
        const packedChanged = image.withPackedRgbOffsetChanges(
          Uint32Array.of(0, 5),
          Uint32Array.of(0xc9cacb, 0x010203),
        );
        expect(packedChanged.rgbAt(0, 0)).toEqual({ r: 201, g: 202, b: 203 });
        expect(packedChanged.rgbAt(2, 1)).toEqual({ r: 1, g: 2, b: 3 });
      });
    }
  }

  for (const dibSize of [40, 124] as const) {
    it(`round-trips byte-exact DIB${dibSize} 8-bit palettes without normalising palette or padding bytes`, () => {
      const palette = [
        { r: 3, g: 2, b: 1 },
        { r: 30, g: 20, b: 10 },
        { r: 90, g: 80, b: 70 },
      ];
      let bytes = createBmp({
        width: 3,
        height: 2,
        bitsPerPixel: 8,
        dibSize,
        palette,
        indexedPixels: Uint8Array.from([0, 1, 2, 2, 1, 0]),
      });
      bytes = markRowPadding(bytes, 0x6d);
      const paletteOffset = 14 + dibSize;
      bytes[paletteOffset + 3] = 0xee;
      bytes[paletteOffset + 7] = 0xdd;
      const image = BmpImage.decode(bytes);
      expect(image.paletteIndexAt(2, 0)).toBe(2);
      expect(image.rgbAt(2, 0)).toEqual(palette[2]);
      expect(image.encode()).toEqual(bytes);

      const changed = image.withIndexedChanges([{ x: 0, y: 1, index: 1 }]);
      const differing = [...changed.bytes.keys()].filter(
        (offset) => changed.bytes[offset] !== bytes[offset],
      );
      expect(differing).toHaveLength(1);
      expect(changed.paletteIndexAt(0, 1)).toBe(1);
      expect(changed.bytes.subarray(0, image.pixelOffset)).toEqual(
        bytes.subarray(0, image.pixelOffset),
      );
    });
  }

  it('rejects compressed and unsupported map BMP variants rather than silently converting them', () => {
    const bytes = createBmp({
      width: 1,
      height: 1,
      bitsPerPixel: 24,
      rgbPixels: [{ r: 1, g: 2, b: 3 }],
    });
    bytes.writeUInt32LE(1, 30);
    expect(() => BmpImage.decode(bytes)).toThrow(/Compressed map BMP files are not supported/u);
  });
});
