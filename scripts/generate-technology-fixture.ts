import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { format } from 'prettier';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..', 'fixtures', 'technology');
const workspace = path.join(root, 'workspace');
const technologyCount = 1_040;
const folderCount = 13;
const perFolder = technologyCount / folderCount;
const definitionsPerFile = 130;
const technologyFileCount = technologyCount / definitionsPerFile;

function techId(index: number): string {
  return `synthetic_tech_${String(index).padStart(4, '0')}`;
}

function folderId(index: number): string {
  return `synthetic_folder_${String(index).padStart(2, '0')}`;
}

async function put(relativePath: string, content: string | Buffer): Promise<void> {
  const target = path.join(workspace, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function formattedJson(value: unknown): Promise<string> {
  return format(JSON.stringify(value), { parser: 'json' });
}

function definition(index: number): string {
  const folder = Math.floor(index / perFolder);
  const local = index % perFolder;
  const id = techId(index);
  const year = 1936 + Math.floor(local / 4) * 2;
  const coordinateX = index === 31 ? 2 : local % 4;
  const coordinateY = index === 31 ? 7 : Math.floor(local / 4);
  const placements =
    index >= technologyCount - 2
      ? ''
      : [
          `\tfolder = { name = ${folderId(folder)} position = { x = ${coordinateX} y = ${coordinateY} } }`,
          ...(folder === 0 && local < 5
            ? [
                `\tfolder = { name = ${folderId(1)} position = { x = ${10 + (local % 2)} y = ${Math.floor(local / 2)} } }`,
              ]
            : []),
        ].join('\n');
  const paths = [
    ...(local < perFolder - 1
      ? [
          `\tpath = { leads_to_tech = ${techId(index + 1)}${local === 8 ? ' research_cost_coeff = 1.25' : ''} }`,
        ]
      : []),
    ...(index === 10 ? [`\tpath = { leads_to_tech = ${techId(9)} }`] : []),
    ...(index === 20 ? ['\tpath = { leads_to_tech = synthetic_missing_target }'] : []),
    ...(index === 21 ? [`\tpath = { leads_to_tech = ${id} }`] : []),
    ...(index === 24 ? ['\tpath = { leads_to_tech = [SyntheticDynamicTarget] }'] : []),
  ].join('\n');
  const xor =
    local === 5
      ? `\txor = { ${techId(index + 1)} }`
      : local === 6
        ? `\txor = { ${techId(index - 1)} }`
        : '';
  const category =
    index === 15
      ? 'synthetic_missing_category'
      : `synthetic_category_${String(folder).padStart(2, '0')}`;
  const tag = `synthetic_tag_${String(folder % 4).padStart(2, '0')}`;
  const unlocks = [
    ...(index === 0 ? ['\tenable_equipments = { synthetic_equipment }'] : []),
    ...(index === 1 ? ['\tenable_equipment_modules = { synthetic_module }'] : []),
    ...(index === 2 ? ['\tenable_subunits = { synthetic_sub_unit }'] : []),
    ...(index === 3 ? ['\tenable_building = { building = synthetic_building level = 1 }'] : []),
    ...(index === 4 ? ['\tenable_abilities = { synthetic_ability }'] : []),
    ...(index === 5 ? ['\tenable_tactic = synthetic_tactic'] : []),
    ...(index === 16 ? ['\tenable_equipments = { synthetic_missing_equipment }'] : []),
  ].join('\n');
  const effects =
    index % 5 === 0
      ? '\tresearch_speed_factor = 0.01'
      : '\tproduction_speed_buildings_factor = 0.01';
  return [
    `${id} = {`,
    `\tstart_year = ${year}`,
    `\tresearch_cost = ${index === 22 ? 50 : (1 + (local % 4) * 0.25).toFixed(2)}`,
    ...(folder === 12 ? ['\tdoctrine = yes', '\tdoctrine_name = synthetic_legacy_doctrine'] : []),
    ...(index >= technologyCount - 2 ? ['\tallow = { always = no }'] : []),
    placements,
    paths,
    xor,
    ...(index === 7 ? [`\tsub_technologies = { ${techId(8)} }`] : []),
    `\tcategories = { ${category} }`,
    `\ttags = { ${tag} }`,
    unlocks,
    effects,
    ...(index === 19
      ? [
          '\t# Unknown fixture fields remain visible in the authoritative source record.',
          '\tsynthetic_unknown_field = { arbitrary = yes }',
        ]
      : []),
    ...(index % 17 === 0 ? ['\tai_will_do = { factor = 0 }'] : ['\tai_will_do = { factor = 1 }']),
    '}',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

async function main(): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const allDefinitions = Array.from({ length: technologyCount }, (_, index) => definition(index));
  for (let file = 0; file < technologyFileCount; file += 1) {
    const definitions = allDefinitions.slice(
      file * definitionsPerFile,
      (file + 1) * definitionsPerFile,
    );
    await put(
      `common/technologies/synthetic_technologies_${String(file + 1).padStart(2, '0')}.txt`,
      `technologies = {\n${definitions
        .map((value) =>
          value
            .split('\n')
            .map((line) => `\t${line}`)
            .join('\n'),
        )
        .join('\n\n')}\n}\n`,
    );
  }

  await put(
    'common/technology_tags/synthetic_tags.txt',
    [
      `technology_categories = { ${Array.from({ length: folderCount }, (_, index) => `synthetic_category_${String(index).padStart(2, '0')}`).join(' ')} synthetic_empty_category }`,
      'technology_tags = { synthetic_tag_00 synthetic_tag_01 synthetic_tag_02 synthetic_tag_03 }',
      'technology_folders = {',
      ...Array.from(
        { length: folderCount },
        (_, index) =>
          `\t${folderId(index)} = { ${index === 12 ? 'doctrine = yes ' : ''}ledger = army }`,
      ),
      '}',
      '',
    ].join('\n'),
  );

  const gridboxes: string[] = [];
  for (let folder = 0; folder < folderCount; folder += 1) {
    const roots = folder === 1 ? [techId(0), techId(perFolder)] : [techId(folder * perFolder)];
    gridboxes.push(
      'containerWindowType = {',
      `\tname = ${folderId(folder)}`,
      ...roots.flatMap((rootId, branch) => [
        '\tgridBoxType = {',
        `\t\tname = ${rootId}_tree`,
        `\t\tposition = { x = ${branch * 700} y = 0 }`,
        '\t\tslotsize = { width = 110 height = 96 }',
        '\t\tformat = UP',
        '\t}',
      ]),
      '}',
    );
  }
  await put('interface/synthetic_technology_view.gui', `${gridboxes.join('\n')}\n`);

  const texturePath = 'gfx/interface/technologies/synthetic_technology.png';
  const sprites = Array.from({ length: technologyCount - 17 }, (_, index) => {
    const actual = index < 503 ? index : index + 17;
    return `\tspriteType = { name = GFX_${techId(actual)}_medium texturefile = ${texturePath} }`;
  });
  await put(
    'interface/synthetic_technology_icons.gfx',
    `spriteTypes = {\n${sprites.join('\n')}\n}\n`,
  );
  await put(
    texturePath,
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#41627f' } })
      .png()
      .toBuffer(),
  );

  const localisation = ['l_english:'];
  for (let index = 0; index < technologyCount; index += 1) {
    if (index === 18) continue;
    localisation.push(`${techId(index)}: "Synthetic Technology ${index}"`);
    localisation.push(
      `${techId(index)}_desc: "Fixture technology ${index} for deterministic analysis."`,
    );
  }
  for (let index = 0; index < folderCount; index += 1) {
    localisation.push(`${folderId(index)}: "Synthetic Folder ${index}"`);
    localisation.push(`${folderId(index)}_desc: "Synthetic folder ${index}."`);
  }
  await put(
    'localisation/english/synthetic_technology_l_english.yml',
    `\ufeff${localisation.join('\n')}\n`,
  );

  await put(
    'common/units/equipment/synthetic_equipment.txt',
    'equipments = { synthetic_equipment = { year = 1936 } }\n',
  );
  await put(
    'common/units/equipment/modules/synthetic_module.txt',
    'equipment_modules = { synthetic_module = { category = synthetic } }\n',
  );
  await put(
    'common/units/synthetic_units.txt',
    'sub_units = { synthetic_sub_unit = { type = infantry } }\n',
  );
  await put(
    'common/buildings/synthetic_buildings.txt',
    'buildings = { synthetic_building = { max_level = 5 } }\n',
  );
  await put('common/abilities/synthetic_abilities.txt', 'ability = { synthetic_ability = { } }\n');
  await put('common/combat_tactics.txt', 'combat_tactics = { synthetic_tactic = { } }\n');

  await put(
    'common/doctrines/folders/synthetic_doctrine_folder.txt',
    'synthetic_doctrine_folder = { name = synthetic_doctrine_folder_name }\n',
  );
  await put(
    'common/doctrines/tracks/synthetic_doctrine_tracks.txt',
    'synthetic_track_alpha = { folder = synthetic_doctrine_folder name = synthetic_track_alpha_name }\nsynthetic_track_beta = { folder = synthetic_doctrine_folder name = synthetic_track_beta_name }\n',
  );
  await put(
    'common/doctrines/grand_doctrines/synthetic_grand_doctrines.txt',
    'synthetic_grand_doctrine = { folder = synthetic_doctrine_folder tracks = { synthetic_track_alpha synthetic_track_beta } ai_will_do = { factor = 1 } }\n',
  );
  await put(
    'common/doctrines/subdoctrines/synthetic_subdoctrines.txt',
    'synthetic_subdoctrine_alpha = { folder = synthetic_doctrine_folder track = synthetic_track_alpha xp_cost = 25 xp_type = army rewards = { synthetic_reward = { army_attack_factor = 0.05 } } xor = { synthetic_subdoctrine_beta } }\nsynthetic_subdoctrine_beta = { folder = synthetic_doctrine_folder track = synthetic_track_beta xp_cost = 25 xp_type = army xor = { synthetic_subdoctrine_alpha } }\n',
  );

  await put(
    'common/scripted_effects/synthetic_technology_effects.txt',
    `synthetic_technology_bonus = { add_tech_bonus = { bonus = 0.5 uses = 1 technology = ${techId(1)} } }\n`,
  );
  await put(
    'common/national_focus/synthetic_focus.txt',
    `focus_tree = { id = synthetic_focus_tree country = { factor = 0 } focus = { id = synthetic_focus completion_reward = { set_technology = { ${techId(0)} = 1 } synthetic_technology_bonus = yes } } }\n`,
  );
  await put(
    'events/synthetic_technology_events.txt',
    `add_namespace = synthetic_tech\ncountry_event = { id = synthetic_tech.1 hidden = yes immediate = { add_tech_bonus = { bonus = 0.5 uses = 1 technology = ${techId(2)} } } }\n`,
  );
  await put(
    'common/decisions/synthetic_technology_decisions.txt',
    `synthetic_decision_category = { synthetic_tech_decision = { complete_effect = { set_technology = { ${techId(3)} = 1 } } } synthetic_tech_mission = { days_mission_timeout = 30 timeout_effect = { add_tech_bonus = { bonus = 0.25 uses = 1 category = synthetic_category_04 } } } }\n`,
  );
  await put(
    'common/on_actions/synthetic_technology_on_actions.txt',
    `on_actions = { on_startup = { effect = { set_technology = { ${techId(4)} = 1 ${techId(technologyCount - 2)} = 1 synthetic_stale_renamed_tech = 1 } add_tech_bonus = { bonus = 0.25 uses = 1 category = synthetic_missing_bonus_category } add_tech_bonus = { bonus = 0.25 uses = 1 category = synthetic_empty_category } } } }\n`,
  );
  await put(
    'history/countries/SYN - Synthetic.txt',
    `set_technology = { ${techId(5)} = 1 }\n1936.1.1 = { set_technology = { ${techId(6)} = 1 } }\n`,
  );
  await put(
    'common/technology_sharing/synthetic_sharing.txt',
    'technology_sharing_group = { id = synthetic_sharing categories = { synthetic_category_02 synthetic_empty_category } }\n',
  );

  const technologyIds = Array.from({ length: technologyCount }, (_, index) => techId(index));
  const prerequisiteEdges = technologyIds.flatMap((id, index) => {
    const local = index % perFolder;
    return [
      ...(local < perFolder - 1 ? [{ from: id, to: techId(index + 1) }] : []),
      ...(index === 10 ? [{ from: id, to: techId(9) }] : []),
      ...(index === 20 ? [{ from: id, to: 'synthetic_missing_target' }] : []),
      ...(index === 21 ? [{ from: id, to: id }] : []),
    ];
  });
  const expectedGraph = {
    technologyIds,
    folderIds: Array.from({ length: folderCount }, (_, index) => folderId(index)),
    counts: {
      technologies: technologyCount - perFolder,
      legacyDoctrines: perFolder,
      totalTechnologyDefinitions: technologyCount,
      folders: folderCount,
      placements: technologyCount - 2 + 5,
      gridboxes: 14,
      prerequisites: prerequisiteEdges.length,
      exclusiveEdges: folderCount * 2,
      subTechnologyEdges: 1,
      categoriesAndTags: folderCount + 5,
    },
    prerequisiteEdges,
    multiplePlacements: technologyIds.slice(0, 5),
    intentionalIssueCodes: [
      'TECH_PREREQUISITE_CYCLE',
      'TECH_SELF_LINK',
      'TECH_TARGET_MISSING',
      'TECH_FOLDER_COORDINATE_OVERLAP',
      'TECH_HIDDEN_OR_UNPLACED_WITHOUT_GRANT',
      'TECH_CATEGORY_REFERENCE_MISSING',
      'TECH_UNLOCK_TARGET_MISSING',
      'TECH_EXTERNAL_REFERENCE_MISSING',
      'TECH_EXTERNAL_CATEGORY_MISSING',
      'TECH_ICON_SPRITE_MISSING',
      'TECH_LOCALISATION_MISSING',
      'TECH_ANALYSIS_UNRESOLVED',
    ],
  };
  const expectedReferences = {
    unlocks: [
      { technologyId: techId(0), kind: 'equipment', targetId: 'synthetic_equipment' },
      { technologyId: techId(1), kind: 'equipment_module', targetId: 'synthetic_module' },
      { technologyId: techId(2), kind: 'sub_unit', targetId: 'synthetic_sub_unit' },
      { technologyId: techId(3), kind: 'building', targetId: 'synthetic_building' },
      { technologyId: techId(4), kind: 'ability', targetId: 'synthetic_ability' },
      { technologyId: techId(5), kind: 'tactic', targetId: 'synthetic_tactic' },
      { technologyId: techId(16), kind: 'equipment', targetId: 'synthetic_missing_equipment' },
    ],
    externalSources: [
      { sourceKind: 'focus', sourceId: 'synthetic_focus', technologyId: techId(0), kind: 'grant' },
      {
        sourceKind: 'focus',
        sourceId: 'synthetic_focus',
        technologyId: techId(1),
        kind: 'research_bonus',
        helperStack: ['synthetic_technology_bonus'],
      },
      {
        sourceKind: 'event',
        sourceId: 'synthetic_tech.1',
        technologyId: techId(2),
        kind: 'research_bonus',
      },
      {
        sourceKind: 'decision',
        sourceId: 'synthetic_tech_decision',
        technologyId: techId(3),
        kind: 'grant',
      },
      {
        sourceKind: 'mission',
        sourceId: 'synthetic_tech_mission',
        categoryId: 'synthetic_category_04',
        kind: 'research_bonus',
      },
      { sourceKind: 'on_action', sourceId: 'on_startup', technologyId: techId(4), kind: 'grant' },
      {
        sourceKind: 'on_action',
        sourceId: 'on_startup',
        technologyId: techId(technologyCount - 2),
        kind: 'grant',
      },
      {
        sourceKind: 'country_history',
        sourceId: 'SYN',
        technologyId: techId(5),
        kind: 'starting_technology',
      },
      {
        sourceKind: 'startup_effect',
        sourceId: 'SYN',
        technologyId: techId(6),
        kind: 'starting_technology',
      },
    ],
  };
  const manifest = {
    schemaVersion: 1,
    technologyCount,
    folderCount,
    sourceDigest: createHash('sha256').update(allDefinitions.join('\n')).digest('hex'),
    expectedGraph: 'expected/graph-manifest.json',
    expectedReferences: 'expected/reference-manifest.json',
  };
  await mkdir(path.join(root, 'expected'), { recursive: true });
  await writeFile(path.join(root, 'fixture-manifest.json'), await formattedJson(manifest));
  await writeFile(
    path.join(root, 'expected', 'graph-manifest.json'),
    await formattedJson(expectedGraph),
  );
  await writeFile(
    path.join(root, 'expected', 'reference-manifest.json'),
    await formattedJson(expectedReferences),
  );
}

await main();
