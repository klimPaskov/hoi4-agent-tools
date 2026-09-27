import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function releaseNotesForTag(changelog: string, tag: string, authoredNotes: string): string {
  if (!/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(tag))
    throw new Error('Release notes require a stable version tag');
  const version = tag.slice(1);
  const sections = changelog.replace(/\r\n/gu, '\n').split(/^## /mu).slice(1);
  const matches = sections.filter((section) => {
    const heading = section.split('\n', 1)[0] ?? '';
    return heading === version || heading.startsWith(`${version} - `);
  });
  if (matches.length !== 1)
    throw new Error(`Expected exactly one changelog section for ${version}`);
  const section = matches[0]!;
  if (!section.includes('\n') || section.slice(section.indexOf('\n') + 1).trim().length === 0)
    throw new Error(`Changelog section for ${version} is empty`);
  const notes = authoredNotes.replace(/\r\n/gu, '\n').trim();
  if (!notes.startsWith(`# HOI4 Agent Tools ${version}\n`))
    throw new Error(`Release page heading does not identify ${version}`);
  if (!notes.includes(`npm install --global hoi4-agent-tools@${version}`))
    throw new Error(`Release page does not install ${version}`);
  return `${notes}\n`;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [changelogPath, tag, outputPath, ...extra] = process.argv.slice(2);
  if (changelogPath === undefined || tag === undefined || outputPath === undefined || extra.length)
    throw new Error('Usage: release-notes.ts <changelog-path> <version-tag> <output-path>');
  const sourceRoot = path.resolve(import.meta.dirname, '../..');
  const authoredPath = path.join(sourceRoot, 'docs', 'releases', `${tag}.md`);
  await writeFile(
    outputPath,
    releaseNotesForTag(
      await readFile(changelogPath, 'utf8'),
      tag,
      await readFile(authoredPath, 'utf8'),
    ),
  );
}
