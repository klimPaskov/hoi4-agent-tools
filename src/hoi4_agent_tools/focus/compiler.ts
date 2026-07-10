import { sha256Bytes } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import { assignments, firstScalar, nodeLocation, parseClausewitz } from '../core/source/index.js';
import {
  layoutNodeMap,
  type ContinuousFocusDefinition,
  type ContinuousFocusPalettePlan,
  type FocusCompiledSource,
  type FocusLayoutResult,
  type FocusNodePlan,
  type FocusRouteLock,
  type FocusTreePlan,
} from './model.js';

function indent(level: number): string {
  return '\t'.repeat(level);
}

function normalizeMultiline(text: string): string[] {
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim().split('\n');
  const nonBlank = lines.slice(1).filter((line) => line.trim().length > 0);
  const common =
    nonBlank.length === 0
      ? 0
      : Math.min(...nonBlank.map((line) => /^[\t ]*/u.exec(line)?.[0].length ?? 0));
  return lines.map((line, index) => (index === 0 ? line.trimStart() : line.slice(common)));
}

function indentedRaw(text: string, level: number): string {
  return normalizeMultiline(text)
    .map((line) => `${indent(level)}${line}`)
    .join('\n');
}

function blockAssignment(key: string, text: string, level: number): string {
  const lines = normalizeMultiline(text);
  if (lines.length === 1) return `${indent(level)}${key} = ${lines[0]}`;
  return [
    `${indent(level)}${key} = ${lines[0]}`,
    ...lines.slice(1).map((line) => `${indent(level)}${line}`),
  ].join('\n');
}

function blockBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return trimmed;
  return trimmed.slice(1, -1).trim();
}

function routeLockBody(lock: FocusRouteLock): string {
  const predicates = [
    ...lock.requiredFocusIds.map((id) => `has_completed_focus = ${id}`),
    ...lock.excludedFocusIds.map((id) => `NOT = { has_completed_focus = ${id} }`),
    ...(lock.alwaysImpossible === true ? ['always = no'] : []),
  ];
  if (predicates.length === 0) return 'always = yes';
  return lock.mode === 'any' && predicates.length > 1
    ? `OR = { ${predicates.join(' ')} }`
    : predicates.join(' ');
}

export function focusTriggerBlockText(
  focus: FocusNodePlan,
  field: 'available' | 'allow_branch',
): string | undefined {
  const raw =
    field === 'available' ? focus.availability : (focus.allowBranch ?? focus.reveal?.trigger);
  const locks = focus.routeLocks.filter((lock) => (lock.field ?? 'available') === field);
  const parts = [
    ...(raw === undefined || blockBody(raw.text).length === 0 ? [] : [blockBody(raw.text)]),
    ...locks.map(routeLockBody),
  ];
  return parts.length === 0 ? undefined : `{ ${parts.join(' ')} }`;
}

function iconLines(
  definition: Pick<FocusNodePlan, 'icons'> | Pick<ContinuousFocusDefinition, 'icons'>,
  level: number,
): string[] {
  const lines: string[] = [];
  for (const icon of definition.icons) {
    if (icon.kind === 'static') {
      lines.push(`${indent(level)}icon = ${icon.sprite}`);
    } else {
      lines.push(`${indent(level)}icon = {`);
      if (icon.trigger !== undefined)
        lines.push(blockAssignment('trigger', icon.trigger.text, level + 1));
      lines.push(`${indent(level + 1)}value = ${icon.sprite}`, `${indent(level)}}`);
    }
  }
  return lines;
}

function positionLines(focus: FocusNodePlan, layout: FocusLayoutResult | undefined): string[] {
  if (focus.position.mode === 'relative') {
    return [
      `x = ${focus.position.x}`,
      `y = ${focus.position.y}`,
      `relative_position_id = ${focus.position.relativeTo}`,
    ];
  }
  if (focus.position.mode === 'fixed') {
    return [`x = ${focus.position.x}`, `y = ${focus.position.y}`];
  }
  const placed = layoutNodeMap(
    layout ?? {
      treeId: '',
      nodes: [],
      decisions: [],
      diagnostics: [],
      layoutHash: '',
    },
  ).get(focus.id);
  if (placed === undefined) {
    throw new ServiceError(
      'FOCUS_LAYOUT_REQUIRED',
      `Automatic focus ${focus.id} has no layout position`,
      {
        focusId: focus.id,
      },
    );
  }
  return [`x = ${placed.x}`, `y = ${placed.y}`];
}

