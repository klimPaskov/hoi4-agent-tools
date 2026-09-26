import path from 'node:path';
import { tmpdir } from 'node:os';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import { ReferenceService } from '../src/hoi4_agent_tools/reference/service.js';
import {
  referenceContextRequestSchema,
  referenceSearchRequestSchema,
} from '../src/hoi4_agent_tools/schemas/reference.js';

const modRoot = process.argv[2];
const gameRoot = process.argv[3];
if (modRoot === undefined || gameRoot === undefined) {
  process.stderr.write('Usage: tsx scripts/evaluate-reference.ts MOD_ROOT GAME_ROOT\n');
  process.exit(2);
}

const cases = [
  {
    query: 'how do focus prerequisites with OR work',
    expected: 'National focus modding',
    heading: 'Interaction with other focuses',
  },
  {
    query: 'where does technology icon background size come from',
    expected: 'Technology modding',
    heading: 'Brief user interface',
  },
  {
    query: 'save_event_target_as supported scope',
    expected: 'effects_documentation.md',
    heading: 'save_event_target_as',
  },
  { query: 'mission timeout days', expected: 'Decision modding', heading: 'Missions' },
  {
    query: 'scripted gui button click effects',
    expected: 'Scripted GUI modding',
    heading: 'Effects',
  },
  { query: 'state history dated owner at bookmark', expected: 'State modding', heading: 'History' },
  { query: 'UTF-8 BOM localisation', expected: 'Localisation', heading: 'Quick checklist' },
  { query: 'AI focus weights', expected: 'AI focuses', heading: 'Focus factors' },
  { query: 'event option ai_chance', expected: 'Event modding', heading: 'Options' },
] as const;

const resolver = await WorkspaceResolver.create(
  serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(tmpdir(), 'hoi4-reference-evaluation-state'),
    workspaces: [{ id: 'evaluation', name: 'Reference evaluation', root: modRoot, gameRoot }],
  }),
);
const workspace = resolver.get('evaluation');
const service = new ReferenceService();
const surfaces = ['event', 'decision', 'focus', 'technology', 'gui', 'map'] as const;
const contexts = [];
for (const surface of surfaces) {
  const start = performance.now();
  const response = await service.context(
    workspace,
    referenceContextRequestSchema.parse({
      workspaceId: 'evaluation',
      surface,
    }),
  );
  contexts.push({
    surface,
    citations: response.sections.length,
    wikiCitations: response.sections.filter(({ source }) => source === 'wiki').length,
    missing: response.missing,
    bytes: Buffer.byteLength(JSON.stringify(response)),
    ms: Math.round(performance.now() - start),
  });
}
const results = [];
for (const item of cases) {
  const start = performance.now();
  const response = await service.search(
    workspace,
    referenceSearchRequestSchema.parse({
      workspaceId: 'evaluation',
      query: item.query,
      limit: 5,
    }),
  );
  const pageRank = response.results.findIndex(({ path: source }) => source.includes(item.expected));
  const sectionRank = response.results.findIndex(
    ({ path: source, heading }) => source.includes(item.expected) && heading.includes(item.heading),
  );
  results.push({
    query: item.query,
    expected: item.expected,
    heading: item.heading,
    pageRank: pageRank < 0 ? null : pageRank + 1,
    sectionRank: sectionRank < 0 ? null : sectionRank + 1,
    count: response.total,
    bytes: Buffer.byteLength(JSON.stringify(response)),
    ms: Math.round(performance.now() - start),
    top: response.results.map(({ path: source, heading }) => `${path.basename(source)}#${heading}`),
  });
}
const pagesFound = results.filter(({ pageRank }) => pageRank !== null).length;
const sectionsFound = results.filter(({ sectionRank }) => sectionRank !== null).length;
process.stdout.write(
  `${JSON.stringify({ pagesFound, sectionsFound, total: results.length, contexts, results }, null, 2)}\n`,
);
if (sectionsFound !== cases.length || contexts.some(({ missing }) => missing.length > 0))
  process.exitCode = 1;
