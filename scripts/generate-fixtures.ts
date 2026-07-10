import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { format } from 'prettier';
import sharp from 'sharp';
import {
  canonicalize,
  compareCodeUnits,
  sha256Bytes,
} from '../src/hoi4_agent_tools/core/canonical.js';
import {
  compileFocusTree,
  compileContinuousFocusPalette,
  createFocusPlanningSidecar,
  FOCUS_PLAN_SCHEMA_VERSION,
  focusPlanHash,
  layoutFocusTree,
  type FocusBranchGroup,
  type ContinuousFocusPalettePlan,
  type FocusNodePlan,
  type FocusPosition,
  type FocusPrerequisites,
  type FocusReferenceLink,
  type FocusTreePlan,
  type RawClausewitzBlock,
} from '../src/hoi4_agent_tools/focus/index.js';

const FOCUS_COUNT = 255;
const ROUTE_FOCUS_COUNT = 25;
const LANE_SPACING = 2;
const NODE_SPACING = 1;
const SYNTHETIC_ICON = 'GFX_synthetic_focus';
const TREE_ID = 'synthetic_acceptance_tree';
const SOURCE_RELATIVE_PATH = 'common/national_focus/synthetic_acceptance.txt';
const CONTINUOUS_SOURCE_RELATIVE_PATH = 'common/continuous_focus/synthetic_acceptance.txt';
const SIDECAR_RELATIVE_PATH = 'common/national_focus/synthetic_acceptance.focus-plan.json';
const CONTINUOUS_PALETTE_ID = 'synthetic_acceptance_continuous';
const CONTINUOUS_FOCUS_IDS = [
  'synthetic_continuous_industry',
  'synthetic_continuous_readiness',
] as const;

interface RouteSpec {
  family: string;
  label: string;
  visibility: 'normal' | 'conditional' | 'hidden' | 'crisis';
  sharedSupport: boolean;
}

interface InvalidFixtureVariant {
  id: string;
  mutation:
    | { kind: 'replace_prerequisites'; focusId: string; focusIds: string[] }
    | { kind: 'replace_position'; focusId: string; position: FocusPosition }
    | { kind: 'replace_link_target'; focusId: string; from: string; to: string }
    | { kind: 'remove_reveal'; focusId: string };
  expectedDiagnosticCodes: string[];
}

const routeSpecs: readonly RouteSpec[] = [
  { family: 'governance', label: 'Governance', visibility: 'normal', sharedSupport: false },
  { family: 'diplomacy', label: 'Diplomacy', visibility: 'normal', sharedSupport: false },
  { family: 'industry', label: 'Industry', visibility: 'normal', sharedSupport: false },
  { family: 'army', label: 'Army', visibility: 'normal', sharedSupport: false },
  { family: 'air', label: 'Air', visibility: 'normal', sharedSupport: false },
  { family: 'navy', label: 'Navy', visibility: 'normal', sharedSupport: false },
  {
    family: 'intelligence',
    label: 'Intelligence',
    visibility: 'conditional',
    sharedSupport: false,
  },
  { family: 'shadow', label: 'Shadow', visibility: 'hidden', sharedSupport: false },
  { family: 'crisis', label: 'Crisis', visibility: 'crisis', sharedSupport: false },
  {
    family: 'shared_support',
    label: 'Shared Support',
    visibility: 'normal',
    sharedSupport: true,
  },
];

async function prettyCanonical(value: unknown): Promise<string> {
  return format(JSON.stringify(canonicalize(value)), {
    parser: 'json',
    printWidth: 100,
    endOfLine: 'lf',
  });
}

function rawBlock(text: string, referencedFocusIds: string[] = []): RawClausewitzBlock {
  return { text, referencedFocusIds };
}

function prerequisites(...groups: string[][]): FocusPrerequisites {
  return {
    operator: 'and',
    groups: groups.map((focusIds) => ({ operator: 'or', focusIds, rawPassthrough: [] })),
  };
}

function routeFocusId(routeNumber: number, ordinal: number): string {
  return `synthetic_route_${String(routeNumber).padStart(2, '0')}_focus_${String(ordinal).padStart(2, '0')}`;
}

function routeLaneId(routeNumber: number): string {
  return `route_${String(routeNumber).padStart(2, '0')}`;
}

