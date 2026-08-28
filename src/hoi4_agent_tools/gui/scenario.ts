import { z } from 'zod';
import { renderDimensionViolation, RENDER_MAX_DIMENSION } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import type { GuiGeneratedScenarioOptions, GuiPreviewScenario } from './types.js';
import {
  GUI_SCENARIO_MAX_KEYS,
  GUI_SCENARIO_MAX_LIST_KEYS,
  GUI_SCENARIO_MAX_ROWS,
  GUI_SCENARIO_MAX_STRING_CHARACTERS,
} from './limits.js';

const scalarSchema = z.union([z.string().max(16_384), z.number(), z.boolean()]);
const objectSchema = z.record(z.string(), scalarSchema);
const elementNameSchema = z.string().min(1).max(256);
const previewStateSchema = z.enum([
  'normal',
  'hover',
  'selected',
  'locked',
  'disabled',
  'warning',
  'active',
  'completed',
  'empty-list',
  'full-list',
  'minimum-value',
  'maximum-value',
  'long-text',
  'missing-localisation',
]);

function assertGuiScenarioInputBudget(input: unknown): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return;
  const lists = (input as { lists?: unknown }).lists;
  if (lists !== null && typeof lists === 'object' && !Array.isArray(lists)) {
    const entries = Object.entries(lists);
    if (entries.length > GUI_SCENARIO_MAX_LIST_KEYS) {
      throw new ServiceError(
        'GUI_SCENARIO_LIST_KEYS_BLOCKED',
        'GUI preview scenario exceeds the fixed list-key ceiling',
        { listKeys: entries.length, maximumListKeys: GUI_SCENARIO_MAX_LIST_KEYS },
      );
    }
    let rows = 0;
    for (const [, value] of entries) {
      if (!Array.isArray(value)) continue;
      if (value.length > GUI_SCENARIO_MAX_ROWS - rows) {
        throw new ServiceError(
          'GUI_SCENARIO_ROWS_BLOCKED',
          'GUI preview scenario exceeds the fixed aggregate row ceiling',
          { rows: rows + value.length, maximumRows: GUI_SCENARIO_MAX_ROWS },
        );
      }
      rows += value.length;
    }
  }
  const seen = new Set<object>();
  const pending: unknown[] = [input];
  let keys = 0;
  let stringCharacters = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (value.length > GUI_SCENARIO_MAX_STRING_CHARACTERS - stringCharacters) {
        throw new ServiceError(
          'GUI_SCENARIO_STRINGS_BLOCKED',
          'GUI preview scenario exceeds the fixed aggregate string ceiling',
          {
            stringCharacters: stringCharacters + value.length,
            maximumStringCharacters: GUI_SCENARIO_MAX_STRING_CHARACTERS,
          },
        );
      }
      stringCharacters += value.length;
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    if (seen.has(value)) {
      throw new ServiceError(
        'GUI_SCENARIO_GRAPH_BLOCKED',
        'GUI preview scenario contains a repeated or cyclic object',
      );
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push(value[index]);
      continue;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (keys >= GUI_SCENARIO_MAX_KEYS) {
        throw new ServiceError(
          'GUI_SCENARIO_KEYS_BLOCKED',
          'GUI preview scenario exceeds the fixed aggregate key ceiling',
          { keys: keys + 1, maximumKeys: GUI_SCENARIO_MAX_KEYS },
        );
      }
      keys += 1;
      if (key.length > GUI_SCENARIO_MAX_STRING_CHARACTERS - stringCharacters) {
        throw new ServiceError(
          'GUI_SCENARIO_STRINGS_BLOCKED',
          'GUI preview scenario exceeds the fixed aggregate string ceiling',
          {
            stringCharacters: stringCharacters + key.length,
            maximumStringCharacters: GUI_SCENARIO_MAX_STRING_CHARACTERS,
          },
        );
      }
      stringCharacters += key.length;
      pending.push(nested);
    }
  }
}

export const GuiPreviewResolutionSchema = z
  .object({
    width: z.number().int().min(320).max(RENDER_MAX_DIMENSION),
    height: z.number().int().min(200).max(RENDER_MAX_DIMENSION),
  })
  .strict()
  .superRefine(({ width, height }, context) => {
    const violation = renderDimensionViolation(width, height, 'GUI preview resolution');
    if (violation !== undefined) {
      context.addIssue({ code: 'custom', message: `${violation.code}: ${violation.message}` });
    }
  });

const GuiPreviewScenarioBodySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    description: z.string().max(500).optional(),
    resolution: GuiPreviewResolutionSchema.default({ width: 1920, height: 1080 }),
    uiScale: z.number().positive().min(0.25).max(4).default(1),
    state: previewStateSchema.default('normal'),
    language: z
      .string()
      .regex(/^l_[a-z_]+$/u)
      .default('l_english'),
    animationTimeSeconds: z.number().min(0).max(86_400).default(0),
    visibleTimeSeconds: z.number().min(0).max(86_400).optional(),
    country: objectSchema.optional(),
    stateValues: objectSchema.optional(),
    variables: z.record(z.string(), z.number()).default({}),
    flags: z.record(z.string(), z.boolean()).default({}),
    lists: z.record(z.string(), z.array(objectSchema).max(10_000)).default({}),
    localisation: z.record(z.string(), z.string()).default({}),
    values: objectSchema.default({}),
    scriptedGui: objectSchema.default({}),
    visibility: z.record(z.string(), z.boolean()).default({}),
    elementStates: z.record(z.string(), previewStateSchema).default({}),
    selectedFrames: z.record(z.string(), z.number().int().min(0)).default({}),
    scrollOffsets: z.record(z.string(), z.number().min(0)).default({}),
    guiCosts: z.record(z.string(), z.number()).default({}),
    scriptCosts: z.record(z.string(), z.number()).default({}),
    expectations: z
      .object({
        visible: z.array(elementNameSchema).max(10_000).default([]),
        hidden: z.array(elementNameSchema).max(10_000).default([]),
        containedBy: z.record(elementNameSchema, elementNameSchema).default({}),
        centeredOn: z.record(elementNameSchema, elementNameSchema).default({}),
      })
      .strict()
      .default({ visible: [], hidden: [], containedBy: {}, centeredOn: {} }),
  })
  .strict()
  .superRefine((scenario, context) => {
    const listEntries = Object.entries(scenario.lists);
    if (listEntries.length > GUI_SCENARIO_MAX_LIST_KEYS) {
      context.addIssue({
        code: 'custom',
        path: ['lists'],
        message: `GUI_SCENARIO_LIST_KEYS_BLOCKED: scenario lists exceed ${GUI_SCENARIO_MAX_LIST_KEYS} keys`,
      });
    }
    const rowCount = listEntries.reduce((total, [, rows]) => total + rows.length, 0);
    if (rowCount > GUI_SCENARIO_MAX_ROWS) {
      context.addIssue({
        code: 'custom',
        path: ['lists'],
        message: `GUI_SCENARIO_ROWS_BLOCKED: scenario lists exceed ${GUI_SCENARIO_MAX_ROWS} aggregate rows`,
      });
    }
    let keyCount = 0;
    let stringCharacters = 0;
    const pending: unknown[] = [scenario];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value === 'string') {
        stringCharacters += value.length;
        continue;
      }
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1)
          pending.push(value[index] as unknown);
        continue;
      }
      if (value === null || typeof value !== 'object') continue;
      for (const [key, nested] of Object.entries(value)) {
        keyCount += 1;
        stringCharacters += key.length;
        pending.push(nested);
      }
    }
    if (keyCount > GUI_SCENARIO_MAX_KEYS) {
      context.addIssue({
        code: 'custom',
        message: `GUI_SCENARIO_KEYS_BLOCKED: scenario exceeds ${GUI_SCENARIO_MAX_KEYS} aggregate keys`,
      });
    }
    if (stringCharacters > GUI_SCENARIO_MAX_STRING_CHARACTERS) {
      context.addIssue({
        code: 'custom',
        message: `GUI_SCENARIO_STRINGS_BLOCKED: scenario exceeds ${GUI_SCENARIO_MAX_STRING_CHARACTERS} aggregate string characters`,
      });
    }
  });

export const GuiPreviewScenarioSchema = z.preprocess((input) => {
  assertGuiScenarioInputBudget(input);
  return input;
}, GuiPreviewScenarioBodySchema);

export const GuiGeneratedScenarioOptionsSchema = z
  .object({
    enabled: z.boolean().default(true),
    count: z.number().int().min(1).max(16).default(1),
    seed: z.string().min(1).max(256).default('auto'),
    idPrefix: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
      .default('generated'),
    preservePlaceholder: z.boolean().default(false),
    numericMinimum: z.number().min(-1_000_000_000).max(1_000_000_000).default(0),
    numericMaximum: z.number().min(-1_000_000_000).max(1_000_000_000).default(100),
    integerValues: z.boolean().default(true),
    listRowsMinimum: z.number().int().min(0).max(100).default(1),
    listRowsMaximum: z.number().int().min(0).max(100).default(5),
    trueProbability: z.number().min(0).max(1).default(0.7),
    visibility: z.enum(['show-all', 'varied']).default('varied'),
    elementStates: z.enum(['normal', 'varied']).default('normal'),
    textSamples: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(64)
      .default(['Operational', 'Ready', 'Stable', 'Available', 'In Progress']),
  })
  .strict()
  .superRefine((options, context) => {
    if (options.numericMaximum < options.numericMinimum)
      context.addIssue({
        code: 'custom',
        path: ['numericMaximum'],
        message: 'numericMaximum must be greater than or equal to numericMinimum',
      });
    if (options.listRowsMaximum < options.listRowsMinimum)
      context.addIssue({
        code: 'custom',
        path: ['listRowsMaximum'],
        message: 'listRowsMaximum must be greater than or equal to listRowsMinimum',
      });
  });

export type GuiPreviewScenarioInput = z.input<typeof GuiPreviewScenarioSchema>;
export type GuiGeneratedScenarioOptionsInput = z.input<typeof GuiGeneratedScenarioOptionsSchema>;

export function parsePreviewScenario(input: unknown): GuiPreviewScenario {
  return GuiPreviewScenarioSchema.parse(input) as GuiPreviewScenario;
}

export function defaultPreviewScenario(id = 'default'): GuiPreviewScenario {
  return parsePreviewScenario({ id });
}

export function parseGeneratedScenarioOptions(input: unknown): GuiGeneratedScenarioOptions {
  return GuiGeneratedScenarioOptionsSchema.parse(input);
}
