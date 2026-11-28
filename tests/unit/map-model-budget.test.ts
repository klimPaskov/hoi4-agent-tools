import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';

const roots = {
  map: ['map'],
  states: ['history/states'],
  localisation: ['localisation', 'localisation_synced'],
};

function scanned(relativePath: string, text: string): ScannedFile {
  const bytes = Buffer.from(text);
  return {
    absolutePath: `mod:/${relativePath}`,
    displayPath: `mod:${relativePath}`,
    relativePath,
    rootKind: 'mod',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

describe('map model budget (issue 172)', () => {
  it('counts building and unit positions apart from the domain-record ceiling', () => {
    // 300,000 building rows and 300,000 unit rows: 600,000 position records, above the 500,000
    // domain records that refused Old World Blues before positions had a ceiling of their own.
    const buildings = '1;arms_factory;1.0;1.0;1.0;0.0;0\n'.repeat(300_000);
    const units = '1;0;1.0;1.0;1.0;0.0;0.0\n'.repeat(300_000);
    const index = MapWorkspaceIndex.build(
      [scanned('map/buildings.txt', buildings), scanned('map/unitstacks.txt', units)],
      roots,
    );
    expect(index.buildingPositions).toHaveLength(300_000);
    expect(index.unitPositions).toHaveLength(300_000);
  });
});
