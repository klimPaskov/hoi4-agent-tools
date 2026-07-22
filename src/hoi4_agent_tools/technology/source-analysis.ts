import path from 'node:path';
import { compareCodeUnits, deterministicId } from '../core/canonical.js';
import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  assignments,
  childBlocks,
  firstScalar,
  nodeLocation,
  parseClausewitz,
  sourcePartialLimitDiagnostics,
  type AssignmentNode,
  type BlockNode,
  type ScalarNode,
  type SourceDocument,
  type SourceRange,
} from '../core/source/index.js';
import type {
  DoctrineDefinition,
  TechnologyAiMetadata,
  TechnologyExternalReference,
  TechnologyExternalSourceKind,
  TechnologyGridbox,
  TechnologyHelperCall,
  TechnologySourceFragment,
  TechnologySourceProvenance,
  TechnologyUnlockKind,
  TechnologyUnresolvedAnalysis,
} from './model.js';

export interface TechnologySourceAnalysisContext {
  helperIds: ReadonlySet<string>;
  signal?: AbortSignal;
}

interface OwnerContext {
  kind: TechnologyExternalSourceKind;
  id: string;
}

const technologyStructuralFields = new Set([
  'ai_research_weights',
  'ai_will_do',
  'allow',
  'allow_branch',
  'categories',
  'desc',
  'doctrine',
  'doctrine_name',
  'enable_ability',
  'enable_abilities',
  'enable_building',
  'enable_equipment_modules',
  'enable_equipments',
  'enable_subunits',
  'enable_tactic',
  'folder',
  'force_use_small_tech_layout',
  'on_research_complete',
  'on_research_complete_limit',
  'path',
  'research_cost',
  'show_equipment_icon',
  'start_year',
  'sub_technologies',
  'tags',
  'xp_boost_cost',
  'xp_research_bonus',
  'xp_unlock_cost',
  'xor',
]);

const eventDefinitionKeys = new Set([
  'country_event',
  'news_event',
  'state_event',
  'unit_leader_event',
  'operative_leader_event',
]);

const decisionStructuralKeys = new Set([
  'allowed',
  'available',
  'icon',
  'picture',
  'priority',
  'scripted_gui',
  'target_root_trigger',
  'visible',
  'visible_when_empty',
]);

const staticIdentifier = /^[A-Za-z0-9_.:-]+$/u;

function normalizedPath(file: ScannedFile): string {
  return file.relativePath.replaceAll('\\', '/').toLowerCase();
}

function provenance(
  file: ScannedFile,
  document: SourceDocument,
  node: SourceRange,
  symbol: string,
): TechnologySourceProvenance {
  return {
    path: file.displayPath,
    rootKind: file.rootKind,
    loadOrder: file.loadOrder,
    location: nodeLocation(document, node, symbol),
    sourceHash: file.sha256,
  };
}

function sourceText(document: SourceDocument, node: SourceRange): string {
  return document.text.slice(node.start, node.end);
}

function scalarEntries(block: BlockNode): ScalarNode[] {
  return block.entries.filter((entry): entry is ScalarNode => entry.type === 'scalar');
}

function scalarValues(block: BlockNode): string[] {
  return scalarEntries(block).map(({ value }) => value);
}

function assignmentScalars(block: BlockNode, key: string): ScalarNode[] {
  return assignments(block, key).flatMap(({ value }) => (value.type === 'scalar' ? [value] : []));
}

function firstValue(block: BlockNode, key: string): string | undefined {
  return firstScalar(block, key)?.value;
}

function booleanValue(value: string | undefined): boolean | undefined {
  if (value?.toLowerCase() === 'yes') return true;
  if (value?.toLowerCase() === 'no') return false;
  return undefined;
}

