import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultDocsRoot,
  docsPackFolder,
  docsPackManifest,
  DocsPackError,
  fetchDocsPack,
  installedDocsPackWiki,
  type DocsPackManifest,
} from '../../src/hoi4_agent_tools/reference/docs-pack.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'hoi4-docs-pack-'));
  cleanup.push(folder);
  // The test harness marks the temporary folder itself; the pack gets a folder of its own.
  return path.join(folder, 'docs');
}

const pages: Record<string, string> = {
  'effects.md': '# Effects\n## add_political_power\nAdds political power.\n',
  'LICENSE.txt': 'CC BY-SA 3.0\n',
};

function manifestFor(content: Record<string, string>, commit = 'a'.repeat(40)): DocsPackManifest {
  return {
    version: 1,
    repository: 'example/kit',
    commit,
    folder: 'hoi4_wiki',
    license: 'Test pages',
    files: Object.entries(content).map(([file, text]) => ({
      path: file,
      sha256: createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text),
    })),
  };
}

function fakeFetch(content: Record<string, string>, requested: string[] = []) {
  return (url: string): Promise<Response> => {
    requested.push(url);
    const file = decodeURIComponent(url.split('/').at(-1)!);
    const text = content[file];
    return Promise.resolve(
      text === undefined ? new Response('missing', { status: 404 }) : new Response(text),
    );
  };
}

describe('docs pack', () => {
  it('pins a kit commit with its pages, licence and sources', () => {
    expect(docsPackManifest.commit).toMatch(/^[a-f0-9]{40}$/u);
    const files = docsPackManifest.files.map(({ path: file }) => file);
    expect(files).toContain('LICENSE.txt');
    expect(files).toContain('SOURCES.json');
    expect(files.filter((file) => file.endsWith('.md')).length).toBeGreaterThan(50);
    // Only the folder's own text files: no images, no subfolders.
    expect(files.every((file) => !file.includes('/'))).toBe(true);
  });

  it('installs a complete, verified pack in one step and reuses it', async () => {
    const docsRoot = await temporary();
    const manifest = manifestFor(pages);
    const requested: string[] = [];
    const installed = await fetchDocsPack({
      docsRoot,
      manifest,
      fetch: fakeFetch(pages, requested),
    });
    expect(installed).toMatchObject({ files: 2, reused: false, commit: manifest.commit });
    expect(requested[0]).toBe(
      `https://raw.githubusercontent.com/example/kit/${manifest.commit}/hoi4_wiki/effects.md`,
    );
    const wiki = await installedDocsPackWiki(docsRoot, manifest);
    expect(wiki).toBe(path.join(docsPackFolder(docsRoot, manifest), 'hoi4_wiki'));
    expect(await readFile(path.join(wiki!, 'effects.md'), 'utf8')).toBe(pages['effects.md']);

    const again = await fetchDocsPack({
      docsRoot,
      manifest,
      fetch: () => Promise.reject(new Error('no network needed')),
    });
    expect(again.reused).toBe(true);
  });

  it('installs nothing when a file does not match its pinned hash', async () => {
    const docsRoot = await temporary();
    const manifest = manifestFor(pages);
    const tampered = { ...pages, 'effects.md': '# Effects\nchanged\n' };
    await expect(
      fetchDocsPack({ docsRoot, manifest, fetch: fakeFetch(tampered) }),
    ).rejects.toMatchObject({ code: 'DOCS_PACK_HASH_MISMATCH' });
    expect(await installedDocsPackWiki(docsRoot, manifest)).toBeUndefined();
    expect(await readdir(docsRoot)).toEqual([]);
  });

  it('installs nothing when a download fails', async () => {
    const docsRoot = await temporary();
    const manifest = manifestFor({ ...pages, 'gone.md': 'x' });
    const error = await fetchDocsPack({ docsRoot, manifest, fetch: fakeFetch(pages) }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DocsPackError);
    expect(error).toMatchObject({ code: 'DOCS_PACK_DOWNLOAD_FAILED' });
    expect(await readdir(docsRoot)).toEqual([]);
  });

  it('removes the pack of another commit after installing', async () => {
    const docsRoot = await temporary();
    const older = manifestFor(pages, 'b'.repeat(40));
    await fetchDocsPack({ docsRoot, manifest: older, fetch: fakeFetch(pages) });
    const newer = manifestFor(pages, 'c'.repeat(40));
    await fetchDocsPack({ docsRoot, manifest: newer, fetch: fakeFetch(pages) });
    expect(await readdir(docsRoot)).toEqual(['c'.repeat(12)]);
    expect(await installedDocsPackWiki(docsRoot, older)).toBeUndefined();
  });

  it('never reads a pack whose marker names another manifest', async () => {
    const docsRoot = await temporary();
    const manifest = manifestFor(pages);
    const folder = docsPackFolder(docsRoot, manifest);
    await mkdir(path.join(folder, 'hoi4_wiki'), { recursive: true });
    await writeFile(path.join(folder, '.complete'), 'not this manifest\n');
    expect(await installedDocsPackWiki(docsRoot, manifest)).toBeUndefined();
    expect(await installedDocsPackWiki(undefined, manifest)).toBeUndefined();
  });

  it('defaults to the user data folder', () => {
    expect(defaultDocsRoot({ XDG_DATA_HOME: '/data' }, '/home/user')).toBe(
      path.join('/data', 'hoi4-agent-tools', 'docs'),
    );
    expect(defaultDocsRoot({ LOCALAPPDATA: 'C:\\Local' }, 'C:\\Users\\user')).toBe(
      path.join('C:\\Local', 'hoi4-agent-tools', 'docs'),
    );
    expect(defaultDocsRoot({}, '/home/user')).toBe(
      path.join('/home/user', '.local', 'share', 'hoi4-agent-tools', 'docs'),
    );
  });
});