function visibilityFields(
  spec: RouteSpec,
  routeNumber: number,
): Pick<FocusNodePlan, 'visibility' | 'rawPassthrough'> & Partial<Pick<FocusNodePlan, 'reveal'>> {
  if (spec.visibility === 'normal') return { visibility: 'normal', rawPassthrough: [] };
  const revealTarget =
    spec.visibility === 'crisis'
      ? 'synthetic_decision_crisis_reveal'
      : `synthetic_focus.${900 + routeNumber}`;
  const revealKind = spec.visibility === 'crisis' ? 'decision' : 'event';
  const trigger = rawBlock(
    spec.visibility === 'crisis'
      ? '{ has_completed_decision = synthetic_decision_crisis_reveal }'
      : `{ has_country_flag = synthetic_route_${String(routeNumber).padStart(2, '0')}_revealed }`,
  );
  return {
    visibility: spec.visibility,
    reveal: { kind: revealKind, references: [revealTarget], trigger },
    rawPassthrough: [],
  };
}

function rewardAndLinks(
  routeNumber: number,
  ordinal: number,
): { reward: RawClausewitzBlock; links: FocusReferenceLink[] } {
  const effects = [`add_political_power = ${routeNumber * 1_000 + ordinal}`];
  const links: FocusReferenceLink[] = [];
  if (ordinal % 6 === 0) {
    const decision = `synthetic_decision_${String(routeNumber).padStart(2, '0')}_${String(ordinal).padStart(2, '0')}`;
    effects.push(`activate_decision = ${decision}`);
    links.push({ kind: 'decision', target: decision });
  }
  if (ordinal % 8 === 0) {
    const event = `synthetic_focus.${routeNumber * 100 + ordinal}`;
    effects.push(`country_event = { id = ${event} }`);
    links.push({ kind: 'event', target: event });
  }
  if (routeNumber === 1 && ordinal === 6) {
    effects.push('activate_decision = form_synthetic_union');
    effects.push('unlock_decision_category_tooltip = synthetic_acceptance_decisions');
    effects.push('synthetic_focus_reward_effect = yes');
    effects.push('set_cosmetic_tag = SYNTHETIC_ACCEPTANCE_COSMETIC');
    links.push({ kind: 'formable', target: 'form_synthetic_union' });
    links.push({ kind: 'decision_category', target: 'synthetic_acceptance_decisions' });
    links.push({ kind: 'helper', target: 'synthetic_focus_reward_effect' });
  }
  return { reward: rawBlock(`{ ${effects.join(' ')} }`), links };
}

function routePosition(routeNumber: number, ordinal: number): FocusPosition {
  const laneX = (routeNumber - 1) * LANE_SPACING;
  if (ordinal === 3) {
    return {
      mode: 'relative',
      x: 1,
      y: 0,
      relativeTo: routeFocusId(routeNumber, 2),
      pinned: true,
    };
  }
  if (ordinal === 10) {
    return { mode: 'fixed', x: laneX, y: 11, pinned: true };
  }
  if (ordinal === 15) {
    return {
      mode: 'relative',
      x: 0,
      y: 1,
      relativeTo: routeFocusId(routeNumber, 14),
      pinned: true,
    };
  }
  return { mode: 'auto', pinned: false };
}