function numericLiteral(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?(?:\d+\.?\d*|\.\d+)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function constantsIn(block: BlockNode): Map<string, string> {
  const result = new Map<string, string>();
  for (const assignment of assignments(block)) {
    if (!assignment.key.value.startsWith('@') || assignment.value.type !== 'scalar') continue;
    result.set(assignment.key.value, assignment.value.value);
  }
  return result;
}

function resolvedNumber(
  value: string | undefined,
  constants: ReadonlyMap<string, string>,
): number | undefined {
  let current = value;
  const seen = new Set<string>();
  for (let depth = 0; depth < 32; depth += 1) {
    const literal = numericLiteral(current);
    if (literal !== undefined) return literal;
    if (current === undefined || !current.startsWith('@') || seen.has(current)) return undefined;
    seen.add(current);
    current = constants.get(current);
  }
  return undefined;
}

function aiMetadata(block: BlockNode): TechnologyAiMetadata {
  const ai = childBlocks(block, 'ai_will_do')[0];
  const weights = childBlocks(block, 'ai_research_weights')[0];
  const researchWeights = Object.fromEntries(
    (weights === undefined ? [] : assignments(weights))
      .flatMap(({ key, value }) =>
        value.type === 'scalar' ? [[key.value, value.value] as const] : [],
      )
      .sort(([left], [right]) => compareCodeUnits(left, right)),
  );
  if (ai === undefined) return { present: false, zero: 'unknown', researchWeights };
  const base = firstValue(ai, 'base');
  const factor = firstValue(ai, 'factor');
  const zero =
    numericLiteral(base ?? factor) === 0
      ? true
      : base === undefined && factor === undefined
        ? 'unknown'
        : false;
  return {
    present: true,
    ...(base === undefined ? {} : { base }),
    ...(factor === undefined ? {} : { factor }),
    zero,
    researchWeights,
    expression: sourceTextForBlock(ai),
  };
}

function sourceTextForBlock(block: BlockNode): string {
  // The exact source text is attached later when an unsupported expression needs it. AI metadata
  // keeps a stable structural summary to avoid retaining a second copy of every source file.
  return assignments(block)
    .map(({ key, value }) => `${key.value}=${value.type === 'scalar' ? value.value : '{...}'}`)
    .join(' ');
}

function hiddenStatus(block: BlockNode): boolean | 'unknown' {
  const allow = childBlocks(block, 'allow')[0];
  if (allow === undefined) return false;
  const always = booleanValue(firstValue(allow, 'always'));
  if (always === false) return true;
  if (always === true && assignments(allow).length === 1) return false;
  return 'unknown';
}

function isDynamic(value: string): boolean {
  return !staticIdentifier.test(value) || /\[|\]|\$|\?|^var:|^event_target:/u.test(value);
}

function unresolved(
  kind: TechnologyUnresolvedAnalysis['kind'],
  expression: string,
  ownerId: string | undefined,
  location: SourceLocation | undefined,
  code: string,
  message: string,
): TechnologyUnresolvedAnalysis {
  return {
    id: deterministicId('tech-unresolved', { kind, expression, ownerId, location }),
    kind,
    expression,
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(location === undefined ? {} : { location }),
    confidence: 'unresolved',
    blockers: [{ code, message, ...(location === undefined ? {} : { location }) }],
  };
}

function addDynamicOrStatic(
  values: ScalarNode[],
  ownerId: string,
  document: SourceDocument,
  staticAction: (value: ScalarNode) => void,
  output: TechnologyUnresolvedAnalysis[],
  kind: TechnologyUnresolvedAnalysis['kind'],
): void {
  for (const value of values) {
    if (!isDynamic(value.value)) {
      staticAction(value);
      continue;
    }
    const location = nodeLocation(document, value, ownerId);
    output.push(
      unresolved(
        kind,
        value.value,
        ownerId,
        location,
        'TECH_DYNAMIC_REFERENCE_UNRESOLVED',
        `Dynamic technology reference ${value.value} cannot be resolved statically`,
      ),
    );
  }
}

function parseTechnologyDefinitions(
  file: ScannedFile,
  document: SourceDocument,
  fragment: TechnologySourceFragment,
): void {
  for (const wrapper of childBlocks(document.root, 'technologies')) {
    const constants = constantsIn(wrapper);
    for (const definition of assignments(wrapper)) {
      if (definition.key.value.startsWith('@') || definition.value.type !== 'block') continue;
      const block = definition.value;
      const id = definition.key.value;
      const source = provenance(file, document, definition, id);
      const folders: string[] = [];
      for (const folder of childBlocks(block, 'folder')) {
        const folderScalar = firstScalar(folder, 'name');
        if (folderScalar === undefined) continue;
        const folderId = folderScalar.value;
        if (isDynamic(folderId)) {
          fragment.unresolved.push(
            unresolved(
              'dynamic_reference',
              folderId,
              id,
              nodeLocation(document, folderScalar, id),
              'TECH_DYNAMIC_FOLDER_UNRESOLVED',
              `Dynamic folder reference ${folderId} cannot be resolved statically`,
            ),
          );
          continue;
        }
        folders.push(folderId);
        const position = childBlocks(folder, 'position')[0];
        const xScalar = position === undefined ? undefined : firstScalar(position, 'x');
        const yScalar = position === undefined ? undefined : firstScalar(position, 'y');
        const x = resolvedNumber(xScalar?.value, constants);
        const y = resolvedNumber(yScalar?.value, constants);
        fragment.placements.push({
          id: deterministicId('tech-placement', {
            technologyId: id,
            folderId,
            offset: folder.start,
            path: file.displayPath,
          }),
          technologyId: id,
          folderId,
          ...(x === undefined ? {} : { x }),
          ...(y === undefined ? {} : { y }),
          ...(xScalar === undefined || x !== undefined ? {} : { xExpression: xScalar.value }),
          ...(yScalar === undefined || y !== undefined ? {} : { yExpression: yScalar.value }),
          sourceAccurate: true,
          location: nodeLocation(document, folder, id),
        });
      }

      for (const pathBlock of childBlocks(block, 'path')) {
        const target = firstScalar(pathBlock, 'leads_to_tech');
        if (target === undefined) continue;
        if (isDynamic(target.value)) {
          fragment.unresolved.push(
            unresolved(
              'dynamic_reference',
              target.value,
              id,
              nodeLocation(document, target, id),
              'TECH_DYNAMIC_PREREQUISITE_UNRESOLVED',
              `Dynamic prerequisite target ${target.value} cannot be resolved statically`,
            ),
          );
          continue;
        }
        fragment.edges.push({
          id: deterministicId('tech-edge', {
            kind: 'prerequisite',
            from: id,
            to: target.value,
            path: file.displayPath,
            offset: target.start,
          }),
          kind: 'prerequisite',
          from: id,
          to: target.value,
          ...(firstValue(pathBlock, 'research_cost_coeff') === undefined
            ? {}
            : { coefficient: firstValue(pathBlock, 'research_cost_coeff')! }),
          ...(booleanValue(firstValue(pathBlock, 'ignore_for_layout')) === undefined
            ? {}
            : { ignoreForLayout: booleanValue(firstValue(pathBlock, 'ignore_for_layout'))! }),
          location: nodeLocation(document, target, id),
          confidence: 'confirmed',
        });
      }

      for (const xor of childBlocks(block, 'xor')) {
        addDynamicOrStatic(
          scalarEntries(xor),
          id,
          document,
          (target) =>
            fragment.edges.push({
              id: deterministicId('tech-edge', {
                kind: 'exclusive',
                from: id,
                to: target.value,
                path: file.displayPath,
                offset: target.start,
              }),
              kind: 'exclusive',
              from: id,
              to: target.value,
              location: nodeLocation(document, target, id),
              confidence: 'confirmed',
            }),
          fragment.unresolved,
          'dynamic_reference',
        );
      }

      const subTechnologies: string[] = [];
      for (const sub of childBlocks(block, 'sub_technologies')) {
        addDynamicOrStatic(
          scalarEntries(sub),
          id,
          document,
          (target) => {
            subTechnologies.push(target.value);
            fragment.edges.push({
              id: deterministicId('tech-edge', {
                kind: 'sub_technology',
                from: id,
                to: target.value,
                path: file.displayPath,
                offset: target.start,
              }),
              kind: 'sub_technology',
              from: id,
              to: target.value,
              location: nodeLocation(document, target, id),
              confidence: 'confirmed',
            });
          },
          fragment.unresolved,
          'dynamic_reference',
        );
      }

      const unlockSignatureFields: string[] = [];
      const addUnlock = (kind: TechnologyUnlockKind, target: ScalarNode, level?: string): void => {
        if (isDynamic(target.value)) {
          fragment.unresolved.push(
            unresolved(
              'dynamic_reference',
              target.value,
              id,
              nodeLocation(document, target, id),
              'TECH_DYNAMIC_UNLOCK_UNRESOLVED',
              `Dynamic unlock target ${target.value} cannot be resolved statically`,
            ),
          );
          return;
        }
        unlockSignatureFields.push(`${kind}:${target.value}:${level ?? ''}`);
        fragment.unlocks.push({
          id: deterministicId('tech-unlock', {
            technologyId: id,
            kind,
            targetId: target.value,
            level,
            path: file.displayPath,
            offset: target.start,
          }),
          technologyId: id,
          kind,
          targetId: target.value,
          ...(level === undefined ? {} : { level }),
          location: nodeLocation(document, target, id),
          confidence: 'confirmed',
          resolved: 'unknown',
        });
      };
      for (const [field, kind] of [
        ['enable_equipments', 'equipment'],
        ['enable_equipment_modules', 'equipment_module'],
        ['enable_subunits', 'sub_unit'],
        ['enable_abilities', 'ability'],
      ] as const) {
        for (const unlockBlock of childBlocks(block, field))
          for (const target of scalarEntries(unlockBlock)) addUnlock(kind, target);
      }
      for (const building of childBlocks(block, 'enable_building')) {
        const target = firstScalar(building, 'building');
        if (target !== undefined) addUnlock('building', target, firstValue(building, 'level'));
      }
      for (const tactic of assignmentScalars(block, 'enable_tactic')) addUnlock('tactic', tactic);
      for (const ability of assignmentScalars(block, 'enable_ability'))
        addUnlock('ability', ability);
      for (const assignment of assignments(block)) {
        if (
          !assignment.key.value.startsWith('enable_') ||
          technologyStructuralFields.has(assignment.key.value)
        )
          continue;
        if (assignment.value.type === 'scalar') addUnlock('other', assignment.value);
        else for (const target of scalarEntries(assignment.value)) addUnlock('other', target);
      }

      const categories = childBlocks(block, 'categories').flatMap(scalarValues);
      const tags = childBlocks(block, 'tags').flatMap(scalarValues);
      const effectKeys = [
        ...new Set(
          assignments(block)
            .map(({ key }) => key.value)
            .filter((key) => !technologyStructuralFields.has(key) && !key.startsWith('@')),
        ),
      ].sort(compareCodeUnits);
      const unsupportedFields = fragment.placements
        .filter(
          ({ technologyId, xExpression, yExpression }) =>
            technologyId === id && (xExpression !== undefined || yExpression !== undefined),
        )
        .map((placement) => ({
          field: 'folder.position',
          expression: `${placement.xExpression ?? placement.x ?? '?'}:${placement.yExpression ?? placement.y ?? '?'}`,
          location: placement.location,
          reason:
            'The source coordinate expression is not a resolvable file-local numeric constant',
        }));
      const doctrine = booleanValue(firstValue(block, 'doctrine')) === true;
      fragment.technologies.push({
        id,
        kind: doctrine ? 'legacy_doctrine' : 'technology',
        source,
        rawSource: document.text.slice(definition.start, definition.end),
        ...(firstValue(block, 'start_year') === undefined
          ? {}
          : { startYear: firstValue(block, 'start_year')! }),
        ...(firstValue(block, 'research_cost') === undefined
          ? {}
          : { researchCost: firstValue(block, 'research_cost')! }),
        ...(firstValue(block, 'doctrine_name') === undefined
          ? {}
          : { doctrineName: firstValue(block, 'doctrine_name')! }),
        hidden: hiddenStatus(block),
        folders: [...new Set(folders)].sort(compareCodeUnits),
        categories: [...new Set(categories)].sort(compareCodeUnits),
        tags: [...new Set(tags)].sort(compareCodeUnits),
        subTechnologies: [...new Set(subTechnologies)].sort(compareCodeUnits),
        ai: aiMetadata(block),
        iconSprite: `GFX_${id}_medium`,
        effectKeys,
        effectSignatureFields: [...effectKeys, ...unlockSignatureFields].sort(compareCodeUnits),
        unsupportedFields,
      });
    }
  }
}

function parseTechnologyTags(
  file: ScannedFile,
  document: SourceDocument,
  fragment: TechnologySourceFragment,
): void {
  for (const block of childBlocks(document.root, 'technology_categories')) {
    for (const scalar of scalarEntries(block)) {
      fragment.categories.push({
        id: scalar.value,
        kind: 'category',
        source: provenance(file, document, scalar, scalar.value),
      });
    }
  }
  for (const block of childBlocks(document.root, 'technology_tags')) {
    for (const scalar of scalarEntries(block)) {
      fragment.categories.push({
        id: scalar.value,
        kind: 'tag',
        source: provenance(file, document, scalar, scalar.value),
      });
    }
  }
  for (const wrapper of childBlocks(document.root, 'technology_folders')) {
    for (const definition of assignments(wrapper)) {
      if (definition.value.type !== 'block') continue;
      const id = definition.key.value;
      const block = definition.value;
      fragment.folders.push({
        id,
        doctrine: booleanValue(firstValue(block, 'doctrine')) === true,
        ...(firstValue(block, 'ledger') === undefined
          ? {}
          : { ledger: firstValue(block, 'ledger')! }),
        ...(childBlocks(block, 'available')[0] === undefined
          ? {}
          : { availableExpression: sourceText(document, childBlocks(block, 'available')[0]!) }),
        source: provenance(file, document, definition, id),
        localisation: { language: 'l_english', status: 'missing' },
      });
    }
  }
}

function parseUnlockTargets(
  file: ScannedFile,
  document: SourceDocument,
  fragment: TechnologySourceFragment,
): void {
  const sourcePath = normalizedPath(file);
  const wrappers: Array<{ key: string; kind: TechnologyUnlockKind }> = [];
  if (sourcePath.startsWith('common/units/equipment/modules/'))
    wrappers.push({ key: 'equipment_modules', kind: 'equipment_module' });
  else if (sourcePath.startsWith('common/units/equipment/'))
    wrappers.push({ key: 'equipments', kind: 'equipment' });
  if (sourcePath.startsWith('common/units/') && !sourcePath.startsWith('common/units/equipment/'))
    wrappers.push({ key: 'sub_units', kind: 'sub_unit' });
  if (sourcePath.startsWith('common/buildings/'))
    wrappers.push({ key: 'buildings', kind: 'building' });
  if (sourcePath.startsWith('common/abilities/'))
    wrappers.push({ key: 'ability', kind: 'ability' });
  if (sourcePath === 'common/combat_tactics.txt' || sourcePath.startsWith('common/combat_tactics/'))
    wrappers.push({ key: 'combat_tactics', kind: 'tactic' });
  for (const { key, kind } of wrappers) {
    for (const wrapper of childBlocks(document.root, key)) {
      for (const definition of assignments(wrapper)) {
        if (definition.value.type !== 'block' || definition.key.value === 'limit') continue;
        const id = definition.key.value;
        fragment.unlockTargets.push({
          id: `${kind}:${id}`,
          kind,
          targetId: id,
          source: provenance(file, document, definition, id),
        });
      }
    }
  }
}

function doctrineKind(sourcePath: string): DoctrineDefinition['kind'] | undefined {
  if (sourcePath.startsWith('common/doctrines/folders/')) return 'folder';
  if (sourcePath.startsWith('common/doctrines/grand_doctrines/')) return 'grand_doctrine';
  if (sourcePath.startsWith('common/doctrines/tracks/')) return 'track';
  if (sourcePath.startsWith('common/doctrines/subdoctrines/')) return 'subdoctrine';
  return undefined;
}

function parseModernDoctrines(
  file: ScannedFile,
  document: SourceDocument,
  fragment: TechnologySourceFragment,
): void {
  const kind = doctrineKind(normalizedPath(file));
  if (kind === undefined) return;
  for (const definition of assignments(document.root)) {
    if (definition.value.type !== 'block' || definition.key.value.startsWith('@')) continue;
    const block = definition.value;
    const id = definition.key.value;
    const trackIds = [
      ...assignmentScalars(block, 'track').map(({ value }) => value),
      ...childBlocks(block, 'track').flatMap(scalarValues),
      ...childBlocks(block, 'tracks').flatMap(scalarValues),
    ];
    const exclusiveIds = childBlocks(block, 'xor').flatMap(scalarValues);
    const base = {
      id,
      kind,
      ...(firstValue(block, 'folder') === undefined
        ? {}
        : { folderId: firstValue(block, 'folder')! }),
      trackIds: [...new Set(trackIds)].sort(compareCodeUnits),
      exclusiveIds: [...new Set(exclusiveIds)].sort(compareCodeUnits),
      ...(firstValue(block, 'name') === undefined ? {} : { nameKey: firstValue(block, 'name')! }),
      ...(firstValue(block, 'description') === undefined
        ? {}
        : { descriptionKey: firstValue(block, 'description')! }),
      ...(firstValue(block, 'xp_cost') === undefined
        ? {}
        : { xpCost: firstValue(block, 'xp_cost')! }),
      ...(firstValue(block, 'xp_type') === undefined
        ? {}
        : { xpType: firstValue(block, 'xp_type')! }),
      ai: aiMetadata(block),
      effectKeys: assignments(block)
        .map(({ key }) => key.value)
        .filter(
          (field) =>
            !new Set([
              'active',
              'ai_will_do',
              'allow_in_multiple_tracks',
              'available',
              'description',
              'folder',
              'icon',
              'mastery',
              'max_track_columns',
              'max_track_rows',
              'milestones',
              'name',
              'rewards',
              'track',
              'tracks',
              'visible',
              'xp_cost',
              'xp_type',
              'xor',
            ]).has(field),
        )
        .sort(compareCodeUnits),
      source: provenance(file, document, definition, id),
      ...(firstValue(block, 'icon') === undefined
        ? {}
        : { iconSprite: firstValue(block, 'icon')! }),
    } satisfies Omit<DoctrineDefinition, 'icon'> & { iconSprite?: string };
    fragment.doctrineDefinitions.push(base);
    if (kind !== 'subdoctrine') continue;
    for (const rewards of childBlocks(block, 'rewards')) {
      let index = 0;
      for (const entry of rewards.entries) {
        if (entry.type === 'scalar') continue;
        const rewardId =
          entry.type === 'assignment' ? entry.key.value : `${id}_reward_${String(index + 1)}`;
        const rewardBlock =
          entry.type === 'assignment'
            ? entry.value.type === 'block'
              ? entry.value
              : undefined
            : entry;
        index += 1;
        fragment.doctrineDefinitions.push({
          id: rewardId,
          kind: 'reward',
          trackIds: [...base.trackIds],
          parentId: id,
          exclusiveIds: [],
          ai: { present: false, zero: 'unknown', researchWeights: {} },
          effectKeys:
            rewardBlock === undefined
              ? []
              : assignments(rewardBlock)
                  .map(({ key }) => key.value)
                  .sort(compareCodeUnits),
          source: provenance(file, document, entry, rewardId),
        });
      }
    }
  }
}

function parseTechnologyGridboxes(
  file: ScannedFile,
  document: SourceDocument,
  fragment: TechnologySourceFragment,
  signal?: AbortSignal,
): void {
  if (!normalizedPath(file).endsWith('.gui')) return;
  const stack: Array<{ block: BlockNode; namedContainers: string[] }> = [
    { block: document.root, namedContainers: [] },
  ];
  let visited = 0;
  while (stack.length > 0) {
    if (visited % 128 === 0) signal?.throwIfAborted();
    visited += 1;
    const current = stack.pop()!;
    for (const assignment of assignments(current.block)) {
      if (assignment.value.type !== 'block') continue;
      const block = assignment.value;
      const elementType = assignment.key.value.toLowerCase();
      const name = firstScalar(block, 'name');
      if (elementType === 'gridboxtype' && name?.value.endsWith('_tree') === true) {
        const position = childBlocks(block, 'position')[0];
        const slotSize = childBlocks(block, 'slotsize')[0];
        const x = numericLiteral(position === undefined ? undefined : firstValue(position, 'x'));
        const y = numericLiteral(position === undefined ? undefined : firstValue(position, 'y'));
        const width = numericLiteral(
          slotSize === undefined ? undefined : firstValue(slotSize, 'width'),
        );
        const height = numericLiteral(
          slotSize === undefined ? undefined : firstValue(slotSize, 'height'),
        );
        const gridbox: TechnologyGridbox = {
          id: deterministicId('tech-gridbox', {
            name: name.value,
            path: file.displayPath,
            offset: assignment.start,
          }),
          name: name.value,
          ...(current.namedContainers.at(-1) === undefined
            ? {}
            : { folderId: current.namedContainers.at(-1)! }),
          position: {
            ...(x === undefined ? {} : { x }),
            ...(y === undefined ? {} : { y }),
            ...(position === undefined || x !== undefined
              ? {}
              : { xExpression: firstValue(position, 'x') ?? '<missing>' }),
            ...(position === undefined || y !== undefined
              ? {}
              : { yExpression: firstValue(position, 'y') ?? '<missing>' }),
          },
          slotSize: {
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height }),
            ...(slotSize === undefined || width !== undefined
              ? {}
              : { widthExpression: firstValue(slotSize, 'width') ?? '<missing>' }),
            ...(slotSize === undefined || height !== undefined
              ? {}
              : { heightExpression: firstValue(slotSize, 'height') ?? '<missing>' }),
          },
          ...(firstValue(block, 'format') === undefined
            ? {}
            : { format: firstValue(block, 'format')! }),
          location: nodeLocation(document, assignment, name.value),
          sourcePath: file.displayPath,
          loadOrder: file.loadOrder,
        };
        fragment.gridboxes.push(gridbox);
      }
      const namedContainers =
        name !== undefined &&
        (elementType === 'containerwindowtype' || elementType === 'windowtype')
          ? [...current.namedContainers, name.value]
          : current.namedContainers;
      stack.push({ block, namedContainers });
    }
  }
}

