import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ResolvedWorkspace } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  listSkills,
  loadSkill,
  readSkillText,
  SETUP_LOCK_PATH,
} from '../../src/hoi4_agent_tools/reference/skills.js';
import { skillRequestSchema } from '../../src/hoi4_agent_tools/schemas/skill.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  ),
);

const REVISION = 'c045d7e0000000000000000000000000000000aa';
const EVENTS = '---\nname: hoi4-events\ndescription: Use when writing events.\n---\n\n# Events\n';
const REFERENCE = '# Event reference\n';

async function mod(files: Record<string, string>, locked?: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'skills-'));
  roots.push(root);
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  if (locked !== undefined) {
    await mkdir(path.join(root, '.hoi4-mod-setup'));
    await writeFile(
      path.join(root, SETUP_LOCK_PATH),
      JSON.stringify({
        source: {
          repository: 'klimPaskov/Agentic-HOI4-Modding',
          revision: REVISION,
          release: 'v1.2.0',
          manifest_sha256: 'a'.repeat(64),
        },
        files: [
          ...locked.map((relative) => ({
            path: relative,
            installed_sha256: sha256Bytes(files[relative] ?? ''),
          })),
          // Untrusted entries that must never be served.
          {
            path: '.agents/skills/hoi4-events/../../../secret.txt',
            installed_sha256: 'b'.repeat(64),
          },
          { path: '.agents/skills/hoi4-events/x.md', installed_sha256: 'not a hash' },
          null,
        ],
      }),
    );
  }
  return { modRoot: root } as ResolvedWorkspace;
}

const load = (workspace: ResolvedWorkspace, input: Record<string, unknown>) => {
  const request = skillRequestSchema.parse(input);
  return loadSkill(workspace, { ...request, name: request.name! });
};

describe('hoi4.skill', () => {
  const installed = {
    '.agents/skills/hoi4-events/SKILL.md': EVENTS,
    '.agents/skills/hoi4-events/references/events.md': REFERENCE,
    '.claude/skills/hoi4-events/SKILL.md': EVENTS,
  };

  it('serves the files the Setup lock pins, with the kit revision and hash', async () => {
    const workspace = await mod(installed, Object.keys(installed));
    const listed = await listSkills(workspace);
    expect(listed.kit).toEqual({
      repository: 'klimPaskov/Agentic-HOI4-Modding',
      revision: REVISION,
      release: 'v1.2.0',
      manifestSha256: 'a'.repeat(64),
    });
    expect(listed.skills).toEqual([
      { name: 'hoi4-events', description: 'Use when writing events.', files: 2, state: 'pinned' },
    ]);
    expect(listed.drifted).toBe(0);

    const loaded = await load(workspace, { name: 'hoi4-events' });
    expect(loaded.skill).toMatchObject({
      path: '.agents/skills/hoi4-events/SKILL.md',
      state: 'pinned',
      sha256: sha256Bytes(EVENTS),
      pinnedSha256: sha256Bytes(EVENTS),
      text: EVENTS,
      nextOffset: null,
      otherFiles: ['references/events.md'],
    });
    const reference = await load(workspace, { name: 'hoi4-events', file: 'references/events.md' });
    expect(reference.skill?.text).toBe(REFERENCE);
  });

  it('refuses a file edited since Setup installed it unless local edits are accepted', async () => {
    const workspace = await mod(installed, Object.keys(installed));
    await writeFile(path.join(workspace.modRoot, '.agents/skills/hoi4-events/SKILL.md'), 'edited');
    const listed = await listSkills(workspace);
    expect(listed.skills?.[0]?.state).toBe('edited');
    expect(listed.drifted).toBe(1);
    await expect(load(workspace, { name: 'hoi4-events' })).rejects.toMatchObject({
      code: 'SKILL_TEXT_DRIFTED',
    });
    await expect(readSkillText(workspace, 'hoi4-events', 'SKILL.md')).rejects.toMatchObject({
      code: 'SKILL_TEXT_DRIFTED',
    });
    const accepted = await load(workspace, { name: 'hoi4-events', acceptLocalEdits: true });
    expect(accepted.skill).toMatchObject({ state: 'edited', text: 'edited' });
  });

  it('reports a pinned file that is gone', async () => {
    const workspace = await mod(installed, Object.keys(installed));
    await unlink(path.join(workspace.modRoot, '.agents/skills/hoi4-events/references/events.md'));
    expect((await listSkills(workspace)).skills?.[0]?.state).toBe('missing');
    await expect(
      load(workspace, { name: 'hoi4-events', file: 'references/events.md' }),
    ).rejects.toMatchObject({ code: 'SKILL_FILE_MISSING' });
  });

  it('serves installed skills as unpinned when the mod has no Setup lock', async () => {
    const workspace = await mod(installed);
    const listed = await listSkills(workspace);
    expect(listed.kit).toBeNull();
    expect(listed.skills).toEqual([
      { name: 'hoi4-events', description: 'Use when writing events.', files: 2, state: 'unpinned' },
    ]);
    expect((await load(workspace, { name: 'hoi4-events' })).skill).toMatchObject({
      state: 'unpinned',
      pinnedSha256: null,
      text: EVENTS,
    });
  });

  it('pages a long file at line breaks', async () => {
    const long = Array.from({ length: 3000 }, (_, index) => `line ${index} ✓\n`).join('');
    const files = { '.agents/skills/big/SKILL.md': long };
    const workspace = await mod(files, Object.keys(files));
    const pages: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await load(workspace, { name: 'big', offset });
      expect(Buffer.byteLength(page.skill!.text)).toBeLessThanOrEqual(20_000);
      expect(page.skill!.text.endsWith('\n')).toBe(true);
      pages.push(page.skill!.text);
      offset = page.skill!.nextOffset;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('')).toBe(long);
  });

  it('answers unknown skills and files with not-found codes', async () => {
    const workspace = await mod(installed, Object.keys(installed));
    await expect(load(workspace, { name: 'hoi4-nope' })).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
    await expect(
      load(workspace, { name: 'hoi4-events', file: 'references/nope.md' }),
    ).rejects.toMatchObject({ code: 'SKILL_FILE_NOT_FOUND' });
    expect(() => skillRequestSchema.parse({ name: 'hoi4-events', file: '../x.md' })).toThrow();
  });
});
