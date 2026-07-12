import { hashCanonical } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import {
  applyReplacements,
  assignments,
  firstScalar,
  parseClausewitz,
  replacementFor,
  type AssignmentNode,
  type BlockNode,
  type SourceDocument,
  type SourceReplacement,
} from '../core/source/index.js';
import {
  compileContinuousFocusBlock,
  compileContinuousFocusPalette,
  compileFocusBlock,
  compileFocusTree,
  focusCostText,
  focusTriggerBlockText,
} from './compiler.js';
import {
  layoutNodeMap,
  type ContinuousFocusPalettePlan,
  type FocusLayoutResult,
  type FocusNodePlan,
  type FocusTreePlan,
} from './model.js';

function treeAssignment(document: SourceDocument, treeId: string): AssignmentNode | undefined {
  return assignments(document.root, 'focus_tree').find(({ value }) =>
    value.type === 'block' ? firstScalar(value, 'id')?.value === treeId : false,
  );
}

function focusAssignments(tree: BlockNode): Map<string, AssignmentNode> {
  return new Map(
    assignments(tree, 'focus').flatMap((assignment) => {
      if (assignment.value.type !== 'block') return [];
      const id = firstScalar(assignment.value, 'id')?.value;
      return id === undefined ? [] : [[id, assignment] as const];
    }),
  );
}

function rawProjection(entries: FocusNodePlan['rawPassthrough']): unknown {
  return entries.map(({ kind, key, order, text }) => ({ kind, key: key ?? null, order, text }));
}

function rawBlockProjection(block: FocusNodePlan['availability']): unknown {
  return block === undefined
    ? null
    : { text: block.text, referencedFocusIds: [...block.referencedFocusIds].sort() };
}

function focusFieldProjections(focus: FocusNodePlan): Record<string, unknown> {
  return {
    icon: focus.icons.map((icon) => ({
      kind: icon.kind,
      sprite: icon.sprite,
      trigger: icon.kind === 'dynamic' ? rawBlockProjection(icon.trigger) : null,
    })),
    prerequisite: focus.prerequisites.groups.map((group) => ({
      operator: group.operator,
      focusIds: group.focusIds,
      rawPassthrough: rawProjection(group.rawPassthrough),
    })),
    mutually_exclusive: focus.mutuallyExclusive,
    available: rawBlockProjection(
      focusTriggerBlockText(focus, 'available') === undefined
        ? undefined
        : { text: focusTriggerBlockText(focus, 'available')!, referencedFocusIds: [] },
    ),
    bypass: rawBlockProjection(focus.bypass),
    allow_branch: rawBlockProjection(
      focusTriggerBlockText(focus, 'allow_branch') === undefined
        ? undefined
        : { text: focusTriggerBlockText(focus, 'allow_branch')!, referencedFocusIds: [] },
    ),
    search_filters: focus.filters,
    ai_will_do: rawBlockProjection(focus.ai.raw),
    completion_reward: rawBlockProjection(focus.completionReward),
  };
}

function treeFieldProjections(plan: FocusTreePlan): Record<string, unknown> {
  return {
    id: plan.id,
    country:
      plan.countryAssignment === undefined
        ? null
        : { raw: rawBlockProjection(plan.countryAssignment.raw) },
    default: plan.default,
    shared_focus: plan.sharedFocusIds,
    continuous_focus_position: plan.continuousFocusPosition ?? null,
    initial_show_position: rawBlockProjection(plan.initialShowPosition),
  };
}