function initialOwner(file: ScannedFile): OwnerContext | undefined {
  const sourcePath = normalizedPath(file);
  if (sourcePath.startsWith('history/countries/')) {
    const filename = path.posix.basename(file.relativePath.replaceAll('\\', '/'));
    return { kind: 'country_history', id: filename.slice(0, 3).toUpperCase() };
  }
  return undefined;
}

function nextOwner(
  file: ScannedFile,
  assignment: AssignmentNode,
  depth: number,
  ancestors: readonly string[],
  current: OwnerContext | undefined,
): OwnerContext | undefined {
  if (assignment.value.type !== 'block') return current;
  const sourcePath = normalizedPath(file);
  const block = assignment.value;
  const key = assignment.key.value;
  if (key === 'focus') {
    const id = firstValue(block, 'id');
    if (id !== undefined) return { kind: 'focus', id };
  }
  if (eventDefinitionKeys.has(key)) {
    const id = firstValue(block, 'id');
    if (id !== undefined) return { kind: 'event', id };
  }
  if (sourcePath.startsWith('common/scripted_effects/') && depth === 0)
    return { kind: 'scripted_effect', id: key };
  if (sourcePath.startsWith('common/on_actions/') && ancestors.at(-1) === 'on_actions')
    return { kind: 'on_action', id: key };
  if (
    sourcePath.startsWith('common/decisions/') &&
    depth === 1 &&
    !decisionStructuralKeys.has(key)
  ) {
    const mission =
      firstScalar(block, 'days_mission_timeout') !== undefined ||
      firstScalar(block, 'days_remove') !== undefined ||
      /mission/iu.test(key);
    return { kind: mission ? 'mission' : 'decision', id: key };
  }
  if (sourcePath.startsWith('common/ideas/') && ancestors[0] === 'ideas' && ancestors.length >= 1)
    return { kind: 'idea', id: key };
  if (sourcePath.startsWith('common/characters/') && ancestors.length >= 1)
    return { kind: 'character', id: key };
  if (sourcePath.startsWith('history/countries/') && key === '1936.1.1')
    return current === undefined ? undefined : { kind: 'startup_effect', id: current.id };
  return current;
}