export function compileFocusBlock(
  focus: FocusNodePlan,
  layout: FocusLayoutResult | undefined,
): string {
  if ((focus as { continuous?: boolean }).continuous === true) {
    throw new ServiceError(
      'FOCUS_CONTINUOUS_SOURCE_INVALID',
      `Focus ${focus.id} is marked continuous inside a national focus tree; define it in common/continuous_focus instead`,
      { focusId: focus.id },
    );
  }
  const invalidPassthrough = focus.rawPassthrough.find(
    ({ key, text }) =>
      (key !== undefined && ['hidden', 'crisis', 'continuous'].includes(key.toLowerCase())) ||
      /^\s*(?:hidden|crisis|continuous)\s*=/iu.test(text),
  );
  if (invalidPassthrough !== undefined) {
    throw new ServiceError(
      'FOCUS_INVALID_NATIONAL_FIELD',
      `Focus ${focus.id} contains planner-only or continuous metadata in national-focus source passthrough`,
      { focusId: focus.id, field: invalidPassthrough.key ?? null },
    );
  }
  const lines: string[] = [`${indent(1)}focus = {`, `${indent(2)}id = ${focus.id}`];
  lines.push(...iconLines(focus, 2));
  for (const group of focus.prerequisites.groups) {
    const targets = group.focusIds.map((id) => `focus = ${id}`).join(' ');
    const raw = group.rawPassthrough.map(({ text }) => text.trim()).join(' ');
    lines.push(`${indent(2)}prerequisite = { ${[targets, raw].filter(Boolean).join(' ')} }`);
  }
  if (focus.mutuallyExclusive.length > 0) {
    lines.push(
      `${indent(2)}mutually_exclusive = { ${focus.mutuallyExclusive.map((id) => `focus = ${id}`).join(' ')} }`,
    );
  }
  lines.push(...positionLines(focus, layout).map((line) => `${indent(2)}${line}`));
  if (focus.cost !== undefined) lines.push(`${indent(2)}cost = ${focus.cost}`);
  const availability = focusTriggerBlockText(focus, 'available');
  if (availability !== undefined) lines.push(blockAssignment('available', availability, 2));
  if (focus.bypass !== undefined) lines.push(blockAssignment('bypass', focus.bypass.text, 2));
  const allowBranch = focusTriggerBlockText(focus, 'allow_branch');
  if (focus.visibility !== 'normal' && allowBranch === undefined) {
    throw new ServiceError(
      'FOCUS_VISIBILITY_TRIGGER_REQUIRED',
      `${focus.visibility} focus ${focus.id} requires an engine-valid allow_branch trigger`,
      { focusId: focus.id, visibility: focus.visibility },
    );
  }
  if (allowBranch !== undefined) lines.push(blockAssignment('allow_branch', allowBranch, 2));
  if (focus.filters.length > 0) {
    lines.push(`${indent(2)}search_filters = { ${focus.filters.join(' ')} }`);
  }
  if (focus.ai.raw !== undefined) lines.push(blockAssignment('ai_will_do', focus.ai.raw.text, 2));
  if (focus.completionReward !== undefined) {
    lines.push(blockAssignment('completion_reward', focus.completionReward.text, 2));
  }
  for (const raw of [...focus.rawPassthrough].sort((left, right) => left.order - right.order)) {
    lines.push(indentedRaw(raw.text, 2));
  }
  lines.push(`${indent(1)}}`);
  return lines.join('\n');
}

export function compileContinuousFocusBlock(focus: ContinuousFocusDefinition): string {
  const lines = [`${indent(1)}focus = {`, `${indent(2)}id = ${focus.id}`];
  lines.push(...iconLines(focus, 2));
  for (const raw of [...focus.rawPassthrough].sort((left, right) => left.order - right.order)) {
    lines.push(indentedRaw(raw.text, 2));
  }
  lines.push(`${indent(1)}}`);
  return lines.join('\n');
}

export function compileContinuousFocusPalette(plan: ContinuousFocusPalettePlan): string {
  const lines = ['continuous_focus_palette = {', `${indent(1)}id = ${plan.id}`];
  if (plan.countryAssignment !== undefined) {
    lines.push(blockAssignment('country', plan.countryAssignment.raw.text, 1));
  }
  if (plan.default) lines.push(`${indent(1)}default = yes`);
  if (plan.resetOnCivilWar !== undefined) {
    lines.push(`${indent(1)}reset_on_civilwar = ${plan.resetOnCivilWar ? 'yes' : 'no'}`);
  }
  if (plan.position !== undefined) {
    lines.push(`${indent(1)}position = { x = ${plan.position.x} y = ${plan.position.y} }`);
  }
  for (const focus of plan.focuses) lines.push('', compileContinuousFocusBlock(focus));
  for (const raw of [...plan.rawPassthrough].sort((left, right) => left.order - right.order)) {
    lines.push('', indentedRaw(raw.text, 1));
  }
  lines.push('}');
  return lines.join('\n');
}