function buildRouteFocuses(
  spec: RouteSpec,
  routeNumber: number,
): { focuses: FocusNodePlan[]; branch: FocusBranchGroup } {
  const focusIds = Array.from({ length: ROUTE_FOCUS_COUNT }, (_, index) =>
    routeFocusId(routeNumber, index + 1),
  );
  const laneId = routeLaneId(routeNumber);
  const visibility = visibilityFields(spec, routeNumber);
  const focuses = focusIds.map((id, index): FocusNodePlan => {
    const ordinal = index + 1;
    const forkLeft = routeFocusId(routeNumber, 2);
    const forkRight = routeFocusId(routeNumber, 3);
    const focusPrerequisites =
      ordinal === 1
        ? prerequisites(['synthetic_route_hub'])
        : ordinal === 2 || ordinal === 3
          ? prerequisites([routeFocusId(routeNumber, 1)])
          : ordinal === 4
            ? prerequisites([forkLeft, forkRight])
            : prerequisites([routeFocusId(routeNumber, ordinal - 1)]);
    const reward = rewardAndLinks(routeNumber, ordinal);
    return {
      id,
      label: `${spec.label} ${String(ordinal).padStart(2, '0')}`,
      branchId: laneId,
      laneId,
      prerequisites: focusPrerequisites,
      mutuallyExclusive: ordinal === 2 ? [forkRight] : ordinal === 3 ? [forkLeft] : [],
      routeLocks:
        ordinal === 1
          ? [
              {
                id: `${id}:route_hub`,
                field: 'available',
                mode: 'all',
                requiredFocusIds: ['synthetic_route_hub'],
                excludedFocusIds: [],
              },
            ]
          : [],
      position: routePosition(routeNumber, ordinal),
      ...visibility,
      convergence: ordinal === 4,
      sharedSupport: spec.sharedSupport,
      icons: [{ kind: 'static', sprite: SYNTHETIC_ICON }],
      localisation: {
        titleKey: id,
        descriptionKey: `${id}_desc`,
        workingLabel: `${spec.label} ${String(ordinal).padStart(2, '0')}`,
      },
      ai: {
        raw: rawBlock(`{ factor = ${routeNumber + 1} }`),
        majorRoute: ordinal === 1,
        strategyIds: [`synthetic_${spec.family}_strategy`],
      },
      filters: [
        routeNumber <= 3
          ? 'FOCUS_FILTER_POLITICAL'
          : routeNumber <= 6
            ? 'FOCUS_FILTER_RESEARCH'
            : 'FOCUS_FILTER_MANPOWER',
      ],
      links: reward.links,
      cost: 5 + (ordinal % 5),
      completionReward: reward.reward,
      ...(ordinal === ROUTE_FOCUS_COUNT
        ? { payoff: `${spec.label} route payoff`, terminalKind: 'capstone' as const }
        : {}),
    };
  });
  return {
    focuses,
    branch: {
      id: laneId,
      label: `${spec.label} Route`,
      family: spec.family,
      focusIds,
      laneId,
      major: true,
      hidden: spec.visibility === 'hidden',
      crisis: spec.visibility === 'crisis',
      conditional: spec.visibility === 'conditional',
      aiStrategyIds: [`synthetic_${spec.family}_strategy`],
    },
  };
}

function commonFocus(
  id: string,
  label: string,
  position: FocusPosition,
  focusPrerequisites: FocusPrerequisites,
  rewardValue: number,
  overrides: Partial<FocusNodePlan> = {},
): FocusNodePlan {
  return {
    id,
    label,
    laneId: 'spine',
    prerequisites: focusPrerequisites,
    mutuallyExclusive: [],
    routeLocks: [],
    position,
    visibility: 'normal',
    convergence: false,
    sharedSupport: false,
    icons: [{ kind: 'static', sprite: SYNTHETIC_ICON }],
    localisation: { titleKey: id, descriptionKey: `${id}_desc`, workingLabel: label },
    ai: {
      raw: rawBlock('{ factor = 10 }'),
      majorRoute: false,
      strategyIds: ['synthetic_spine_strategy'],
    },
    filters: ['FOCUS_FILTER_POLITICAL'],
    links: [],
    cost: 5,
    completionReward: rawBlock(`{ add_political_power = ${rewardValue} }`),
    rawPassthrough: [],
    ...overrides,
  };
}

