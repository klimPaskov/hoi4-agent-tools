import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A test double for hoi4-engine. FAKE_ENGINE_MODE picks the behaviour; the request arrives on
 * stdin. The engine client runs a .mjs engine under the current Node, without a shell.
 */
const FAKE_ENGINE_SOURCE = `import process from 'node:process';

const mode = process.env.FAKE_ENGINE_MODE ?? 'valid';
const hash = 'a'.repeat(64);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  if (process.argv[2] !== 'focus-layout') {
    process.stderr.write('unknown subcommand\\n');
    process.exit(64);
  }
  if (mode === 'valid') {
    const nodes = request.focuses.map((focus, index) => ({
      id: focus.id,
      x: index * 2,
      y: 0,
      laneId: focus.laneId ?? 'default',
      moved: true,
    }));
    process.stdout.write(
      JSON.stringify({
        schema: 'hoi4-focus-layout/1',
        status: 'ok',
        operation: request.operation,
        ...(request.treeId === undefined ? {} : { treeId: request.treeId }),
        nodes,
        source: nodes.map(({ id, x, y }) => ({ id, x, y })),
        diagnostics: [],
        metrics: {
          columns: nodes.length * 2,
          rows: 1,
          orthogonalCrossings: 0,
          stemsThroughPlaques: 0,
          mergedBars: 0,
          durationMicros: 1,
        },
        hashes: { layout: hash, untouched: hash, prerequisites: hash, exclusions: hash },
      }),
    );
  } else if (mode === 'invalid-json') {
    process.stdout.write('{"schema": "hoi4-focus-layout/1", "status": ');
  } else if (mode === 'wrong-shape') {
    process.stdout.write(JSON.stringify({ schema: 'hoi4-focus-layout/1', status: 'ok' }));
  } else if (mode === 'invalid-request') {
    process.stderr.write('hoi4-engine: focus-layout: duplicate focus a\\n');
    process.stdout.write(
      JSON.stringify({
        schema: 'hoi4-focus-layout/1',
        status: 'invalid',
        error: { code: 'FOCUS_ENGINE_DUPLICATE_FOCUS', message: 'duplicate focus a' },
      }),
    );
    process.exit(2);
  } else if (mode === 'crash') {
    process.stderr.write('thread main panicked\\n');
    process.exit(101);
  } else if (mode === 'flood') {
    process.stdout.write('x'.repeat(4096));
  } else if (mode === 'hang') {
    setInterval(() => undefined, 1000);
  } else {
    process.exit(70);
  }
});
`;

/** Writes the fake engine into a new temporary directory; call the returned cleanup when done. */
export async function writeFakeEngine(): Promise<{
  path: string;
  directory: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hoi4-fake-engine-'));
  const file = path.join(directory, 'fake-engine.mjs');
  await writeFile(file, FAKE_ENGINE_SOURCE, 'utf8');
  return {
    path: file,
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