export function compileFocusTree(plan: FocusTreePlan, layout?: FocusLayoutResult): string {
  if (layout !== undefined && layout.treeId !== plan.id) {
    throw new ServiceError(
      'FOCUS_LAYOUT_TREE_MISMATCH',
      'Layout belongs to a different focus tree',
      {
        planTreeId: plan.id,
        layoutTreeId: layout.treeId,
      },
    );
  }
  const lines: string[] = ['focus_tree = {', `${indent(1)}id = ${plan.id}`];
  if (plan.countryAssignment !== undefined) {
    lines.push(blockAssignment('country', plan.countryAssignment.raw.text, 1));
  }
  if (plan.default) lines.push(`${indent(1)}default = yes`);
  for (const shared of plan.sharedFocusIds) lines.push(`${indent(1)}shared_focus = ${shared}`);
  if (plan.continuousFocusPosition !== undefined) {
    lines.push(
      `${indent(1)}continuous_focus_position = { x = ${plan.continuousFocusPosition.x} y = ${plan.continuousFocusPosition.y} }`,
    );
  }
  if (plan.initialShowPosition !== undefined) {
    lines.push(blockAssignment('initial_show_position', plan.initialShowPosition.text, 1));
  }
  for (const focus of plan.focuses) lines.push('', compileFocusBlock(focus, layout));
  for (const raw of [...plan.rawPassthrough].sort((left, right) => left.order - right.order)) {
    lines.push('', indentedRaw(raw.text, 1));
  }
  lines.push('}');
  return lines.join('\n');
}

export function compileFocusTreeWithSourceMap(
  plan: FocusTreePlan,
  layout?: FocusLayoutResult,
  generatedPath = `generated:${plan.id}.txt`,
): FocusCompiledSource {
  const source = compileFocusTree(plan, layout);
  const document = parseClausewitz(Buffer.from(source, 'utf8'), generatedPath);
  const tree = assignments(document.root, 'focus_tree').find(
    (assignment) =>
      assignment.value.type === 'block' && firstScalar(assignment.value, 'id')?.value === plan.id,
  );
  const planById = new Map(plan.focuses.map((focus) => [focus.id, focus]));
  const mappings =
    tree?.value.type === 'block'
      ? assignments(tree.value, 'focus').flatMap((assignment) => {
          if (assignment.value.type !== 'block') return [];
          const focusId = firstScalar(assignment.value, 'id')?.value;
          if (focusId === undefined) return [];
          const planFocus = planById.get(focusId);
          return [
            {
              focusId,
              generatedLocation: nodeLocation(document, assignment, focusId),
              ...(planFocus?.sourceLocation === undefined
                ? {}
                : { planNodeLocation: planFocus.sourceLocation }),
            },
          ];
        })
      : [];
  return {
    source,
    sourceMap: {
      schemaVersion: 1,
      treeId: plan.id,
      generatedPath,
      generatedSha256: sha256Bytes(source),
      mappings,
    },
  };
}

export function compileContinuousFocusPaletteWithSourceMap(
  plan: ContinuousFocusPalettePlan,
  generatedPath = `generated:${plan.id}.txt`,
): FocusCompiledSource {
  const source = compileContinuousFocusPalette(plan);
  const document = parseClausewitz(Buffer.from(source, 'utf8'), generatedPath);
  const palette = assignments(document.root, 'continuous_focus_palette').find(
    (assignment) =>
      assignment.value.type === 'block' && firstScalar(assignment.value, 'id')?.value === plan.id,
  );
  const planById = new Map(plan.focuses.map((focus) => [focus.id, focus]));
  const mappings =
    palette?.value.type === 'block'
      ? assignments(palette.value, 'focus').flatMap((assignment) => {
          if (assignment.value.type !== 'block') return [];
          const focusId = firstScalar(assignment.value, 'id')?.value;
          if (focusId === undefined) return [];
          const planFocus = planById.get(focusId);
          return [
            {
              focusId,
              generatedLocation: nodeLocation(document, assignment, focusId),
              ...(planFocus?.sourceLocation === undefined
                ? {}
                : { planNodeLocation: planFocus.sourceLocation }),
            },
          ];
        })
      : [];
  return {
    source,
    sourceMap: {
      schemaVersion: 1,
      treeId: plan.id,
      generatedPath,
      generatedSha256: sha256Bytes(source),
      mappings,
    },
  };
}