function targetedAssignmentReplacements(
  document: SourceDocument,
  sourceBlock: BlockNode,
  compiledDocument: SourceDocument,
  compiledBlock: BlockNode,
  changedKeys: readonly string[],
  insertionIndent: string,
  description: string,
): SourceReplacement[] {
  if (sourceBlock.close === undefined)
    throw new ServiceError('FOCUS_SOURCE_BLOCK_UNCLOSED', `Cannot patch unclosed ${description}`);
  const replacements: SourceReplacement[] = [];
  const insertions: string[] = [];
  for (const key of changedKeys) {
    const current = assignments(sourceBlock, key);
    const target = assignments(compiledBlock, key);
    const paired = Math.min(current.length, target.length);
    for (let index = 0; index < paired; index += 1) {
      const source = current[index]!;
      const desired = target[index]!;
      const sourceText = document.text.slice(source.start, source.end);
      if (sourceText.includes('#')) {
        throw new ServiceError(
          'FOCUS_UNSAFE_COMMENTED_REWRITE',
          `Refusing to rewrite commented ${key} in ${description}`,
          { key },
        );
      }
      replacements.push({
        start: source.start,
        end: source.end,
        text: compiledDocument.text.slice(desired.start, desired.end),
        description: `Update ${key} in ${description}`,
      });
    }
    for (const source of current.slice(paired)) {
      const sourceText = document.text.slice(source.start, source.end);
      if (sourceText.includes('#')) {
        throw new ServiceError(
          'FOCUS_UNSAFE_COMMENTED_REWRITE',
          `Refusing to remove commented ${key} in ${description}`,
          { key },
        );
      }
      replacements.push({
        start: source.start,
        end: source.end,
        text: '',
        description: `Remove ${key} from ${description}`,
      });
    }
    for (const desired of target.slice(paired)) {
      insertions.push(compiledDocument.text.slice(desired.start, desired.end));
    }
  }
  if (insertions.length > 0) {
    replacements.push({
      start: sourceBlock.close.start,
      end: sourceBlock.close.start,
      text: `${document.newline}${insertions
        .map((entry) => `${insertionIndent}${entry.replaceAll('\n', document.newline)}`)
        .join(document.newline)}${document.newline}${insertionIndent.slice(0, -1)}`,
      description: `Add fields to ${description}`,
    });
  }
  return replacements;
}

function scalarValues(
  focus: FocusNodePlan,
  layout: FocusLayoutResult,
): Record<string, string | undefined> {
  let x: number;
  let y: number;
  let relative: string | undefined;
  if (focus.position.mode === 'auto') {
    const placed = layoutNodeMap(layout).get(focus.id);
    if (placed === undefined) {
      throw new ServiceError(
        'FOCUS_LAYOUT_REQUIRED',
        `Automatic focus ${focus.id} has no layout position`,
      );
    }
    x = placed.x;
    y = placed.y;
  } else {
    x = focus.position.x;
    y = focus.position.y;
    relative = focus.position.mode === 'relative' ? focus.position.relativeTo : undefined;
  }
  return {
    id: focus.id,
    x: String(x),
    y: String(y),
    relative_position_id: relative,
    cost: focus.cost === undefined ? undefined : focusCostText(focus.cost),
  };
}

function scalarReplacements(
  document: SourceDocument,
  assignment: AssignmentNode,
  currentFocus: FocusNodePlan,
  focus: FocusNodePlan,
  layout: FocusLayoutResult,
): SourceReplacement[] | undefined {
  if (assignment.value.type !== 'block' || assignment.value.close === undefined) return undefined;
  const replacements: SourceReplacement[] = [];
  const insertions: string[] = [];
  for (const [key, desired] of Object.entries(scalarValues(focus, layout))) {
    // Preserve the exact source lexeme for unchanged typed costs (for example
    // `5.000`) and never delete an existing unmodelled cost merely because
    // both imported and target plans omit it.
    if (key === 'cost' && currentFocus.cost === focus.cost) continue;
    const existing = assignments(assignment.value, key);
    if (existing.length > 1 || existing[0]?.value.type === 'block') return undefined;
    const current = existing[0];
    if (current === undefined) {
      if (desired !== undefined) insertions.push(`${key} = ${desired}`);
      continue;
    }
    if (desired === undefined) {
      replacements.push(replacementFor(current, '', `Remove ${key} from focus ${focus.id}`));
    } else if (current.value.type === 'scalar' && current.value.value !== desired) {
      replacements.push(
        replacementFor(current.value, desired, `Update ${key} for focus ${focus.id}`),
      );
    }
  }
  if (insertions.length > 0) {
    replacements.push({
      start: assignment.value.close.start,
      end: assignment.value.close.start,
      text: `${document.newline}${insertions.map((entry) => `\t\t${entry}`).join(document.newline)}${document.newline}\t`,
      description: `Add scalar fields to focus ${focus.id}`,
    });
  }
  return replacements;
}

