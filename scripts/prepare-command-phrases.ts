import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commandTexts, readGameText } from '../src/hoi4_agent_tools/reference/game-text.js';

/**
 * Writes the input for regenerating `src/hoi4_agent_tools/reference/command-phrases.json`
 * (ADR 0077): every documented effect, trigger and modifier with its documentation text and
 * in-game tooltip text, in batches of about 234 commands. Each batch goes to a writer that
 * sees nothing else and returns four plain-word phrasings per command.
 */
const gameRoot = process.argv[2];
const outputRoot = process.argv[3];
if (gameRoot === undefined || outputRoot === undefined) {
  process.stderr.write('Usage: tsx scripts/prepare-command-phrases.ts GAME_ROOT OUTPUT_DIR\n');
  process.exit(2);
}

const items: Array<{ name: string; kind: string; doc: string; game: string[] }> = [];
for (const [file, kind] of [
  ['effects', 'effect'],
  ['triggers', 'trigger'],
  ['modifiers', 'modifier'],
] as const) {
  const lines = (
    await readFile(path.join(gameRoot, 'documentation', `${file}_documentation.md`), 'utf8')
  ).split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const name = /^## ([a-z][a-z0-9_]*)\s*$/u.exec(line)?.[1];
    if (name === undefined) continue;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length && !lines[next]!.startsWith('## '); next += 1) {
      const text = lines[next]!.trim();
      if (text.length > 0 && text !== '```' && !text.startsWith('* Supported Targets'))
        body.push(text);
    }
    items.push({ name, kind, doc: body.join(' ').slice(0, 320), game: [] });
  }
}
const texts = commandTexts(new Set(items.map(({ name }) => name)), await readGameText(gameRoot));
for (const item of items)
  item.game = (texts.get(item.name) ?? []).slice(0, 3).map((text) => text.slice(0, 120));

await mkdir(outputRoot, { recursive: true });
const batches = 8;
const size = Math.ceil(items.length / batches);
for (let batch = 0; batch < batches; batch += 1)
  await writeFile(
    path.join(outputRoot, `in-${batch}.json`),
    `${JSON.stringify(items.slice(batch * size, (batch + 1) * size))}\n`,
  );
process.stdout.write(`${items.length} commands in ${batches} batches\n`);
