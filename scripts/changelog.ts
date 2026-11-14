import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Changelog fragments. Every pull request adds one file under `changelog.d/` instead of editing
 * the `## Unreleased` section of CHANGELOG.md, so parallel pull requests no longer conflict on it.
 * The release step assembles the fragments, in file-name order, into the new version's section
 * and deletes them.
 *
 *   npx tsx scripts/changelog.ts check                       # part of `npm run check`
 *   npx tsx scripts/changelog.ts release <version> [date]    # in the release pull request
 *
 * A fragment is Markdown: one or more top-level bullets (`- ...`), each a complete entry, with no
 * headings. `changelog.d/README.md` explains the convention and is never assembled.
 */

export const FRAGMENT_DIRECTORY = 'changelog.d';
const README = 'README.md';
const UNRELEASED = '## Unreleased';

export interface Fragment {
  name: string;
  text: string;
}

/** The lines between `## Unreleased` and the next section, or undefined without that heading. */
export function unreleasedBody(changelog: string): string | undefined {
  const lines = changelog.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === UNRELEASED);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n');
}

/** Problems with the changelog and the fragments; empty when both follow the convention. */
export function changelogProblems(changelog: string, fragments: readonly Fragment[]): string[] {
  const problems: string[] = [];
  const body = unreleasedBody(changelog);
  if (body === undefined)
    problems.push(
      `CHANGELOG.md has no "${UNRELEASED}" heading; keep it, empty, above the releases`,
    );
  else if (body.trim() !== '')
    problems.push(
      `CHANGELOG.md "${UNRELEASED}" must stay empty: put the entry in a new file under ${FRAGMENT_DIRECTORY}/ (see ${FRAGMENT_DIRECTORY}/${README})`,
    );
  for (const { name, text } of fragments) {
    const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '');
    if (!name.endsWith('.md'))
      problems.push(`${FRAGMENT_DIRECTORY}/${name}: a fragment is a .md file`);
    if (lines.length === 0) problems.push(`${FRAGMENT_DIRECTORY}/${name} is empty`);
    else if (!lines[0]!.startsWith('- '))
      problems.push(`${FRAGMENT_DIRECTORY}/${name} must start with a bullet ("- ...")`);
    if (lines.some((line) => line.startsWith('#')))
      problems.push(`${FRAGMENT_DIRECTORY}/${name} must not contain headings`);
  }
  return problems;
}

/**
 * CHANGELOG.md with a new `## <version> - <date>` section, holding the fragments in file-name
 * order, under the empty `## Unreleased` heading.
 */
export function assembleRelease(
  changelog: string,
  fragments: readonly Fragment[],
  version: string,
  date: string,
): string {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`Version ${version} is not x.y.z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`Date ${date} is not YYYY-MM-DD`);
  if (changelog.includes(`\n## ${version} `))
    throw new Error(`CHANGELOG.md already has ${version}`);
  const problems = changelogProblems(changelog, fragments);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  if (fragments.length === 0) throw new Error(`${FRAGMENT_DIRECTORY}/ has no fragments to release`);
  const entries = [...fragments]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(({ text }) => text.trim())
    .join('\n');
  const heading = changelog.indexOf(UNRELEASED);
  const next = changelog.indexOf('\n## ', heading + UNRELEASED.length);
  const head = changelog.slice(0, heading + UNRELEASED.length);
  const rest = next < 0 ? '' : changelog.slice(next + 1);
  return `${head}\n\n## ${version} - ${date}\n\n${entries}\n${rest === '' ? '' : `\n${rest}`}`;
}

async function readFragments(root: string): Promise<Fragment[]> {
  const directory = path.join(root, FRAGMENT_DIRECTORY);
  const names = (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => name !== README && !name.startsWith('.'))
    .sort();
  return Promise.all(
    names.map(async (name) => ({ name, text: await readFile(path.join(directory, name), 'utf8') })),
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const root = process.cwd();
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const changelog = await readFile(changelogPath, 'utf8');
  const fragments = await readFragments(root);
  const [command, version, date] = argv;
  if (command === 'check') {
    const problems = changelogProblems(changelog, fragments);
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    return problems.length === 0 ? 0 : 1;
  }
  if (command === 'release' && version !== undefined) {
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(changelogPath, assembleRelease(changelog, fragments, version, date ?? today));
    for (const { name } of fragments) await rm(path.join(root, FRAGMENT_DIRECTORY, name));
    process.stderr.write(`Assembled ${fragments.length} fragments into ${version}\n`);
    return 0;
  }
  process.stderr.write('Usage: changelog.ts check | release <version> [YYYY-MM-DD]\n');
  return 2;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main(process.argv.slice(2));