function referenceOwner(file: ScannedFile, owner: OwnerContext | undefined): OwnerContext {
  return (
    owner ?? {
      kind: 'other',
      id: file.relativePath.replaceAll('\\', '/'),
    }
  );
}

function addExternalReference(
  output: TechnologyExternalReference[],
  input: Omit<TechnologyExternalReference, 'id'>,
): void {
  output.push({
    id: deterministicId('tech-external', {
      kind: input.kind,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      technologyId: input.technologyId,
      categoryId: input.categoryId,
      location: input.location,
      expression: input.expression,
    }),
    ...input,
  });
}

function parseExternalReferences(
  file: ScannedFile,
  document: SourceDocument,
  fragment: TechnologySourceFragment,
  context: TechnologySourceAnalysisContext,
): void {
  const stack: Array<{
    block: BlockNode;
    depth: number;
    ancestors: string[];
    owner?: OwnerContext;
  }> = [
    {
      block: document.root,
      depth: 0,
      ancestors: [],
      ...(initialOwner(file) === undefined ? {} : { owner: initialOwner(file)! }),
    },
  ];
  let visited = 0;
  while (stack.length > 0) {
    if (visited % 256 === 0) context.signal?.throwIfAborted();
    visited += 1;
    const current = stack.pop()!;
    for (const assignment of [...assignments(current.block)].reverse()) {
      const key = assignment.key.value;
      const currentOwner = referenceOwner(file, current.owner);
      if (assignment.value.type === 'scalar') {
        if (['has_tech', 'has_technology', 'is_researching_technology'].includes(key)) {
          const target = assignment.value;
          addExternalReference(fragment.externalReferences, {
            kind: 'reference',
            sourceKind: currentOwner.kind,
            sourceId: currentOwner.id,
            technologyId: target.value,
            expression: sourceText(document, assignment),
            location: nodeLocation(document, target, currentOwner.id),
            helperStack: currentOwner.kind === 'scripted_effect' ? [currentOwner.id] : [],
            confidence: isDynamic(target.value) ? 'unresolved' : 'confirmed',
            dynamic: isDynamic(target.value),
            metadata: { trigger: key },
          });
        }
        if (
          current.depth > 0 &&
          context.helperIds.has(key) &&
          !(currentOwner.kind === 'scripted_effect' && currentOwner.id === key)
        ) {
          fragment.helperCalls.push({
            id: deterministicId('tech-helper-call', {
              sourceKind: currentOwner.kind,
              sourceId: currentOwner.id,
              helperId: key,
              path: file.displayPath,
              offset: assignment.start,
            }),
            sourceKind: currentOwner.kind,
            sourceId: currentOwner.id,
            helperId: key,
            location: nodeLocation(document, assignment, currentOwner.id),
            confidence: 'high',
          });
        }
        continue;
      }
      const owner = nextOwner(file, assignment, current.depth, current.ancestors, current.owner);
      const selectedOwner = referenceOwner(file, owner);
      const block = assignment.value;
      if (key === 'set_technology') {
        for (const target of assignments(block)) {
          if (target.key.value === 'popup') continue;
          const targetId = target.key.value;
          const expression = sourceText(document, target);
          const location = nodeLocation(document, target, selectedOwner.id);
          if (isDynamic(targetId)) {
            fragment.unresolved.push(
              unresolved(
                'dynamic_reference',
                expression,
                selectedOwner.id,
                location,
                'TECH_DYNAMIC_GRANT_UNRESOLVED',
                'Dynamic set_technology target cannot be resolved statically',
              ),
            );
            continue;
          }
          const value = target.value.type === 'scalar' ? target.value.value : expression;
          const removal = value === '0' || value.toLowerCase() === 'no';
          addExternalReference(fragment.externalReferences, {
            kind:
              selectedOwner.kind === 'country_history' || selectedOwner.kind === 'startup_effect'
                ? 'starting_technology'
                : removal
                  ? 'remove'
                  : 'grant',
            sourceKind: selectedOwner.kind,
            sourceId: selectedOwner.id,
            technologyId: targetId,
            expression,
            location,
            helperStack: selectedOwner.kind === 'scripted_effect' ? [selectedOwner.id] : [],
            confidence: 'confirmed',
            dynamic: false,
            metadata: { value },
          });
        }
      }
      if (key === 'add_tech_bonus' || key === 'add_doctrine_cost_reduction') {
        for (const target of [
          ...assignmentScalars(block, 'technology'),
          ...assignmentScalars(block, 'category'),
        ]) {
          const targetKind = assignments(block, 'technology').some(({ value }) => value === target)
            ? 'technology'
            : 'category';
          const expression = sourceText(document, target);
          const location = nodeLocation(document, target, selectedOwner.id);
          if (isDynamic(target.value)) {
            fragment.unresolved.push(
              unresolved(
                'dynamic_reference',
                expression,
                selectedOwner.id,
                location,
                'TECH_DYNAMIC_BONUS_UNRESOLVED',
                'Dynamic research-bonus target cannot be resolved statically',
              ),
            );
            continue;
          }
          addExternalReference(fragment.externalReferences, {
            kind: 'research_bonus',
            sourceKind: selectedOwner.kind,
            sourceId: selectedOwner.id,
            ...(targetKind === 'technology'
              ? { technologyId: target.value }
              : { categoryId: target.value }),
            expression,
            location,
            helperStack: selectedOwner.kind === 'scripted_effect' ? [selectedOwner.id] : [],
            confidence: 'confirmed',
            dynamic: false,
            metadata: {
              effect: key,
              bonus: firstValue(block, 'bonus') ?? firstValue(block, 'cost_reduction') ?? null,
              uses: firstValue(block, 'uses') ?? null,
              aheadReduction: firstValue(block, 'ahead_reduction') ?? null,
            },
          });
        }
      }
      if (key === 'research_bonus') {
        for (const target of assignments(block)) {
          if (target.value.type !== 'scalar') continue;
          const location = nodeLocation(document, target, selectedOwner.id);
          addExternalReference(fragment.externalReferences, {
            kind: 'research_bonus',
            sourceKind: selectedOwner.kind,
            sourceId: selectedOwner.id,
            categoryId: target.key.value,
            expression: sourceText(document, target),
            location,
            helperStack: selectedOwner.kind === 'scripted_effect' ? [selectedOwner.id] : [],
            confidence: isDynamic(target.key.value) ? 'unresolved' : 'confirmed',
            dynamic: isDynamic(target.key.value),
            metadata: { value: target.value.value, effect: 'research_bonus' },
          });
        }
      }
      if (key === 'technology_sharing_group') {
        const sharingId = firstValue(block, 'id') ?? `${file.displayPath}:${assignment.start}`;
        for (const category of childBlocks(block, 'categories').flatMap(scalarEntries)) {
          addExternalReference(fragment.externalReferences, {
            kind: 'technology_sharing',
            sourceKind: 'technology_sharing',
            sourceId: sharingId,
            categoryId: category.value,
            expression: sourceText(document, category),
            location: nodeLocation(document, category, sharingId),
            helperStack: [],
            confidence: isDynamic(category.value) ? 'unresolved' : 'confirmed',
            dynamic: isDynamic(category.value),
            metadata: {},
          });
        }
      }
      if (
        current.depth > 0 &&
        context.helperIds.has(key) &&
        !(selectedOwner.kind === 'scripted_effect' && selectedOwner.id === key)
      ) {
        const call: TechnologyHelperCall = {
          id: deterministicId('tech-helper-call', {
            sourceKind: selectedOwner.kind,
            sourceId: selectedOwner.id,
            helperId: key,
            path: file.displayPath,
            offset: assignment.start,
          }),
          sourceKind: selectedOwner.kind,
          sourceId: selectedOwner.id,
          helperId: key,
          location: nodeLocation(document, assignment, selectedOwner.id),
          confidence: 'high',
        };
        fragment.helperCalls.push(call);
      }
      stack.push({
        block,
        depth: current.depth + 1,
        ancestors: [...current.ancestors, key],
        ...(owner === undefined ? {} : { owner }),
      });
    }
  }
}