export function buildFocusAcceptancePlan(): FocusTreePlan {
  const routes = routeSpecs.map((spec, index) => buildRouteFocuses(spec, index + 1));
  const routeTerminals = routeSpecs.map((_, index) => routeFocusId(index + 1, ROUTE_FOCUS_COUNT));
  const common: FocusNodePlan[] = [
    commonFocus(
      'synthetic_root',
      'Synthetic Root',
      { mode: 'fixed', x: 14, y: 0, pinned: true },
      prerequisites(),
      900_001,
    ),
    commonFocus(
      'synthetic_mandate',
      'Synthetic Mandate',
      { mode: 'fixed', x: 14, y: 1, pinned: true },
      prerequisites(['synthetic_root']),
      900_002,
    ),
    commonFocus(
      'synthetic_route_hub',
      'Synthetic Route Hub',
      { mode: 'fixed', x: 14, y: 2, pinned: true },
      prerequisites(['synthetic_mandate']),
      900_003,
    ),
    commonFocus(
      'synthetic_global_convergence',
      'Synthetic Global Convergence',
      { mode: 'fixed', x: 14, y: 28, pinned: true },
      prerequisites(...routeTerminals.map((id) => [id])),
      900_004,
      {
        convergence: true,
        payoff: 'All route families converge',
        terminalKind: 'convergence',
      },
    ),
    commonFocus(
      'synthetic_epilogue',
      'Synthetic Epilogue',
      {
        mode: 'relative',
        x: 0,
        y: 1,
        relativeTo: 'synthetic_global_convergence',
        pinned: true,
      },
      prerequisites(['synthetic_global_convergence']),
      900_005,
      { payoff: 'Acceptance fixture capstone', terminalKind: 'capstone' },
    ),
  ];
  const [root, mandate, routeHub, globalConvergence, epilogue] = common;
  if (
    root === undefined ||
    mandate === undefined ||
    routeHub === undefined ||
    globalConvergence === undefined ||
    epilogue === undefined
  ) {
    throw new Error('Synthetic common focus spine is incomplete');
  }
  const focuses = [
    root,
    mandate,
    routeHub,
    ...routes.flatMap(({ focuses: routeFocuses }) => routeFocuses),
    globalConvergence,
    epilogue,
  ];
  if (focuses.length !== FOCUS_COUNT) {
    throw new Error(`Expected ${FOCUS_COUNT} focuses, generated ${focuses.length}`);
  }
  const plan: FocusTreePlan = {
    schemaVersion: FOCUS_PLAN_SCHEMA_VERSION,
    id: TREE_ID,
    countryAssignment: {
      raw: rawBlock('{\n\tfactor = 0\n\tmodifier = { add = 100 original_tag = SYN }\n}'),
      countryTags: ['SYN'],
    },
    default: false,
    branchGroups: routes.map(({ branch }) => branch),
    laneGroups: [
      ...routeSpecs.map((spec, index) => ({
        id: routeLaneId(index + 1),
        label: `${spec.label} lane`,
        order: index,
      })),
      { id: 'spine', label: 'Shared spine', order: routeSpecs.length },
    ],
    entryFocusIds: ['synthetic_root'],
    focuses,
    sharedFocusIds: [],
    continuousFocusPaletteIds: [CONTINUOUS_PALETTE_ID],
    continuousFocusIds: [...CONTINUOUS_FOCUS_IDS],
    continuousFocusPosition: { x: 14, y: 32 },
    initialShowPosition: rawBlock('{ focus = synthetic_root }', ['synthetic_root']),
    runtimeAssignment: {
      replacesExistingCountryTree: true,
      eventCreatedGuard: 'synthetic_acceptance_tree_created',
    },
    rawPassthrough: [],
    provenance: {
      sourcePath: `mod:${SOURCE_RELATIVE_PATH}`,
      sourceHash: '',
      importedPlanHash: '',
    },
  };
  const layout = layoutFocusTree(plan, {
    laneSpacing: LANE_SPACING,
    nodeSpacing: NODE_SPACING,
  });
  const source = `${compileFocusTree(plan, layout)}\n`;
  plan.provenance.sourceHash = sha256Bytes(source);
  plan.provenance.importedPlanHash = focusPlanHash(plan);
  return plan;
}

