import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Optional meaning-based matching for documentation search (ADR 0075).
 *
 * Word ranking cannot connect "access to the sea" with `is_coastal`. A small sentence
 * embedding model can, so when `HOI4_REFERENCE_EMBEDDINGS` names a cache folder and the
 * pinned runtime is installed, search blends meaning similarity into the word ranking.
 * The model, its revision, every file's hash and the runtime version are pinned; a file
 * whose hash differs is refused. Without the variable, the runtime or the files, search
 * uses word ranking alone and says so.
 */
export const EMBEDDING_RUNTIME = { package: '@huggingface/transformers', version: '4.3.1' };
export const EMBEDDING_MODEL = {
  id: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  files: {
    'config.json': '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
    'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
    'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
    'onnx/model_quantized.onnx': 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
  },
} as const;
const DIMENSIONS = 384;
const BATCH = 64;
const MAX_TEXT = 512;

type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array }>;

export type MeaningState =
  | { status: 'off' }
  | { status: 'unavailable'; reason: string }
  | { status: 'ready'; embed: (texts: string[]) => Promise<Float32Array[]>; cacheRoot: string };

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let loading: Promise<MeaningState> | undefined;

/** The meaning layer for this process: off, unavailable with a reason, or ready. */
export function meaningLayer(): Promise<MeaningState> {
  loading ??= load(process.env.HOI4_REFERENCE_EMBEDDINGS);
  return loading;
}

async function load(cacheRoot: string | undefined): Promise<MeaningState> {
  if (cacheRoot === undefined || cacheRoot.trim() === '') return { status: 'off' };
  if (!path.isAbsolute(cacheRoot))
    return { status: 'unavailable', reason: 'HOI4_REFERENCE_EMBEDDINGS must be an absolute path' };
  let runtime: {
    env: Record<string, unknown>;
    pipeline: (task: string, model: string, options: object) => Promise<Extractor>;
  };
  try {
    runtime = (await import(EMBEDDING_RUNTIME.package)) as typeof runtime;
  } catch {
    return {
      status: 'unavailable',
      reason: `install ${EMBEDDING_RUNTIME.package}@${EMBEDDING_RUNTIME.version} to enable meaning search`,
    };
  }
  if (runtime.env.version !== EMBEDDING_RUNTIME.version)
    return {
      status: 'unavailable',
      reason: `${EMBEDDING_RUNTIME.package} ${String(runtime.env.version)} is installed; ${EMBEDDING_RUNTIME.version} is pinned`,
    };
  const modelRoot = path.join(cacheRoot, 'models');
  const modelDirectory = path.join(modelRoot, ...EMBEDDING_MODEL.id.split('/'));
  try {
    for (const [file, expected] of Object.entries(EMBEDDING_MODEL.files)) {
      const target = path.join(modelDirectory, ...file.split('/'));
      let bytes: Buffer | undefined;
      try {
        bytes = await readFile(target);
      } catch {
        const url = `https://huggingface.co/${EMBEDDING_MODEL.id}/resolve/${EMBEDDING_MODEL.revision}/${file}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`model download failed for ${file}: ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
        if (sha256(bytes) !== expected)
          throw new Error(`model file ${file} does not match its pinned hash`);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(`${target}.partial`, bytes);
        await rename(`${target}.partial`, target);
      }
      if (sha256(bytes) !== expected)
        throw new Error(`cached model file ${file} does not match its pinned hash`);
    }
    runtime.env.allowRemoteModels = false;
    runtime.env.allowLocalModels = true;
    runtime.env.localModelPath = modelRoot;
    const extractor = await runtime.pipeline('feature-extraction', EMBEDDING_MODEL.id, {
      dtype: 'q8',
    });
    const embed = async (texts: string[]) => {
      const vectors: Float32Array[] = [];
      for (let offset = 0; offset < texts.length; offset += BATCH) {
        const batch = texts.slice(offset, offset + BATCH).map((text) => text.slice(0, MAX_TEXT));
        const { data } = await extractor(batch, { pooling: 'mean', normalize: true });
        for (let index = 0; index < batch.length; index += 1)
          vectors.push(data.slice(index * DIMENSIONS, (index + 1) * DIMENSIONS));
      }
      return vectors;
    };
    return { status: 'ready', embed, cacheRoot };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Section vectors keyed by the hash of their text, kept in memory and in one append-only
 * file per model revision, so a section is embedded once per machine.
 */
export class VectorStore {
  readonly #vectors = new Map<string, Float32Array>();
  #loaded = false;
  constructor(private readonly file: string) {}

  static forCache(cacheRoot: string): VectorStore {
    return new VectorStore(
      path.join(cacheRoot, `reference-vectors-${EMBEDDING_MODEL.revision.slice(0, 12)}.bin`),
    );
  }

  async vectors(
    texts: readonly string[],
    embed: (texts: string[]) => Promise<Float32Array[]>,
  ): Promise<Float32Array[]> {
    if (!this.#loaded) await this.load();
    const keys = texts.map((text) => createHash('sha256').update(text).digest());
    const missing = [...new Set(keys.map((key, index) => [key.toString('hex'), index] as const))]
      .filter(([key]) => !this.#vectors.has(key))
      .map(([, index]) => index);
    const unique = [
      ...new Map(missing.map((index) => [keys[index]!.toString('hex'), index])).values(),
    ];
    if (unique.length > 0) {
      const fresh = await embed(unique.map((index) => texts[index]!));
      const records = Buffer.alloc(unique.length * (32 + DIMENSIONS * 4));
      for (const [position, index] of unique.entries()) {
        const vector = fresh[position]!;
        this.#vectors.set(keys[index]!.toString('hex'), vector);
        const offset = position * (32 + DIMENSIONS * 4);
        keys[index]!.copy(records, offset);
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).copy(records, offset + 32);
      }
      await mkdir(path.dirname(this.file), { recursive: true });
      const handle = await open(this.file, 'a');
      try {
        await handle.write(records);
      } finally {
        await handle.close();
      }
    }
    return keys.map((key) => this.#vectors.get(key.toString('hex'))!);
  }

  private async load(): Promise<void> {
    this.#loaded = true;
    let bytes: Buffer;
    try {
      bytes = await readFile(this.file);
    } catch {
      return;
    }
    const size = 32 + DIMENSIONS * 4;
    for (let offset = 0; offset + size <= bytes.length; offset += size) {
      const vector = new Float32Array(DIMENSIONS);
      Buffer.from(vector.buffer).set(bytes.subarray(offset + 32, offset + size));
      this.#vectors.set(bytes.subarray(offset, offset + 32).toString('hex'), vector);
    }
  }
}

export function cosine(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < DIMENSIONS; index += 1) sum += left[index]! * right[index]!;
  return sum;
}
