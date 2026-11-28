import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflows = path.resolve('.github/workflows');

/** Every `cargo build ... -p hoi4-engine-cli` command in a workflow, with whitespace collapsed. */
function engineBuilds(workflow: string): string[] {
  const text = readFileSync(path.join(workflows, workflow), 'utf8');
  return [
    ...text.matchAll(/^[ \t-]*(?:run:[ \t]*)?(cargo build\b[^\n#]*-p hoi4-engine-cli\b[^\n#]*)/gmu),
  ].map(([, command]) => command!.trim().replace(/\s+/gu, ' '));
}

describe('engine builds in the workflows', () => {
  it('builds the release test engine exactly as CI builds its test engine', () => {
    // A test-only feature or flag added to one and not the other passed CI and then failed the
    // release's validate_pack (4.20.4).
    const ci = engineBuilds('ci.yml');
    const release = engineBuilds('release.yml');
    expect(ci).toHaveLength(1);
    expect(release).toHaveLength(1);
    expect(release).toEqual(ci);
  });

  it('builds the shipped engine binaries without test features', () => {
    const shipped = [...engineBuilds('engine-binaries.yml'), ...engineBuilds('engine.yml')];
    expect(shipped.length).toBeGreaterThan(0);
    for (const command of shipped) expect(command).not.toMatch(/--features\b|--all-features\b/u);
  });
});