export function buildContinuousFocusAcceptancePalette(): ContinuousFocusPalettePlan {
  const palette: ContinuousFocusPalettePlan = {
    schemaVersion: FOCUS_PLAN_SCHEMA_VERSION,
    id: CONTINUOUS_PALETTE_ID,
    countryAssignment: {
      raw: rawBlock('{\n\tfactor = 0\n\tmodifier = { add = 100 original_tag = SYN }\n}'),
      countryTags: ['SYN'],
    },
    default: false,
    resetOnCivilWar: false,
    position: { x: 14, y: 32 },
    focuses: CONTINUOUS_FOCUS_IDS.map((id, index) => ({
      id,
      icons: [{ kind: 'static', sprite: SYNTHETIC_ICON }],
      localisation: {
        titleKey: id,
        descriptionKey: `${id}_desc`,
        workingLabel: index === 0 ? 'Continuous Industry' : 'Continuous Readiness',
      },
      rawPassthrough: [
        {
          kind: 'assignment',
          key: 'available',
          order: 0,
          text: 'available = { original_tag = SYN }',
        },
        {
          kind: 'assignment',
          key: 'enable',
          order: 1,
          text: 'enable = { always = yes }',
        },
        {
          kind: 'assignment',
          key: 'modifier',
          order: 2,
          text:
            index === 0
              ? 'modifier = { production_factory_max_efficiency_factor = 0.05 }'
              : 'modifier = { army_org_factor = 0.05 }',
        },
        {
          kind: 'assignment',
          key: 'ai_will_do',
          order: 3,
          text: 'ai_will_do = { factor = 1 }',
        },
        {
          kind: 'assignment',
          key: 'supports_ai_strategy',
          order: 4,
          text: 'supports_ai_strategy = ai_focus_military_advancements',
        },
        {
          kind: 'assignment',
          key: 'daily_cost',
          order: 5,
          text: 'daily_cost = 1',
        },
      ],
    })),
    rawPassthrough: [],
    provenance: {
      sourcePath: `mod:${CONTINUOUS_SOURCE_RELATIVE_PATH}`,
      sourceHash: '',
      importedPlanHash: '',
    },
  };
  const source = `${compileContinuousFocusPalette(palette)}\n`;
  palette.provenance.sourceHash = sha256Bytes(source);
  palette.provenance.importedPlanHash = sha256Bytes(source);
  return palette;
}

function referencedTargets(
  plan: FocusTreePlan,
  kind: 'decision' | 'decision_category' | 'event' | 'formable' | 'helper',
): string[] {
  return [
    ...new Set(
      plan.focuses.flatMap(({ links }) =>
        links.filter((link) => link.kind === kind).map(({ target }) => target),
      ),
    ),
  ].sort(compareCodeUnits);
}

function decisionSource(plan: FocusTreePlan): string {
  const ids = [
    ...referencedTargets(plan, 'decision'),
    ...referencedTargets(plan, 'formable'),
    'synthetic_decision_crisis_reveal',
  ].sort(compareCodeUnits);
  return [
    '# Project-owned synthetic decisions for Focus Tree Workbench acceptance tests.',
    'synthetic_acceptance_decisions = {',
    ...ids.flatMap((id, index) => [
      `\t${id} = {`,
      '\t\tvisible = { always = yes }',
      '\t\tavailable = { always = yes }',
      `\t\tcomplete_effect = { add_political_power = ${index + 1} }`,
      '\t}',
      '',
    ]),
    '}',
    '',
  ].join('\n');
}

function helperSource(plan: FocusTreePlan): string {
  return [
    '# Project-owned synthetic scripted effects for Focus Tree Workbench acceptance tests.',
    ...referencedTargets(plan, 'helper').flatMap((id) => [
      `${id} = {`,
      '\tadd_stability = 0.01',
      '}',
      '',
    ]),
  ].join('\n');
}

function eventSource(plan: FocusTreePlan): string {
  const revealEvents = routeSpecs.flatMap((spec, index) =>
    spec.visibility === 'conditional' || spec.visibility === 'hidden'
      ? [`synthetic_focus.${901 + index}`]
      : [],
  );
  const ids = [...new Set([...referencedTargets(plan, 'event'), ...revealEvents])].sort(
    compareCodeUnits,
  );
  return [
    '# Project-owned synthetic events for Focus Tree Workbench acceptance tests.',
    'add_namespace = synthetic_focus',
    '',
    ...ids.flatMap((id, index) => [
      'country_event = {',
      `\tid = ${id}`,
      `\ttitle = ${id}.t`,
      `\tdesc = ${id}.d`,
      '\tis_triggered_only = yes',
      '\toption = {',
      `\t\tname = ${id}.a`,
      `\t\tadd_political_power = ${index + 1}`,
      '\t}',
      '}',
      '',
    ]),
  ].join('\n');
}

