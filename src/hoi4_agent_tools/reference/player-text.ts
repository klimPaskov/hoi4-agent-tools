import { locationFor, type AssignmentNode, type BlockNode } from '../core/source/index.js';
import type { SourceLineIndex } from '../core/source/lexer.js';

/** One localisation entry as the game resolves it: the last loaded definition of the key. */
export interface LocalisedText {
  value: string;
  path: string;
  line: number;
}

/** Player-facing text of a mod file, with the localisation and scripted localisation it reads. */
export interface PlayerTextContext {
  localisation: ReadonlyMap<string, LocalisedText>;
  /** `defined_text` names mapped to the localisation keys of their branches. */
  scriptedLocalisation: ReadonlyMap<string, readonly string[]>;
}

export interface PlayerTextFinding {
  code: string;
  command: string;
  offset: number;
  end: number;
  message: string;
}

const flagTriggers = new Set(['has_country_flag', 'has_global_flag', 'has_state_flag']);
/** Blocks whose triggers the game lists in requirement tooltips. */
const tooltipTriggerBlocks: Readonly<Record<string, ReadonlySet<string>>> = {
  decisions: new Set(['available']),
  national_focus: new Set(['available', 'bypass']),
};
/** Words that describe the mod's development rather than the game world. */
const implementationWording =
  /\b(?:TODO|FIXME|TBD|hard-?coded|newly added|(?:has been|was|been) reworked|placeholder)\b/iu;
const colourCode = /[§£]/u;

function blockOf(entry: AssignmentNode): BlockNode | undefined {
  return entry.value.type === 'block' ? entry.value : undefined;
}

function scalarOf(entry: AssignmentNode): string | undefined {
  return entry.value.type === 'block' ? undefined : entry.value.value;
}

function assignmentsOf(block: BlockNode): AssignmentNode[] {
  return block.entries.filter((entry): entry is AssignmentNode => entry.type === 'assignment');
}

/** Localisation keys an event, decision or focus text field names: `key` or `{ text = key }`. */
function textKeys(entry: AssignmentNode): Array<{ key: string; node: AssignmentNode }> {
  const scalar = scalarOf(entry);
  if (scalar !== undefined) return [{ key: scalar, node: entry }];
  return assignmentsOf(blockOf(entry)!)
    .filter((child) => child.key.value === 'text' && scalarOf(child) !== undefined)
    .map((child) => ({ key: scalarOf(child)!, node: child }));
}

/** Scripted localisation names a text calls, such as `GetStatus` in `[ROOT.GetStatus]`. */
function scriptedTokens(value: string, context: PlayerTextContext): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(/\[(?!\?)([A-Za-z0-9_.:]+)\]/gu)) {
    const name = match[1]!.slice(match[1]!.lastIndexOf('.') + 1);
    if (context.scriptedLocalisation.has(name)) names.push(name);
  }
  return names;
}

/**
 * Player-facing text problems in an event, decision or focus file. News and report events
 * carry no colour codes, directly or through scripted localisation; shown text has no
 * development wording; and a flag trigger listed in a requirement tooltip has a localisation
 * key, because the game prints the flag name as that tooltip's key.
 */