export function analyzeTechnologySource(
  file: ScannedFile,
  context: TechnologySourceAnalysisContext,
): TechnologySourceFragment {
  context.signal?.throwIfAborted();
  const fragment: TechnologySourceFragment = {
    sourcePath: file.displayPath,
    sourceHash: file.sha256,
    technologies: [],
    folders: [],
    placements: [],
    gridboxes: [],
    edges: [],
    categories: [],
    doctrineDefinitions: [],
    unlockTargets: [],
    unlocks: [],
    externalReferences: [],
    helperCalls: [],
    unresolved: [],
    diagnostics: [],
  };
  if (!/\.(?:txt|gui|gfx)$/iu.test(file.relativePath)) return fragment;
  if (!file.bytes.includes(0x3d)) return fragment;
  const document = parseClausewitz(file.bytes, file.displayPath);
  const limitDiagnostics = sourcePartialLimitDiagnostics(document.diagnostics);
  if (limitDiagnostics.length > 0) {
    fragment.diagnostics.push(...limitDiagnostics);
    fragment.unresolved.push(
      unresolved(
        'partial_source',
        file.displayPath,
        undefined,
        limitDiagnostics.find(({ location }) => location !== undefined)?.location,
        'TECH_SOURCE_PARTIAL',
        'Technology analysis skipped a source that exceeded a shared parser limit',
      ),
    );
    return fragment;
  }
  fragment.diagnostics.push(...document.diagnostics);
  const sourcePath = normalizedPath(file);
  if (sourcePath.startsWith('common/technologies/'))
    parseTechnologyDefinitions(file, document, fragment);
  if (sourcePath.startsWith('common/technology_tags/'))
    parseTechnologyTags(file, document, fragment);
  parseUnlockTargets(file, document, fragment);
  parseModernDoctrines(file, document, fragment);
  parseTechnologyGridboxes(file, document, fragment, context.signal);
  parseExternalReferences(file, document, fragment, context);
  context.signal?.throwIfAborted();
  return fragment;
}