function localisationSource(plan: FocusTreePlan, palette: ContinuousFocusPalettePlan): string {
  const focusEntries = [...plan.focuses, ...palette.focuses].flatMap((focus) => [
    ` ${focus.localisation.titleKey}: "${focus.localisation.workingLabel ?? focus.id}"`,
    ` ${focus.localisation.descriptionKey}: "Synthetic acceptance description for ${focus.id}."`,
  ]);
  const decisionEntries = [
    ...referencedTargets(plan, 'decision'),
    'synthetic_decision_crisis_reveal',
  ].map((id) => ` ${id}: "Synthetic decision ${id}"`);
  const eventEntries = eventSource(plan)
    .split('\n')
    .flatMap((line) => /^\tid = (synthetic_focus\.\d+)$/u.exec(line)?.[1] ?? '')
    .filter(Boolean)
    .flatMap((id) => [
      ` ${id}.t: "Synthetic event ${id}"`,
      ` ${id}.d: "Synthetic event description for ${id}."`,
      ` ${id}.a: "Continue"`,
    ]);
  return `\ufeff${['l_english:', ...focusEntries, ...decisionEntries, ...eventEntries, ''].join('\n')}`;
}

function invalidVariants(plan: FocusTreePlan): InvalidFixtureVariant[] {
  const eventFocus = plan.focuses.find(({ links }) => links.some(({ kind }) => kind === 'event'));
  const eventLink = eventFocus?.links.find(({ kind }) => kind === 'event');
  if (eventFocus === undefined || eventLink === undefined) {
    throw new Error('Synthetic plan did not generate an event-linked focus');
  }
  return [
    {
      id: 'prerequisite_cycle',
      mutation: {
        kind: 'replace_prerequisites',
        focusId: routeFocusId(1, 1),
        focusIds: [routeFocusId(1, ROUTE_FOCUS_COUNT)],
      },
      expectedDiagnosticCodes: ['FOCUS_PREREQUISITE_CYCLE'],
    },
    {
      id: 'missing_prerequisite',
      mutation: {
        kind: 'replace_prerequisites',
        focusId: routeFocusId(3, 5),
        focusIds: ['synthetic_missing_focus'],
      },
      expectedDiagnosticCodes: ['FOCUS_PREREQUISITE_MISSING'],
    },
    {
      id: 'duplicate_coordinate',
      mutation: {
        kind: 'replace_position',
        focusId: routeFocusId(2, 1),
        position: { mode: 'fixed', x: 14, y: 0, pinned: true },
      },
      expectedDiagnosticCodes: ['FOCUS_DUPLICATE_COORDINATE'],
    },
    {
      id: 'missing_event_reference',
      mutation: {
        kind: 'replace_link_target',
        focusId: eventFocus.id,
        from: eventLink.target,
        to: 'synthetic_focus.999999',
      },
      expectedDiagnosticCodes: ['FOCUS_GAMEPLAY_REFERENCE_MISSING'],
    },
    {
      id: 'hidden_without_reveal',
      mutation: { kind: 'remove_reveal', focusId: routeFocusId(8, 5) },
      expectedDiagnosticCodes: ['FOCUS_HIDDEN_WITHOUT_REVEAL'],
    },
  ];
}

