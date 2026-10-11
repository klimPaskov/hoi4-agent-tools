import type { z } from 'zod/v4';
import { decisionInspectRequestSchema, impactInspectRequestSchema } from '../schemas/analysis.js';
import { eventInspectRequestSchema, eventRenderRequestSchema } from '../schemas/event.js';
import {
  focusInspectRequestSchema,
  focusRenderRequestSchema,
  focusRewriteRequestSchema,
} from '../schemas/focus-requests.js';
import {
  guiInspectRequestSchema,
  guiRenderRequestSchema,
  guiRewriteRequestSchema,
} from '../schemas/gui-requests.js';
import { mapInspectRequestSchema, mapRewriteRequestSchema } from '../schemas/map-requests.js';
import {
  probabilityAnalyzeRequestSchema,
  probabilityInspectRequestSchema,
} from '../schemas/probability-requests.js';
import {
  mechanicTestRequestSchema,
  packageCheckRequestSchema,
  scenarioTestRequestSchema,
} from '../schemas/scenarios.js';
import {
  technologyInspectRequestSchema,
  technologyRenderRequestSchema,
} from '../schemas/technology.js';

/**
 * The single list of domain tools that run as durable jobs. Task routing, worker admission,
 * request lifecycles and job validation all read this list, so adding, merging or removing a
 * domain tool happens in one place.
 */
export const DOMAIN_TOOL_NAMES = [
  'hoi4.impact_inspect',
  'hoi4.decision_inspect',
  'hoi4.mechanic_test',
  'hoi4.package_check',
  'hoi4.scenario_test',
  'hoi4.event_inspect',
  'hoi4.event_render',
  'hoi4.tech_inspect',
  'hoi4.tech_render',
  'hoi4.probability_inspect',
  'hoi4.probability_analyze',
  'hoi4.map_inspect',
  'hoi4.map_rewrite',
  'hoi4.gui_inspect',
  'hoi4.gui_render',
  'hoi4.gui_rewrite',
  'hoi4.focus_inspect',
  'hoi4.focus_render',
  'hoi4.focus_rewrite',
] as const;

export type DomainToolName = (typeof DOMAIN_TOOL_NAMES)[number];

export const DOMAIN_TOOL_ARGUMENT_SCHEMAS: Record<
  DomainToolName,
  z.ZodType<Record<string, unknown>>
> = {
  'hoi4.impact_inspect': impactInspectRequestSchema,
  'hoi4.decision_inspect': decisionInspectRequestSchema,
  'hoi4.mechanic_test': mechanicTestRequestSchema,
  'hoi4.package_check': packageCheckRequestSchema,
  'hoi4.scenario_test': scenarioTestRequestSchema,
  'hoi4.event_inspect': eventInspectRequestSchema,
  'hoi4.event_render': eventRenderRequestSchema,
  'hoi4.tech_inspect': technologyInspectRequestSchema,
  'hoi4.tech_render': technologyRenderRequestSchema,
  'hoi4.probability_inspect': probabilityInspectRequestSchema,
  'hoi4.probability_analyze': probabilityAnalyzeRequestSchema,
  'hoi4.map_inspect': mapInspectRequestSchema,
  'hoi4.map_rewrite': mapRewriteRequestSchema,
  'hoi4.gui_inspect': guiInspectRequestSchema,
  'hoi4.gui_render': guiRenderRequestSchema,
  'hoi4.gui_rewrite': guiRewriteRequestSchema,
  'hoi4.focus_inspect': focusInspectRequestSchema,
  'hoi4.focus_render': focusRenderRequestSchema,
  'hoi4.focus_rewrite': focusRewriteRequestSchema,
};

const domainToolNames: ReadonlySet<string> = new Set(DOMAIN_TOOL_NAMES);

export function isDomainToolName(name: string): name is DomainToolName {
  return domainToolNames.has(name);
}

/** Domain tools that change mod source. */
export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'hoi4.gui_rewrite',
  'hoi4.map_rewrite',
  'hoi4.focus_rewrite',
]);
