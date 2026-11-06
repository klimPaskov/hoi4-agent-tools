/**
 * Pin the docs pack to one commit of the modding kit (maintainer decision R-4).
 *
 *   npx tsx scripts/update-docs-pack.ts <kit commit>
 *
 * Lists the kit's `hoi4_wiki/` pages (Markdown), LICENSE.txt and SOURCES.json at that commit,
 * downloads each once to record its size and SHA-256, and rewrites
 * src/hoi4_agent_tools/reference/docs-pack.json. `media/` is left out: the reference tools read
 * text only. Set GITHUB_TOKEN to raise the GitHub API rate limit.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const REPOSITORY = 'klimPaskov/Agentic-HOI4-Modding';
const FOLDER = 'hoi4_wiki';
const LICENSE =
  'HOI4 wiki text under CC BY-SA 3.0; kit text under the same terms. Sources and attribution: LICENSE.txt and SOURCES.json in the pack.';
const INCLUDED = /^[A-Za-z0-9_.-]+\.md$|^LICENSE\.txt$|^SOURCES\.json$/u;

async function main(): Promise<void> {
  const commit = process.argv[2];
  if (commit === undefined || !/^[a-f0-9]{40}$/u.test(commit))
    throw new Error('Usage: update-docs-pack.ts <40-character kit commit>');
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'hoi4-agent-tools-docs-pack',
    ...(process.env.GITHUB_TOKEN === undefined
      ? {}
      : { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
  };
  const listing = await fetch(
    `https://api.github.com/repos/${REPOSITORY}/contents/${FOLDER}?ref=${commit}`,
    { headers },
  );
  if (!listing.ok) throw new Error(`Listing ${FOLDER} failed: HTTP ${listing.status}`);
  const entries = (await listing.json()) as Array<{ name: string; type: string }>;
  const names = entries
    .filter(({ type, name }) => type === 'file' && INCLUDED.test(name))
    .map(({ name }) => name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const files = [];
  for (const name of names) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${FOLDER}/${encodeURIComponent(name)}`,
    );
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    files.push({
      path: name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  }
  const manifest = {
    version: 1,
    repository: REPOSITORY,
    commit,
    folder: FOLDER,
    license: LICENSE,
    files,
  };
  const target = path.resolve(
    import.meta.dirname,
    '..',
    'src',
    'hoi4_agent_tools',
    'reference',
    'docs-pack.json',
  );
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  process.stdout.write(`${files.length} files, ${total} bytes, pinned to ${commit}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
