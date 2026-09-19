import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

/** Project-owned sources only; two different conditional calls intentionally reach the same helper. */
export async function helperExpansionFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-helper-pages-'));
  const mod = path.join(root, 'mod');
  const sources = new Map([
    [
      'events/pages.txt',
      'add_namespace = pages\ncountry_event = { id = pages.1 is_triggered_only = yes option = { name = pages.1.a page_entry = yes } }\ncountry_event = { id = pages.2 is_triggered_only = yes option = { name = pages.2.a } }\n',
    ],
    [
      'common/scripted_effects/pages.txt',
      'page_entry = { if = { limit = { has_country_flag = page_left } page_leaf = yes } if = { limit = { has_country_flag = page_right } page_leaf = yes } }\npage_leaf = { set_country_flag = page_ready set_technology = { page_tech = 1 } country_event = { id = pages.2 days = 2 } page_entry = yes }\n',
    ],
    [
      'common/technologies/pages.txt',
      'technologies = { page_tech = { research_cost = 1 start_year = 1936 } }\n',
    ],
  ]);
  for (const [relative, text] of sources) {
    const target = path.join(mod, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    workspaces: [{ id: 'pages', name: 'Synthetic helper pages', root: mod }],
    http: {
      principals: [
        { principal: 'alice', workspaceIds: ['pages'] },
        { principal: 'bob', workspaceIds: ['pages'] },
        { principal: 'denied', workspaceIds: [] },
      ],
    },
  });
  const engine = async () => new CoreEngine(await WorkspaceResolver.create(configuration));
  return {
    root,
    mod,
    sources,
    configuration,
    engine,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
