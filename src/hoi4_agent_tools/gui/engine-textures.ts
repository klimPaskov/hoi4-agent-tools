import { sharedResidentEngine, type ResidentEngine } from '../core/resident-engine.js';

/**
 * Texture formats the TypeScript decoders do not read (BC4, BC5, BC7 and packed DX10 formats,
 * luminance and alpha-only DDS) are decoded by the Rust engine (`hoi4-texture`, ADR 0074)
 * through the resident engine process. The engine is optional: without it these textures stay
 * unsupported and the diagnostic says how to get it.
 */

export interface EngineDecodedTexture {
  width: number;
  height: number;
  data: Buffer;
  format: string;
}

export type EngineTextureOutcome =
  | { decoded: EngineDecodedTexture }
  | { unsupported: true; format: string; reason: string; engineAvailable: boolean };

/** Formats the game is known to mishandle, with the evidence; a preview still draws them. */
export const RISKY_TEXTURE_FORMATS: Readonly<Record<string, string>> = {
  BC7_UNORM:
    'In an in-game check on game 1.19.4.1 a BC7 texture failed with "Expected more data in the texture mipmaps" and "Failed to create 2D texture", and the game then crashed. Convert it to DXT5 or 32-bit uncompressed, or check it in game.',
  BC7_UNORM_SRGB:
    'In an in-game check on game 1.19.4.1 a BC7 texture failed with "Expected more data in the texture mipmaps" and "Failed to create 2D texture", and the game then crashed. Convert it to DXT5 or 32-bit uncompressed, or check it in game.',
  BC7_TYPELESS:
    'In an in-game check on game 1.19.4.1 a BC7 texture failed with "Expected more data in the texture mipmaps" and "Failed to create 2D texture", and the game then crashed. Convert it to DXT5 or 32-bit uncompressed, or check it in game.',
};

export const ENGINE_TEXTURE_HINT =
  'Install a hoi4-agent-tools release that ships the hoi4-engine binary, or set HOI4_ENGINE to its absolute path, to decode this format.';

export async function decodeTextureWithEngine(
  bytes: Buffer,
  extension: 'dds' | 'tga' | 'png',
  maxPixels: number,
  options: { engine?: ResidentEngine; signal?: AbortSignal } = {},
): Promise<EngineTextureOutcome> {
  const engine = options.engine ?? sharedResidentEngine();
  const outcome = await engine.request(
    'texture.decode',
    { extension, maxPixels },
    bytes,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  if (outcome.ok) {
    const { width, height, format } = outcome.response.result;
    const data = outcome.response.payload;
    if (
      typeof width === 'number' &&
      typeof height === 'number' &&
      Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width > 0 &&
      height > 0 &&
      width * height <= maxPixels &&
      data.length === width * height * 4
    )
      return {
        decoded: { width, height, data, format: typeof format === 'string' ? format : extension },
      };
    return {
      unsupported: true,
      format: extension,
      reason: 'The engine returned a texture whose size does not match its pixels.',
      engineAvailable: true,
    };
  }
  if (outcome.kind === 'error') {
    const format = typeof outcome.details.format === 'string' ? outcome.details.format : extension;
    return {
      unsupported: true,
      format,
      reason: `${format}: ${outcome.message}`,
      engineAvailable: true,
    };
  }
  return {
    unsupported: true,
    format: extension,
    reason: `The Rust engine is unavailable (${outcome.message}). ${ENGINE_TEXTURE_HINT}`,
    engineAvailable: false,
  };
}