export function updateFocusTreeSource(
  document: SourceDocument,
  currentPlan: FocusTreePlan | undefined,
  targetPlan: FocusTreePlan,
  layout: FocusLayoutResult,
): Buffer {
  const existingTree =
    treeAssignment(document, targetPlan.id) ??
    (currentPlan === undefined ? undefined : treeAssignment(document, currentPlan.id));
  const compiledTree = compileFocusTree(targetPlan, layout).replaceAll('\n', document.newline);
  if (existingTree?.value.type !== 'block' || currentPlan === undefined) {
    const insertion = {
      start: document.text.length,
      end: document.text.length,
      text: `${document.text.endsWith('\n') || document.text.endsWith('\r') ? '' : document.newline}${compiledTree}${document.newline}`,
      description: `Add focus tree ${targetPlan.id}`,
    };
    return applyReplacements(document, [insertion]);
  }
  const replacements: SourceReplacement[] = [];
  if (
    hashCanonical(rawProjection(currentPlan.rawPassthrough)) !==
    hashCanonical(rawProjection(targetPlan.rawPassthrough))
  ) {
    throw new ServiceError(
      'FOCUS_UNSAFE_RAW_TREE_REWRITE',
      'Unknown or raw tree fields cannot be regenerated safely; patch their source ranges explicitly',
    );
  }
  const compiledTreeDocument = parseClausewitz(
    Buffer.from(compiledTree, 'utf8'),
    `compiled:${targetPlan.id}`,
  );
  const compiledTreeAssignment = treeAssignment(compiledTreeDocument, targetPlan.id);
  if (compiledTreeAssignment?.value.type !== 'block')
    throw new ServiceError(
      'FOCUS_COMPILE_INVALID',
      'Compiled focus tree cannot be reparsed safely',
    );
  const currentTreeFields = treeFieldProjections(currentPlan);
  const targetTreeFields = treeFieldProjections(targetPlan);
  const changedTreeKeys = Object.keys(targetTreeFields).filter(
    (key) => hashCanonical(currentTreeFields[key]) !== hashCanonical(targetTreeFields[key]),
  );
  replacements.push(
    ...targetedAssignmentReplacements(
      document,
      existingTree.value,
      compiledTreeDocument,
      compiledTreeAssignment.value,
      changedTreeKeys,
      '\t',
      `focus tree ${targetPlan.id}`,
    ),
  );
  const currentById = new Map(currentPlan.focuses.map((focus) => [focus.id, focus]));
  const targetById = new Map(targetPlan.focuses.map((focus) => [focus.id, focus]));
  const assignmentsById = focusAssignments(existingTree.value);
  for (const [id, sourceAssignment] of assignmentsById) {
    if (targetById.has(id)) continue;
    replacements.push(replacementFor(sourceAssignment, '', `Remove focus ${id}`));
  }
  const additions: string[] = [];
  for (const target of targetPlan.focuses) {
    const current = currentById.get(target.id);
    const sourceAssignment = assignmentsById.get(target.id);
    if (current === undefined || sourceAssignment === undefined) {
      additions.push(compileFocusBlock(target, layout).replaceAll('\n', document.newline));
      continue;
    }
    if (
      hashCanonical(rawProjection(current.rawPassthrough)) !==
      hashCanonical(rawProjection(target.rawPassthrough))
    ) {
      throw new ServiceError(
        'FOCUS_UNSAFE_RAW_FIELD_REWRITE',
        `Unknown or raw fields in focus ${target.id} cannot be regenerated safely`,
        { focusId: target.id },
      );
    }
    const currentFields = focusFieldProjections(current);
    const targetFields = focusFieldProjections(target);
    const changedKeys = Object.keys(targetFields).filter(
      (key) => hashCanonical(currentFields[key]) !== hashCanonical(targetFields[key]),
    );
    if (changedKeys.length > 0) {
      const compiledFocusDocument = parseClausewitz(
        Buffer.from(compileFocusBlock(target, layout), 'utf8'),
        `compiled:${target.id}`,
      );
      const compiledFocusAssignment = assignments(compiledFocusDocument.root, 'focus')[0];
      if (compiledFocusAssignment?.value.type !== 'block')
        throw new ServiceError(
          'FOCUS_COMPILE_INVALID',
          `Compiled focus ${target.id} cannot be reparsed safely`,
        );
      if (sourceAssignment.value.type !== 'block')
        throw new ServiceError(
          'FOCUS_SOURCE_BLOCK_INVALID',
          `Focus ${target.id} source is not a block`,
        );
      replacements.push(
        ...targetedAssignmentReplacements(
          document,
          sourceAssignment.value,
          compiledFocusDocument,
          compiledFocusAssignment.value,
          changedKeys,
          '\t\t',
          `focus ${target.id}`,
        ),
      );
    }
    const scalar = scalarReplacements(document, sourceAssignment, current, target, layout);
    if (scalar === undefined) {
      throw new ServiceError(
        'FOCUS_UNSAFE_SCALAR_REWRITE',
        `Focus ${target.id} scalar fields cannot be patched without replacing unknown source`,
        { focusId: target.id },
      );
    } else replacements.push(...scalar);
  }
  if (additions.length > 0) {
    const close = existingTree.value.close;
    if (close === undefined)
      throw new ServiceError('FOCUS_TREE_UNCLOSED', `Focus tree ${targetPlan.id} is unclosed`);
    replacements.push({
      start: close.start,
      end: close.start,
      text: `${document.newline}${additions.join(`${document.newline}${document.newline}`)}${document.newline}`,
      description: `Add focuses to ${targetPlan.id}`,
    });
  }
  return applyReplacements(document, replacements);
}