async function syntheticFocusIcon(): Promise<Buffer> {
  const width = 128;
  const height = 64;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const secondFrame = x >= width / 2;
      pixels[offset] = secondFrame ? 224 : 42;
      pixels[offset + 1] = secondFrame ? 88 : 154;
      pixels[offset + 2] = secondFrame ? 66 : 218;
      pixels[offset + 3] = 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

async function fixtureFiles(): Promise<Map<string, string | Buffer>> {
  const plan = buildFocusAcceptancePlan();
  const palette = buildContinuousFocusAcceptancePalette();
  const layout = layoutFocusTree(plan, {
    laneSpacing: LANE_SPACING,
    nodeSpacing: NODE_SPACING,
  });
  const source = `${compileFocusTree(plan, layout)}\n`;
  const continuousSource = `${compileContinuousFocusPalette(palette)}\n`;
  const planJson = await prettyCanonical(plan);
  const sidecarJson = await prettyCanonical(createFocusPlanningSidecar(plan));
  const icon = await syntheticFocusIcon();
  const variants = invalidVariants(plan);
  const manifest = {
    schemaVersion: 1,
    treeId: TREE_ID,
    focusCount: plan.focuses.length,
    routeFamilyCount: new Set(plan.branchGroups.map(({ family }) => family)).size,
    layoutOptions: { laneSpacing: LANE_SPACING, nodeSpacing: NODE_SPACING },
    layoutHash: layout.layoutHash,
    sourceSha256: sha256Bytes(source),
    planSha256: sha256Bytes(planJson),
    features: {
      automatic: plan.focuses.filter(({ position }) => position.mode === 'auto').length,
      continuous: palette.focuses.length,
      continuousPalettes: plan.continuousFocusPaletteIds.length,
      convergence: plan.focuses.filter(({ convergence }) => convergence).length,
      crisis: plan.focuses.filter(({ visibility }) => visibility === 'crisis').length,
      decisionLinks: plan.focuses
        .flatMap(({ links }) => links)
        .filter(({ kind }) => kind === 'decision').length,
      decisionCategoryLinks: plan.focuses
        .flatMap(({ links }) => links)
        .filter(({ kind }) => kind === 'decision_category').length,
      eventLinks: plan.focuses.flatMap(({ links }) => links).filter(({ kind }) => kind === 'event')
        .length,
      formableLinks: plan.focuses
        .flatMap(({ links }) => links)
        .filter(({ kind }) => kind === 'formable').length,
      helperLinks: plan.focuses
        .flatMap(({ links }) => links)
        .filter(({ kind }) => kind === 'helper').length,
      hidden: plan.focuses.filter(({ visibility }) => visibility === 'hidden').length,
      mutualExclusionReferences: plan.focuses.flatMap(({ mutuallyExclusive }) => mutuallyExclusive)
        .length,
      pinned: plan.focuses.filter(({ position }) => position.pinned).length,
      relative: plan.focuses.filter(({ position }) => position.mode === 'relative').length,
      sharedSupport: plan.focuses.filter(({ sharedSupport }) => sharedSupport).length,
    },
    invalidVariants: variants.map(({ id, expectedDiagnosticCodes }) => ({
      id,
      expectedDiagnosticCodes,
    })),
  };
  const variantsJson = await prettyCanonical({ schemaVersion: 1, variants });
  const manifestJson = await prettyCanonical(manifest);
  return new Map<string, string | Buffer>([
    ['fixtures/focus/plans/synthetic_acceptance.plan.json', planJson],
    ['fixtures/focus/invalid/invalid-variants.json', variantsJson],
    ['fixtures/focus/fixture-manifest.json', manifestJson],
    [`fixtures/focus/workspace/${SOURCE_RELATIVE_PATH}`, source],
    [`fixtures/focus/workspace/${SIDECAR_RELATIVE_PATH}`, sidecarJson],
    [`fixtures/focus/workspace/${CONTINUOUS_SOURCE_RELATIVE_PATH}`, continuousSource],
    ['fixtures/focus/workspace/common/decisions/synthetic_acceptance.txt', decisionSource(plan)],
    [
      'fixtures/focus/workspace/common/scripted_effects/synthetic_acceptance.txt',
      helperSource(plan),
    ],
    ['fixtures/focus/workspace/events/synthetic_acceptance.txt', eventSource(plan)],
    [
      'fixtures/focus/workspace/interface/synthetic_acceptance.gfx',
      [
        '# Project-owned synthetic sprite definition for Focus Tree Workbench acceptance tests.',
        'spriteTypes = {',
        '\tspriteType = {',
        `\t\tname = "${SYNTHETIC_ICON}"`,
        '\t\ttexturefile = "gfx/interface/goals/synthetic_focus.png"',
        '\t\tnoOfFrames = 2',
        '\t}',
        '}',
        '',
      ].join('\n'),
    ],
    ['fixtures/focus/workspace/gfx/interface/goals/synthetic_focus.png', icon],
    [
      'fixtures/focus/workspace/localisation/english/synthetic_acceptance_l_english.yml',
      localisationSource(plan, palette),
    ],
  ]);
}

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const files = await fixtureFiles();
for (const [relativePath, content] of files) {
  const target = path.join(repositoryRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}
process.stderr.write(`Generated ${files.size} deterministic Focus Tree Workbench fixture files.\n`);