export function technologySourceFragmentCacheKey(
  file: ScannedFile,
  catalogFingerprint: string,
): string {
  return `${file.sha256}:${catalogFingerprint}`;
}

export interface TechnologySourceFragmentCacheLike {
  get(key: string): TechnologySourceFragment | undefined;
  set(key: string, fragment: TechnologySourceFragment, sourceBytes: number): void;
}

export function technologySourceFiles(files: readonly ScannedFile[]): ScannedFile[] {
  return files
    .filter(({ shadowedBy, relativePath }) => {
      if (shadowedBy !== undefined) return false;
      const sourcePath = relativePath.replaceAll('\\', '/').toLowerCase();
      return (
        sourcePath.startsWith('common/technologies/') ||
        sourcePath.startsWith('common/technology_tags/') ||
        sourcePath.startsWith('common/technology_sharing/') ||
        sourcePath.startsWith('common/doctrines/') ||
        sourcePath.startsWith('common/units/') ||
        sourcePath.startsWith('common/buildings/') ||
        sourcePath.startsWith('common/abilities/') ||
        sourcePath.startsWith('common/national_focus/') ||
        sourcePath.startsWith('common/decisions/') ||
        sourcePath.startsWith('common/scripted_effects/') ||
        sourcePath.startsWith('common/on_actions/') ||
        sourcePath.startsWith('common/ideas/') ||
        sourcePath.startsWith('common/characters/') ||
        sourcePath.startsWith('events/') ||
        sourcePath.startsWith('history/countries/') ||
        (sourcePath.startsWith('interface/') && sourcePath.endsWith('.gui')) ||
        sourcePath === 'common/combat_tactics.txt'
      );
    })
    .sort((left, right) => compareCodeUnits(left.displayPath, right.displayPath));
}

export function technologyAnalysisDiagnostics(
  fragments: readonly TechnologySourceFragment[],
  includeGameDiagnostics = false,
): Diagnostic[] {
  return fragments
    .flatMap(({ diagnostics }) => diagnostics)
    .filter(
      (diagnostic) =>
        includeGameDiagnostics ||
        diagnostic.location?.path.startsWith('mod:') === true ||
        diagnostic.location?.path.startsWith('fixture:') === true,
    );
}