function continuousPaletteAssignment(
  document: SourceDocument,
  paletteId: string,
): AssignmentNode | undefined {
  return assignments(document.root, 'continuous_focus_palette').find(({ value }) =>
    value.type === 'block' ? firstScalar(value, 'id')?.value === paletteId : false,
  );
}

function continuousPaletteProjection(plan: ContinuousFocusPalettePlan): Record<string, unknown> {
  return {
    id: plan.id,
    country:
      plan.countryAssignment === undefined
        ? null
        : { raw: rawBlockProjection(plan.countryAssignment.raw) },
    default: plan.default,
    reset_on_civilwar: plan.resetOnCivilWar ?? null,
    position: plan.position ?? null,
  };
}

/** Targeted update for one real continuous_focus_palette block. */
export function updateContinuousFocusPaletteSource(
  document: SourceDocument,
  currentPlan: ContinuousFocusPalettePlan | undefined,
  targetPlan: ContinuousFocusPalettePlan,
): Buffer {
  const existingPalette =
    continuousPaletteAssignment(document, targetPlan.id) ??
    (currentPlan === undefined ? undefined : continuousPaletteAssignment(document, currentPlan.id));
  const compiledPalette = compileContinuousFocusPalette(targetPlan).replaceAll(
    '\n',
    document.newline,
  );
  if (existingPalette?.value.type !== 'block' || currentPlan === undefined) {
    return applyReplacements(document, [
      {
        start: document.text.length,
        end: document.text.length,
        text: `${document.text.endsWith('\n') || document.text.endsWith('\r') ? '' : document.newline}${compiledPalette}${document.newline}`,
        description: `Add continuous focus palette ${targetPlan.id}`,
      },
    ]);
  }
  if (
    hashCanonical(rawProjection(currentPlan.rawPassthrough)) !==
    hashCanonical(rawProjection(targetPlan.rawPassthrough))
  )
    throw new ServiceError(
      'FOCUS_UNSAFE_RAW_PALETTE_REWRITE',
      'Unknown or raw continuous-palette fields cannot be regenerated safely',
    );
  const compiledDocument = parseClausewitz(
    Buffer.from(compiledPalette, 'utf8'),
    `compiled:${targetPlan.id}`,
  );
  const compiledAssignment = continuousPaletteAssignment(compiledDocument, targetPlan.id);
  if (compiledAssignment?.value.type !== 'block')
    throw new ServiceError(
      'FOCUS_COMPILE_INVALID',
      `Compiled continuous focus palette ${targetPlan.id} cannot be reparsed safely`,
    );
  const replacements: SourceReplacement[] = [];
  const currentFields = continuousPaletteProjection(currentPlan);
  const targetFields = continuousPaletteProjection(targetPlan);
  const changedPaletteKeys = Object.keys(targetFields).filter(
    (key) => hashCanonical(currentFields[key]) !== hashCanonical(targetFields[key]),
  );
  replacements.push(
    ...targetedAssignmentReplacements(
      document,
      existingPalette.value,
      compiledDocument,
      compiledAssignment.value,
      changedPaletteKeys,
      '\t',
      `continuous focus palette ${targetPlan.id}`,
    ),
  );
  const currentById = new Map(currentPlan.focuses.map((focus) => [focus.id, focus]));
  const targetById = new Map(targetPlan.focuses.map((focus) => [focus.id, focus]));
  const sourceById = focusAssignments(existingPalette.value);
  for (const [id, sourceAssignment] of sourceById) {
    if (!targetById.has(id))
      replacements.push(replacementFor(sourceAssignment, '', `Remove continuous focus ${id}`));
  }
  const additions: string[] = [];
  for (const target of targetPlan.focuses) {
    const current = currentById.get(target.id);
    const sourceAssignment = sourceById.get(target.id);
    if (current === undefined || sourceAssignment?.value.type !== 'block') {
      additions.push(compileContinuousFocusBlock(target).replaceAll('\n', document.newline));
      continue;
    }
    if (
      hashCanonical(rawProjection(current.rawPassthrough)) !==
      hashCanonical(rawProjection(target.rawPassthrough))
    )
      throw new ServiceError(
        'FOCUS_UNSAFE_RAW_FIELD_REWRITE',
        `Unknown or raw fields in continuous focus ${target.id} cannot be regenerated safely`,
        { focusId: target.id },
      );
    if (hashCanonical(current.icons) !== hashCanonical(target.icons)) {
      const compiledFocusDocument = parseClausewitz(
        Buffer.from(compileContinuousFocusBlock(target), 'utf8'),
        `compiled:${target.id}`,
      );
      const compiledFocusAssignment = assignments(compiledFocusDocument.root, 'focus')[0];
      if (compiledFocusAssignment?.value.type !== 'block')
        throw new ServiceError(
          'FOCUS_COMPILE_INVALID',
          `Compiled continuous focus ${target.id} cannot be reparsed safely`,
        );
      replacements.push(
        ...targetedAssignmentReplacements(
          document,
          sourceAssignment.value,
          compiledFocusDocument,
          compiledFocusAssignment.value,
          ['icon'],
          '\t\t',
          `continuous focus ${target.id}`,
        ),
      );
    }
  }
  if (additions.length > 0) {
    const close = existingPalette.value.close;
    if (close === undefined)
      throw new ServiceError(
        'FOCUS_PALETTE_UNCLOSED',
        `Continuous focus palette ${targetPlan.id} is unclosed`,
      );
    replacements.push({
      start: close.start,
      end: close.start,
      text: `${document.newline}${additions.join(`${document.newline}${document.newline}`)}${document.newline}`,
      description: `Add continuous focuses to ${targetPlan.id}`,
    });
  }
  return applyReplacements(document, replacements);
}