export function playerTextFindings(
  family: string,
  document: { root: BlockNode },
  context: PlayerTextContext,
): PlayerTextFinding[] {
  const findings: PlayerTextFinding[] = [];
  const top = assignmentsOf(document.root);
  const add = (node: AssignmentNode, code: string, message: string) =>
    findings.push({
      code,
      command: node.key.value,
      offset: node.start,
      end: node.end,
      message: message.slice(0, 500),
    });
  const where = (text: LocalisedText) => `${text.path}:${text.line}`;
  const checkText = (key: string, node: AssignmentNode, options: { colourFree: boolean }): void => {
    const text = context.localisation.get(key);
    if (text === undefined) return;
    if (implementationWording.test(text.value))
      add(
        node,
        'SCRIPT_TEXT_IMPLEMENTATION_WORDING',
        `${key} (${where(text)}) describes development rather than the game: "${implementationWording.exec(text.value)![0]}"`,
      );
    if (!options.colourFree) return;
    if (colourCode.test(text.value)) {
      add(
        node,
        'SCRIPT_NEWS_TEXT_COLOUR_CODE',
        `${key} (${where(text)}) uses a colour code in news or report event text`,
      );
      return;
    }
    for (const name of scriptedTokens(text.value, context))
      for (const branchKey of context.scriptedLocalisation.get(name) ?? []) {
        const branch = context.localisation.get(branchKey);
        if (branch !== undefined && colourCode.test(branch.value)) {
          add(
            node,
            'SCRIPT_NEWS_TEXT_COLOUR_CODE',
            `${key} (${where(text)}) shows [${name}], whose branch ${branchKey} (${where(branch)}) uses a colour code in news or report event text`,
          );
          return;
        }
      }
  };

  if (family === 'events') {
    for (const event of top) {
      const body = blockOf(event);
      if (body === undefined || !event.key.value.endsWith('_event')) continue;
      const fields = assignmentsOf(body);
      const picture = fields.find(({ key }) => key.value === 'picture');
      const colourFree =
        event.key.value === 'news_event' ||
        /^GFX_report_event/iu.test((picture && scalarOf(picture)) ?? '');
      for (const field of fields) {
        if (field.key.value === 'title' || field.key.value === 'desc')
          for (const { key, node } of textKeys(field)) checkText(key, node, { colourFree });
        else if (field.key.value === 'option')
          for (const name of assignmentsOf(blockOf(field) ?? { ...body, entries: [] }))
            if (name.key.value === 'name' && scalarOf(name) !== undefined)
              checkText(scalarOf(name)!, name, { colourFree });
      }
    }
    return findings;
  }

  const requirementBlocks = tooltipTriggerBlocks[family];
  if (requirementBlocks === undefined) return findings;
  const visitTrigger = (block: BlockNode): void => {
    for (const entry of assignmentsOf(block)) {
      const key = entry.key.value;
      // These blocks hide their contents or replace them with their own tooltip.
      if (key === 'hidden_trigger' || key === 'custom_trigger_tooltip') continue;
      if (flagTriggers.has(key)) {
        const flag =
          scalarOf(entry) ??
          assignmentsOf(blockOf(entry)!)
            .filter(({ key: child }) => child.value === 'flag')
            .map(scalarOf)[0];
        if (flag !== undefined && /^[A-Za-z0-9_]+$/u.test(flag) && !context.localisation.has(flag))
          add(
            entry,
            'SCRIPT_FLAG_TOOLTIP_UNLOCALISED',
            `${flag} has no localisation key, so the requirement tooltip shows the raw flag name; localise it or wrap the check in hidden_trigger with a custom_trigger_tooltip`,
          );
        continue;
      }
      const child = blockOf(entry);
      if (child !== undefined) visitTrigger(child);
    }
  };
  const visitDefinition = (definition: AssignmentNode, id: string | undefined): void => {
    const body = blockOf(definition);
    if (body === undefined) return;
    if (id !== undefined) {
      checkText(id, definition, { colourFree: false });
      checkText(`${id}_desc`, definition, { colourFree: false });
    }
    for (const field of assignmentsOf(body)) {
      const block = blockOf(field);
      if (block !== undefined && requirementBlocks.has(field.key.value)) visitTrigger(block);
    }
  };
  if (family === 'decisions') {
    for (const category of top)
      for (const decision of assignmentsOf(blockOf(category) ?? { ...document.root, entries: [] }))
        visitDefinition(decision, decision.key.value);
  } else {
    for (const entry of top) {
      const focuses =
        entry.key.value === 'shared_focus'
          ? [entry]
          : entry.key.value === 'focus_tree'
            ? assignmentsOf(blockOf(entry) ?? { ...document.root, entries: [] }).filter(
                ({ key }) => key.value === 'focus',
              )
            : [];
      for (const focus of focuses) {
        const id = assignmentsOf(blockOf(focus) ?? { ...document.root, entries: [] }).find(
          ({ key }) => key.value === 'id',
        );
        visitDefinition(focus, id === undefined ? undefined : scalarOf(id));
      }
    }
  }
  return findings;
}

/** Line and column of a finding in the checked file. */
export function playerTextPosition(
  path: string,
  lineIndex: SourceLineIndex,
  finding: PlayerTextFinding,
): { line: number; column: number } {
  return locationFor(path, lineIndex, finding.offset, finding.end).start;
}
