import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A test double for `hoi4-engine serve`. FAKE_ENGINE_MODE picks the behaviour:
 * - `valid`: `texture.decode` answers a 2x1 image whose pixels are the first 8 payload bytes;
 *   `hello` answers the protocol; requests answer in reverse order when two arrive together.
 * - `error`: every request answers an error frame.
 * - `crash`: exits with code 3 on the first request.
 * - `garbage`: prints a line that is not JSON.
 * - `silent`: never answers.
 */
const FAKE_RESIDENT_ENGINE_SOURCE = `import process from 'node:process';

const mode = process.env.FAKE_ENGINE_MODE ?? 'valid';
if (process.argv[2] !== 'serve') {
  process.stderr.write('unknown subcommand\\n');
  process.exit(64);
}
let buffer = Buffer.alloc(0);
let header;
const queue = [];
function answer(request, payload) {
  if (mode === 'crash') {
    process.stderr.write('fake engine crashed\\n');
    process.exit(3);
  }
  if (mode === 'garbage') return process.stdout.write('not json\\n');
  if (mode === 'silent') return;
  if (mode === 'error')
    return process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { code: 'unsupported', message: 'no', format: 'BC6H_UF16' } }) + '\\n');
  if (request.op === 'hello')
    return process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { protocol: 1 }, payload: 0 }) + '\\n');
  const pixels = Buffer.alloc(8);
  payload.copy(pixels, 0, 0, Math.min(8, payload.length));
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { width: 2, height: 1, format: 'BC7_UNORM' }, payload: 8 }) + '\\n');
  process.stdout.write(pixels);
}
function flush() {
  // Two requests that arrived together are answered last first, to prove id matching.
  while (queue.length > 0) {
    const [request, payload] = queue.pop();
    answer(request, payload);
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (header === undefined) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      header = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
      buffer = buffer.subarray(newline + 1);
    }
    const size = header.payload ?? 0;
    if (buffer.length < size) break;
    queue.push([header, buffer.subarray(0, size)]);
    buffer = buffer.subarray(size);
    header = undefined;
  }
  setTimeout(flush, 20);
});
`;

export async function writeFakeResidentEngine(): Promise<{
  path: string;
  directory: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hoi4-fake-resident-'));
  const file = path.join(directory, 'fake-resident-engine.mjs');
  await writeFile(file, FAKE_RESIDENT_ENGINE_SOURCE, 'utf8');
  return {
    path: file,
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
