import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import { hashCanonical } from '../core/canonical.js';
import { parseClausewitz } from '../core/source/index.js';
import {
  requireOperationScope,
  resolveOperationWorkspaceForSource,
  type OperationContext,
} from '../core/operation-context.js';
import { emptyServiceResult, ServiceError } from '../core/result.js';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { globFiles } from '../core/file-glob.js';
import { checkedLayerName, runEngineCheck } from '../core/engine-check.js';
import { toolResult } from '../core/operation-result.js';
import {
  referenceContextRequestSchema,
  referenceReadRequestSchema,
  referenceSearchRequestSchema,
  sourceLookupRequestSchema,
} from '../schemas/reference.js';
import { ReferenceService } from './service.js';
import { sourceLookup } from './source-lookup.js';
import {
  scriptValidateDataSchema,
  scriptValidateRequestSchema,
} from '../schemas/script-validation.js';
import {
  identifierArgumentCommands,
  validateScript,
  type IdentifierContext,
  type IdentifierKind,
} from './script-validation.js';
import { categoryHints, errorLogPattern, modChangedAfter, readErrorLog } from './error-log.js';
import { errorExplanations, explainErrors } from './error-explain.js';
import { documentedNames } from './documented-commands.js';
import {
  explainErrorRequestSchema,
  modHealthDataSchema,
  modHealthRequestSchema,
  scriptGuardDataSchema,
  scriptGuardRequestSchema,
} from '../schemas/modder-tools.js';
import { guardedFiles, inventedNames, type InventedName } from './script-guard.js';
import { rankProblems, type CheckRun, type HealthCheck, type HealthFinding } from './mod-health.js';
import { modIndex } from './mod-index.js';
import { listSkills, loadSkill } from './skills.js';
import { skillDataSchema, skillRequestSchema } from '../schemas/skill.js';
import { inspectLocalisation } from '../localisation/inspect.js';
import { checkModCompatibility } from './compat.js';
import { checkPatchCompatibility } from './compat-patch.js';
import {
  compatCheckDataSchema,
  compatCheckRequestSchema,
  type CompatCheckData,
  type CompatCheckRequest,
} from '../schemas/compat.js';
import { inspectIdeas } from '../ideas/inspect.js';
import { ideaInspectDataSchema, ideaInspectRequestSchema } from '../schemas/ideas.js';
import { inspectAssets, inspectSystem, inspectUnits } from '../system/inspect.js';
import {
  assetInspectDataSchema,
  assetInspectRequestSchema,
  systemInspectDataSchema,
  systemInspectRequestSchema,
  unitInspectDataSchema,
  unitInspectRequestSchema,
} from '../schemas/system.js';
import {
  localisationInspectDataSchema,
  localisationInspectRequestSchema,
} from '../schemas/localisation.js';
import {
  errorLogDataSchema,
  errorLogRequestSchema,
  modIndexDataSchema,
  modIndexRequestSchema,
} from '../schemas/mod-tools.js';
import type { LocalisedText, PlayerTextContext } from './player-text.js';
import { eventPopupDefinitions, type EventPopupDefinition } from './event-popups.js';
import { locatePatterns, selectFile } from './source-locate.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import type { z } from 'zod/v4';

/**
 * Database folders whose entry names are trigger keys: `<folder> = { <name> = { ... } }` in
 * each file, checked as the documented generic trigger.
 */
const implicitTriggerSources: Readonly<Record<string, string>> = {
  buildings: 'building_count_trigger',
  ideologies: 'ideology_support_trigger',
  resources: 'resource_count_trigger',
};

/** Building, ideology and resource names from every scanned source layer. */
function implicitTriggerNames(snapshot: ScanSnapshot): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of snapshot.index.files.values()) {
    const folder = /^common\/([a-z_]+)\/[^/]+\.txt$/u.exec(file.relativePath)?.[1];
    const heading = folder === undefined ? undefined : implicitTriggerSources[folder];
    if (heading === undefined) continue;
    for (const top of parseClausewitz(file.bytes, file.displayPath).root.entries) {
      if (top.type !== 'assignment' || top.key.value !== folder || top.value.type !== 'block')
        continue;
      for (const entry of top.value.entries)
        if (entry.type === 'assignment' && entry.value.type === 'block')
          names.set(entry.key.value, heading);
    }
  }
  return names;
}

const schemas = {
  'hoi4.reference_search': referenceSearchRequestSchema,
  'hoi4.reference_read': referenceReadRequestSchema,
  'hoi4.reference_context': referenceContextRequestSchema,
  'hoi4.source_lookup': sourceLookupRequestSchema,
  'hoi4.script_validate': scriptValidateRequestSchema,
  'hoi4.error_log': errorLogRequestSchema,
  'hoi4.explain_error': explainErrorRequestSchema,
  'hoi4.mod_health': modHealthRequestSchema,
  'hoi4.script_guard': scriptGuardRequestSchema,
  'hoi4.mod_index': modIndexRequestSchema,
  'hoi4.localisation_inspect': localisationInspectRequestSchema,
  'hoi4.compat_check': compatCheckRequestSchema,
  'hoi4.idea_inspect': ideaInspectRequestSchema,
  'hoi4.system_inspect': systemInspectRequestSchema,
  'hoi4.unit_inspect': unitInspectRequestSchema,
  'hoi4.asset_inspect': assetInspectRequestSchema,
  'hoi4.skill': skillRequestSchema,
} as const;
/** Asset findings players would not notice: uneven frames, sprites the game fills itself, hidden pictures and flags one pixel off. */
const ASSET_INFORMATION = new Set([
  'ASSET_FRAMES_MISMATCH',
  'ASSET_TEXTURE_NONE',
  'ASSET_TEXTURE_EMPTY',
  'ASSET_FLAG_SIZE_CLOSE',
]);
export type ReferenceToolName = keyof typeof schemas;
export function isReferenceTool(name: string): name is ReferenceToolName {
  return Object.hasOwn(schemas, name);
}

const sharedReferences = new WeakMap<CoreEngine, ReferenceService>();

/** One authorization and execution contract for both MCP protocol adapters. */
export class ReferenceToolService {
  private readonly references: ReferenceService;
  constructor(private readonly engine: CoreEngine) {
    const cached = sharedReferences.get(engine) ?? new ReferenceService();
    sharedReferences.set(engine, cached);
    this.references = cached;
  }

  async call(
    name: ReferenceToolName,
    input: unknown,
    context: OperationContext,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof toolResult>> {
    requireOperationScope(context, 'hoi4:read');
    const parsed = schemas[name].parse(input);
    // A validated file names its mod when the client's roots and working directory do not.
    const workspaceId = await resolveOperationWorkspaceForSource(
      this.engine,
      context,
      parsed.workspaceId,
      name === 'hoi4.script_validate' ? scriptValidateRequestSchema.parse(parsed).path : undefined,
      signal,
    );
    const workspace = this.engine.resolver.get(workspaceId, context.principal);
    const data =
      name === 'hoi4.reference_search'
        ? await this.references.searchHits(
            workspace,
            referenceSearchRequestSchema.parse(parsed),
            signal,
          )
        : name === 'hoi4.reference_read'
          ? await this.references.read(workspace, referenceReadRequestSchema.parse(parsed), signal)
          : name === 'hoi4.reference_context'
            ? await this.references.contextHits(
                workspace,
                referenceContextRequestSchema.parse(parsed),
                signal,
              )
            : name === 'hoi4.error_log'
              ? await readErrorLog(
                  workspace,
                  errorLogRequestSchema.parse(parsed),
                  this.engine.resolver.config().gameUserRoot,
                  signal,
                )
              : name === 'hoi4.script_guard'
                ? await this.scriptGuard(
                    workspaceId,
                    workspace,
                    scriptGuardRequestSchema.parse(parsed),
                    context.principal,
                    signal,
                  )
                : name === 'hoi4.mod_health'
                  ? await this.modHealth(
                      workspaceId,
                      workspace,
                      modHealthRequestSchema.parse(parsed),
                      context.principal,
                      signal,
                    )
                  : name === 'hoi4.explain_error'
                    ? await this.explainError(
                        workspaceId,
                        workspace,
                        explainErrorRequestSchema.parse(parsed),
                        context.principal,
                        signal,
                      )
                    : name === 'hoi4.mod_index'
                      ? await modIndex(
                          this.engine,
                          workspaceId,
                          modIndexRequestSchema.parse(parsed),
                          context.principal,
                          signal,
                        )
                      : name === 'hoi4.script_validate'
                        ? await this.validateScript(
                            workspaceId,
                            workspace,
                            scriptValidateRequestSchema.parse(parsed),
                            context.principal,
                            signal,
                          )
                        : name === 'hoi4.idea_inspect'
                          ? await inspectIdeas(
                              workspace,
                              ideaInspectRequestSchema.parse(parsed),
                              signal,
                            )
                          : name === 'hoi4.system_inspect'
                            ? await inspectSystem(
                                workspace,
                                systemInspectRequestSchema.parse(parsed),
                                signal,
                              )
                            : name === 'hoi4.asset_inspect'
                              ? await inspectAssets(
                                  workspace,
                                  assetInspectRequestSchema.parse(parsed),
                                  signal,
                                )
                              : name === 'hoi4.unit_inspect'
                                ? await inspectUnits(
                                    workspace,
                                    unitInspectRequestSchema.parse(parsed),
                                    signal,
                                  )
                                : name === 'hoi4.compat_check'
                                  ? await this.checkCompat(
                                      workspace,
                                      compatCheckRequestSchema.parse(parsed),
                                      context.principal,
                                      signal,
                                    )
                                  : name === 'hoi4.skill'
                                    ? await this.skill(
                                        workspace,
                                        skillRequestSchema.parse(parsed),
                                        signal,
                                      )
                                    : name === 'hoi4.localisation_inspect'
                                      ? await inspectLocalisation(
                                          workspace,
                                          localisationInspectRequestSchema.parse(parsed),
                                          signal,
                                        )
                                      : await sourceLookup(
                                          this.engine,
                                          workspaceId,
                                          sourceLookupRequestSchema.parse(parsed),
                                          context.principal,
                                          signal,
                                        );
    const result = emptyServiceResult(workspaceId, data);
    if (name === 'hoi4.script_guard') {
      const guard = scriptGuardDataSchema.parse(data);
      result.code = 'SCRIPT_GUARD_CHECKED';
      const invented = guard.counts.effect + guard.counts.trigger + guard.counts.modifier;
      result.validation = {
        passed: guard.verdict === 'clean',
        checks: [
          {
            id: 'script-guard',
            passed: guard.verdict === 'clean',
            message:
              guard.verdict === 'clean'
                ? `Every effect, trigger and modifier in ${guard.filesChecked} files is documented or defined`
                : `${invented} names in ${guard.filesChecked} files are neither documented nor defined`,
          },
        ],
      };
    }
    if (name === 'hoi4.mod_health') {
      const health = modHealthDataSchema.parse(data);
      result.code = 'MOD_HEALTH_CHECKED';
      result.validation = {
        passed: health.verdict === 'healthy',
        checks: [
          {
            id: 'mod-health',
            passed: health.verdict === 'healthy',
            message:
              health.verdict === 'healthy'
                ? 'Every audit ran and found no problem'
                : health.verdict === 'incomplete'
                  ? 'No problem found, but an audit could not run'
                  : `${health.totals.problems} kinds of problem, ${health.totals.findings} findings`,
          },
        ],
      };
    }
    if (name === 'hoi4.error_log') {
      const log = errorLogDataSchema.parse(data);
      result.code = 'ERROR_LOG_READ';
      // A log from a launch without the mod says nothing about the mod.
      const otherLaunch = log.launch?.modLoaded === false;
      // A log older than the mod's files describes an older mod (#65).
      const stale = await modChangedAfter(
        workspace.modRoot,
        Date.parse(log.log.modifiedAt),
        signal,
      );
      result.validation = {
        passed: log.modEntries === 0 && !otherLaunch && stale === undefined,
        checks: [
          ...(otherLaunch
            ? [
                {
                  id: 'error-log-launch',
                  passed: false,
                  message: `The last game launch did not load this mod (it ran with ${log.launch!.activeMods.join(', ') || 'no mods'}), so its log does not show this mod's errors`,
                },
              ]
            : []),
          ...(stale === undefined
            ? []
            : [
                {
                  id: 'error-log-age',
                  passed: false,
                  message: `The log was written at ${log.log.modifiedAt}, before ${stale.files} of the mod's files changed (the newest at ${stale.newestAt}, ${stale.examples[0] ?? ''}), so it does not show errors in the current source; relaunch the game to check them`,
                },
              ]),
          {
            id: 'error-log-mod-entries',
            passed: log.modEntries === 0,
            message:
              log.modEntries === 0
                ? 'The last game launch logged no errors located in this mod'
                : `The last game launch logged ${log.modEntries} distinct errors located in this mod`,
          },
        ],
      };
    }
    if (name === 'hoi4.skill') {
      const served = skillDataSchema.parse(data);
      result.code = served.skill === undefined ? 'SKILLS_LISTED' : 'SKILL_LOADED';
      // A skill that differs from the kit version the mod pins is not the shared text.
      result.validation = {
        passed: served.drifted === 0,
        checks: [
          {
            id: 'skill-pinned',
            passed: served.drifted === 0,
            message:
              served.kit === null
                ? 'The mod has no HOI4 Mod Setup lock, so the skills are served unpinned'
                : served.drifted === 0
                  ? `Every served file matches kit revision ${served.kit.revision}`
                  : `${served.drifted} skills differ from kit revision ${served.kit.revision}`,
          },
        ],
      };
    }
    if (name === 'hoi4.mod_index') {
      const index = modIndexDataSchema.parse(data);
      result.code = index.complete ? 'MOD_INDEXED' : 'MOD_INDEXED_PARTIAL';
    }
    if (name === 'hoi4.idea_inspect') {
      const inspected = ideaInspectDataSchema.parse(data);
      result.code = inspected.audit === undefined ? 'IDEA_INSPECTED' : 'IDEAS_AUDITED';
      // A missing name may be intended (generic leaders), so it is information, not a problem.
      const warnings =
        inspected.audit === undefined
          ? (inspected.inspection?.problems ?? []).filter(({ severity }) => severity === 'warning')
              .length
          : Object.entries(inspected.audit.counts)
              .filter(([code]) => !code.endsWith('_NAME_MISSING'))
              .reduce((sum, [, count]) => sum + count, 0);
      result.validation = {
        passed: warnings === 0,
        checks: [
          {
            id: 'idea-checks',
            passed: warnings === 0,
            message:
              warnings === 0
                ? 'No problems players would see'
                : `${warnings} problems players would see`,
          },
        ],
      };
    }
    if (name === 'hoi4.system_inspect') {
      const inspected = systemInspectDataSchema.parse(data);
      result.code = inspected.audit === undefined ? 'SYSTEM_INSPECTED' : 'SYSTEM_AUDITED';
      // Missing names and undocumented hooks may be intended, so they are information.
      const warnings =
        inspected.audit === undefined
          ? (inspected.inspection?.problems ?? []).filter(({ severity }) => severity === 'warning')
              .length
          : Object.entries(inspected.audit.counts)
              .filter(
                ([code]) =>
                  code !== 'SYSTEM_NAME_MISSING' && code !== 'ON_ACTION_HOOK_UNDOCUMENTED',
              )
              .reduce((sum, [, count]) => sum + count, 0);
      result.validation = {
        passed: warnings === 0,
        checks: [
          {
            id: 'system-checks',
            passed: warnings === 0,
            message:
              warnings === 0
                ? 'No problems players would see'
                : `${warnings} problems players would see`,
          },
        ],
      };
    }
    if (name === 'hoi4.unit_inspect') {
      const inspected = unitInspectDataSchema.parse(data);
      result.code = inspected.audit === undefined ? 'UNIT_INSPECTED' : 'UNIT_AUDITED';
      // A missing name or description may be intended, so it is information.
      const warnings =
        inspected.audit === undefined
          ? (inspected.inspection?.problems ?? []).filter(({ severity }) => severity === 'warning')
              .length
          : Object.entries(inspected.audit.counts)
              .filter(([code]) => code !== 'UNIT_NAME_MISSING')
              .reduce((sum, [, count]) => sum + count, 0);
      result.validation = {
        passed: warnings === 0,
        checks: [
          {
            id: 'unit-checks',
            passed: warnings === 0,
            message:
              warnings === 0
                ? 'No problems players would see'
                : `${warnings} problems players would see`,
          },
        ],
      };
    }
    if (name === 'hoi4.asset_inspect') {
      const inspected = assetInspectDataSchema.parse(data);
      result.code = inspected.audit === undefined ? 'ASSET_INSPECTED' : 'ASSET_AUDITED';
      const warnings =
        inspected.audit === undefined
          ? (inspected.inspection?.problems ?? []).filter(({ severity }) => severity === 'warning')
              .length
          : Object.entries(inspected.audit.counts)
              .filter(([code]) => !ASSET_INFORMATION.has(code))
              .reduce((sum, [, count]) => sum + count, 0);
      result.validation = {
        passed: warnings === 0,
        checks: [
          {
            id: 'asset-checks',
            passed: warnings === 0,
            message:
              warnings === 0
                ? 'No problems players would see'
                : `${warnings} problems players would see`,
          },
        ],
      };
    }
    if (name === 'hoi4.compat_check') {
      const checked = compatCheckDataSchema.parse(data);
      result.code = checked.mode === 'mod' ? 'COMPAT_MOD_CHECKED' : 'COMPAT_PATCH_CHECKED';
      if (checked.mode === 'mod')
        result.validation = {
          passed: checked.verdict === 'no_conflicts',
          checks: [
            {
              id: 'mod-compatibility',
              passed: checked.verdict === 'no_conflicts',
              message: checked.summary,
            },
          ],
        };
    }
    if (name === 'hoi4.localisation_inspect') {
      const inspected = localisationInspectDataSchema.parse(data);
      result.code = 'LOCALISATION_INSPECTED';
      if (inspected.audit !== undefined) {
        // Information (text shown as written on purpose) is not a problem players see.
        const warnings = Object.entries(inspected.audit.counts)
          .filter(
            ([code]) => code !== 'LOC_SCRIPTED_TEXT_LITERAL' && code !== 'LOC_PLACEHOLDER_MISSING',
          )
          .reduce((sum, [, count]) => sum + count, 0);
        result.validation = {
          passed: warnings === 0,
          checks: [
            {
              id: 'localisation-audit',
              passed: warnings === 0,
              message:
                warnings === 0
                  ? 'No localisation problems players would see'
                  : `${warnings} localisation problems players would see`,
            },
          ],
        };
      }
    }
    if (name === 'hoi4.script_validate') {
      const checked = scriptValidateDataSchema.parse(data);
      result.code = checked.valid === null ? 'SCRIPT_CHECK_PARTIAL' : 'SCRIPT_CHECKED';
      result.validation = {
        passed: checked.valid === true,
        checks: [
          {
            id: 'script-command-checks',
            passed: checked.valid === true,
            message:
              checked.valid === true
                ? 'Syntax, native command kinds and declared scopes match the selected documentation'
                : checked.valid === false
                  ? 'Script checks found an error'
                  : `Script checks are partial: ${(checked.partialReasons ?? ['coverage is unresolved']).join('; ')}`,
          },
        ],
      };
      result.diagnostics = checked.findings
        .filter(({ status }) => status !== 'supported')
        .slice(0, 20)
        .map((finding) => ({
          code: finding.code,
          severity: finding.status === 'error' ? ('error' as const) : ('warning' as const),
          category: 'validation' as const,
          message: finding.message,
          details: {
            command: finding.command,
            kind: finding.kind,
            scope: finding.scope,
            line: finding.line,
            column: finding.column,
          },
        }));
      while (
        Buffer.byteLength(JSON.stringify(result.diagnostics), 'utf8') > 4096 &&
        result.diagnostics.length > 1
      )
        result.diagnostics.pop();
    }
    return toolResult(result, { compact: true });
  }

  readonly #eventPopups = new Map<
    string,
    { key: string; events: ReadonlyMap<string, EventPopupDefinition> }
  >();

  /** The latest player-text context of each workspace, keyed by its source files' hashes. */
  readonly #playerText = new Map<string, { key: string; context: PlayerTextContext }>();

  /**
   * `hoi4.mod_health`: the error log, the engine's whole-mod check and the localisation and
   * asset audits run side by side; script validation then checks the files they named first,
   * and the newest after them, within a time budget.
   */
  private async modHealth(
    workspaceId: string,
    workspace: ResolvedWorkspace,
    request: z.infer<typeof modHealthRequestSchema>,
    principal?: string,
    signal?: AbortSignal,
  ) {
    const wanted = new Set<HealthCheck>(
      request.checks ?? ['error_log', 'engine_check', 'script', 'localisation', 'assets'],
    );
    const timed = async (
      check: HealthCheck,
      run: () => Promise<Omit<CheckRun, 'check' | 'ms'>>,
    ): Promise<CheckRun> => {
      if (!wanted.has(check)) return { check, status: 'skipped', ms: 0, findings: [] };
      const started = performance.now();
      try {
        return { check, ...(await run()), ms: performance.now() - started };
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        const code = error instanceof ServiceError ? error.code : 'INTERNAL_ERROR';
        return {
          check,
          status: 'unavailable',
          ms: performance.now() - started,
          findings: [],
          note: `${code}: ${(error as Error).message}`,
        };
      }
    };
    const [errorLog, engineCheck, localisation, assets] = await Promise.all([
      timed('error_log', () => this.healthErrorLog(workspace, signal)),
      timed('engine_check', () => healthEngineCheck(workspace, signal)),
      timed('localisation', () => healthLocalisation(workspace, signal)),
      timed('assets', () => healthAssets(workspace, signal)),
    ]);
    // The files the other audits name are validated first.
    const named = new Set(
      [...errorLog.findings, ...engineCheck.findings].flatMap(({ path: file }) =>
        file === undefined ? [] : [file],
      ),
    );
    const script = await timed('script', () =>
      this.healthScript(workspaceId, workspace, named, principal, signal),
    );
    return rankProblems([errorLog, engineCheck, script, localisation, assets], request.limit);
  }

  /** The mod's own entries of the last launch's error.log, grouped by what they report. */
  private async healthErrorLog(
    workspace: ResolvedWorkspace,
    signal?: AbortSignal,
  ): Promise<Omit<CheckRun, 'check' | 'ms'>> {
    const log = await readErrorLog(
      workspace,
      errorLogRequestSchema.parse({ scope: 'mod', limit: 50 }),
      this.engine.resolver.config().gameUserRoot,
      signal,
    );
    if (log.launch?.modLoaded === false)
      return {
        status: 'partial',
        findings: [],
        note: 'The last game launch did not load this mod, so its error.log says nothing about it',
      };
    const stale = await modChangedAfter(workspace.modRoot, Date.parse(log.log.modifiedAt), signal);
    const findings: HealthFinding[] = log.entries
      .filter((entry) => entry.source?.layer === 'mod')
      .map((entry) => {
        const matched = errorExplanations.find((explanation) =>
          explanation.regex.test(entry.message),
        );
        return {
          code: `LOG_${(matched?.id ?? entry.category).toUpperCase()}`,
          severity: 'error' as const,
          message: entry.message,
          ...(entry.source === undefined ? {} : { path: entry.source.relativePath }),
          ...(entry.source?.line === undefined ? {} : { line: entry.source.line }),
        };
      });
    return {
      status: stale === undefined ? 'ran' : 'partial',
      findings,
      ...(stale === undefined
        ? {}
        : {
            note: `${stale.files} mod files changed after the log was written; relaunch the game for a current log`,
          }),
      describe: (_code, examples) => {
        const first = examples[0]!.message;
        const category = log.entries.find((entry) => entry.message === first)?.category ?? 'other';
        return {
          title: `The game reports: ${errorLogPattern(first)}`,
          fix: `${categoryHints[category]} hoi4.explain_error explains each line.`,
          weight: (category === 'syntax' ? 100 : 90) - (stale === undefined ? 0 : 30),
          next: { tool: 'hoi4.explain_error', arguments: { line: first.slice(0, 1000) } },
        };
      },
    };
  }

  /** Validate the mod's script files: the ones other audits named, then the newest. */
  private async healthScript(
    workspaceId: string,
    workspace: ResolvedWorkspace,
    named: ReadonlySet<string>,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<Omit<CheckRun, 'check' | 'ms'>> {
    const files = await globFiles(HEALTH_SCRIPT_PATTERNS, {
      cwd: workspace.modRoot,
      caseSensitive: false,
      ...(signal === undefined ? {} : { signal }),
    });
    const modified = new Map<string, number>();
    for (const file of files)
      modified.set(
        file,
        (await stat(path.join(workspace.modRoot, file)).catch(() => undefined))?.mtimeMs ?? 0,
      );
    const ordered = [...files].sort(
      (left, right) =>
        Number(named.has(right)) - Number(named.has(left)) ||
        modified.get(right)! - modified.get(left)! ||
        (left < right ? -1 : 1),
    );
    const deadline = performance.now() + HEALTH_SCRIPT_BUDGET_MS;
    const findings: HealthFinding[] = [];
    let checked = 0;
    for (const file of ordered.slice(0, HEALTH_SCRIPT_MAX_FILES)) {
      if (performance.now() > deadline) break;
      signal?.throwIfAborted();
      const validated = await this.validateScript(
        workspaceId,
        workspace,
        scriptValidateRequestSchema.parse({ path: file, limit: 32 }),
        principal,
        signal,
      );
      checked += 1;
      for (const finding of validated.findings)
        if (finding.status === 'error' || finding.status === 'warning')
          findings.push({
            code: finding.code,
            severity: finding.status,
            message: finding.message,
            path: file,
            line: finding.line,
          });
    }
    return {
      status: checked === files.length ? 'ran' : 'partial',
      findings,
      ...(checked === files.length
        ? {}
        : {
            note: `Checked ${checked} of ${files.length} script files within the time budget: files other audits named first, then the newest`,
          }),
    };
  }

  /**
   * `hoi4.script_guard`: the engine's whole-mod check narrowed to the files an agent wrote, and
   * script validation of the first of them for the names the engine does not read as commands.
   */
  private async scriptGuard(
    workspaceId: string,
    workspace: ResolvedWorkspace,
    request: z.infer<typeof scriptGuardRequestSchema>,
    principal?: string,
    signal?: AbortSignal,
  ) {
    const { files, candidates } = await guardedFiles(
      workspace.modRoot,
      request,
      Date.now(),
      signal,
    );
    if (files.length === 0)
      throw new ServiceError(
        'SCRIPT_GUARD_NO_FILES',
        `No script file of the mod changed in the last ${request.sinceMinutes} minutes; pass paths to name the files to check`,
      );
    const report = await runEngineCheck(
      {
        mod: workspace.modRoot,
        ...(workspace.gameRoot === undefined ? {} : { game: workspace.gameRoot }),
        dependencies: workspace.dependencyRoots,
        includeDlc: workspace.dlcLayers.length > 0,
      },
      signal === undefined ? {} : { signal },
    );
    const unresolved: InventedName[] = [];
    for (const file of files.filter((candidate) => SCRIPT_FILE.test(candidate)).slice(0, 50)) {
      signal?.throwIfAborted();
      const validated = await this.validateScript(
        workspaceId,
        workspace,
        scriptValidateRequestSchema.parse({ path: file, limit: 32 }),
        principal,
        signal,
      );
      for (const finding of validated.findings)
        if (
          finding.code === 'SCRIPT_COMMAND_UNRESOLVED' &&
          finding.command !== '' &&
          (finding.kind === 'effect' || finding.kind === 'trigger')
        )
          unresolved.push({
            name: finding.command,
            kind: finding.kind,
            path: file,
            line: finding.line,
            ...(finding.suggestions[0] === undefined ? {} : { suggestion: finding.suggestions[0] }),
            message: `\`${finding.command}\` is neither a documented ${finding.kind} nor a scripted ${finding.kind} defined in any loaded file`,
          });
    }
    return inventedNames(report, files, candidates, unresolved);
  }

  /** Explanations know the documented commands and the scripted helpers the loaded files define. */
  private async explainError(
    workspaceId: string,
    workspace: ResolvedWorkspace,
    request: z.infer<typeof explainErrorRequestSchema>,
    principal?: string,
    signal?: AbortSignal,
  ) {
    const snapshot = await this.engine.scan(
      workspaceId,
      { patterns: ['common/scripted_effects/**/*.txt', 'common/scripted_triggers/**/*.txt'] },
      principal,
      signal,
    );
    const helpers = (kind: string) =>
      new Set(snapshot.index.symbols.filter((symbol) => symbol.kind === kind).map(({ id }) => id));
    const documented = await documentedNames(this.references, workspace, signal);
    return explainErrors(request, {
      workspace,
      ...(documented === undefined ? {} : { documented }),
      helpers: { effect: helpers('scripted_effect'), trigger: helpers('scripted_trigger') },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** File mode reads the scanned file and the mod's scripted helper names from one scan. */
  private async skill(
    workspace: ResolvedWorkspace,
    request: z.infer<typeof skillRequestSchema>,
    signal?: AbortSignal,
  ) {
    return request.name === undefined
      ? listSkills(workspace, signal)
      : loadSkill(workspace, { ...request, name: request.name }, signal);
  }

  private async checkCompat(
    workspace: ResolvedWorkspace,
    input: CompatCheckRequest,
    principal: string | undefined,
    signal?: AbortSignal,
  ): Promise<CompatCheckData> {
    return input.mode === 'mod'
      ? checkModCompatibility(this.engine, workspace, input, principal, signal)
      : checkPatchCompatibility(workspace, input, signal);
  }

  private async validateScript(
    workspaceId: string,
    workspace: ResolvedWorkspace,
    request: z.infer<typeof scriptValidateRequestSchema>,
    principal?: string,
    signal?: AbortSignal,
  ) {
    // Every file check of the supported families shares one scan, so checking files across
    // folders reuses one snapshot and its incremental index; other folders add their own.
    const scan = (extra: readonly string[]) =>
      this.engine.scan(
        workspaceId,
        { patterns: [...fileCheckPatterns, ...extra] },
        principal,
        signal,
      );
    if (request.path === undefined) {
      // A snippet that names definitions is checked against a scan; others need none.
      const named = new RegExp(
        `\\b(?:${[...identifierArgumentCommands].join('|')})\\s*=`,
        'u',
      ).test(request.source ?? '');
      const identifiers = named ? identifierContext(await scan([])) : undefined;
      if (request.kind !== undefined)
        return validateScript(this.references, workspace, request, signal, undefined, identifiers);
      // A snippet without a kind is checked as an effect and as a trigger; the reading with
      // fewer errors and unresolved commands is the one the author meant.
      const effect = await validateScript(
        this.references,
        workspace,
        { ...request, kind: 'effect' },
        signal,
        undefined,
        identifiers,
      );
      const trigger = await validateScript(
        this.references,
        workspace,
        { ...request, kind: 'trigger' },
        signal,
        undefined,
        identifiers,
      );
      const misses = (checked: typeof effect): number =>
        checked.findings.filter(({ status }) => status === 'error').length * 100_000 +
        checked.unresolvedCount;
      return misses(trigger) < misses(effect) ? trigger : effect;
    }
    let snapshot = await scan([]);
    let file;
    try {
      file = selectFile(snapshot, request.path);
    } catch (error) {
      const extra = locatePatterns(this.engine, workspaceId, request.path, principal);
      if (extra === undefined) throw error;
      snapshot = await scan(extra);
      file = selectFile(snapshot, request.path);
    }
    const playerText = playerTextFamily(file.relativePath)
      ? this.playerTextContext(workspaceId, snapshot)
      : undefined;
    const helpers = (kind: string) =>
      new Set(snapshot.index.symbols.filter((symbol) => symbol.kind === kind).map(({ id }) => id));
    return validateScript(
      this.references,
      workspace,
      request,
      signal,
      {
        path: file.displayPath,
        relativePath: file.relativePath,
        bytes: file.bytes,
        helpers: { effect: helpers('scripted_effect'), trigger: helpers('scripted_trigger') },
        implicitTriggers: implicitTriggerNames(snapshot),
        ...(playerText === undefined ? {} : { playerText }),
        eventPopups: this.eventPopupContext(workspaceId, snapshot),
        knownMistakes: { eventNamespaces: this.eventNamespaces(workspaceId, snapshot) },
      },
      identifierContext(snapshot),
    );
  }

  readonly #eventNamespaces = new Map<string, { key: string; namespaces: ReadonlySet<string> }>();

  /** Namespaces declared with `add_namespace` in every active events file, cached by hash. */
  private eventNamespaces(workspaceId: string, snapshot: ScanSnapshot): ReadonlySet<string> {
    const sources = [...snapshot.index.files.values()].filter(
      ({ relativePath, shadowedBy }) =>
        shadowedBy === undefined && relativePath.startsWith('events/'),
    );
    const cacheKey = hashCanonical(sources.map(({ displayPath, sha256 }) => [displayPath, sha256]));
    const cached = this.#eventNamespaces.get(workspaceId);
    if (cached?.key === cacheKey) return cached.namespaces;
    const namespaces = new Set<string>();
    for (const file of sources)
      for (const match of file.bytes
        .toString('utf8')
        .matchAll(/^\s*add_namespace\s*=\s*"?([\w.]+)"?/gmu))
        namespaces.add(match[1]!);
    this.#eventNamespaces.set(workspaceId, { key: cacheKey, namespaces });
    return namespaces;
  }

  /** Every active event definition, cached by the hashes of the events files. */
  private eventPopupContext(
    workspaceId: string,
    snapshot: ScanSnapshot,
  ): ReadonlyMap<string, EventPopupDefinition> {
    const sources = [...snapshot.index.files.values()]
      .filter(
        ({ relativePath, shadowedBy }) =>
          shadowedBy === undefined && relativePath.startsWith('events/'),
      )
      .sort((left, right) => left.loadOrder - right.loadOrder);
    const cacheKey = hashCanonical(sources.map(({ displayPath, sha256 }) => [displayPath, sha256]));
    const cached = this.#eventPopups.get(workspaceId);
    if (cached?.key === cacheKey) return cached.events;
    const events = new Map<string, EventPopupDefinition>();
    for (const file of sources)
      for (const [id, definition] of eventPopupDefinitions(file.bytes, file.displayPath))
        events.set(id, definition);
    this.#eventPopups.set(workspaceId, { key: cacheKey, events });
    return events;
  }

  /** English localisation as the game resolves it, and the branches of scripted localisation. */
  private playerTextContext(workspaceId: string, snapshot: ScanSnapshot): PlayerTextContext {
    const sources = [...snapshot.index.files.values()].filter(({ relativePath }) =>
      playerTextSource(relativePath),
    );
    const cacheKey = hashCanonical(sources.map(({ displayPath, sha256 }) => [displayPath, sha256]));
    const cached = this.#playerText.get(workspaceId);
    if (cached?.key === cacheKey) return cached.context;
    const localisation = new Map<string, LocalisedText & { loadOrder: number }>();
    for (const symbol of snapshot.index.symbols) {
      if (
        symbol.kind !== 'localisation' ||
        symbol.sourceShadowed ||
        !symbol.id.startsWith('l_english:')
      )
        continue;
      const key = symbol.id.slice('l_english:'.length);
      const previous = localisation.get(key);
      if (previous !== undefined && previous.loadOrder > symbol.loadOrder) continue;
      localisation.set(key, {
        value: typeof symbol.metadata.value === 'string' ? symbol.metadata.value : '',
        path: symbol.path,
        line: symbol.location?.start.line ?? 1,
        loadOrder: symbol.loadOrder,
      });
    }
    const scriptedLocalisation = new Map<string, string[]>();
    for (const file of sources) {
      if (!file.relativePath.startsWith('common/scripted_localisation/')) continue;
      for (const definition of parseClausewitz(file.bytes, file.displayPath).root.entries) {
        if (
          definition.type !== 'assignment' ||
          definition.key.value !== 'defined_text' ||
          definition.value.type !== 'block'
        )
          continue;
        let name: string | undefined;
        const keys: string[] = [];
        for (const entry of definition.value.entries) {
          if (entry.type !== 'assignment') continue;
          if (entry.key.value === 'name' && entry.value.type === 'scalar') name = entry.value.value;
          if (entry.key.value !== 'text' || entry.value.type !== 'block') continue;
          for (const branch of entry.value.entries)
            if (
              branch.type === 'assignment' &&
              /^locali[sz]ation_key$/u.test(branch.key.value) &&
              branch.value.type === 'scalar'
            )
              keys.push(branch.value.value);
        }
        if (name !== undefined) scriptedLocalisation.set(name, keys);
      }
    }
    const context = { localisation, scriptedLocalisation };
    this.#playerText.set(workspaceId, { key: cacheKey, context });
    return context;
  }
}

/** The families file mode checks, the helpers and databases it resolves, and localisation. */
const fileCheckPatterns = [
  'events/**/*.txt',
  'common/decisions/**/*.txt',
  'common/national_focus/**/*.txt',
  'common/on_actions/**/*.txt',
  'common/scripted_effects/**/*.txt',
  'common/scripted_triggers/**/*.txt',
  ...Object.keys(implicitTriggerSources).map((folder) => `common/${folder}/*.txt`),
  'localisation/**/*_l_english.yml',
  'common/scripted_localisation/**/*.txt',
  // Definitions that identifier arguments name.
  'common/ideas/**/*.txt',
  'common/technologies/**/*.txt',
  // Advisors' idea tokens are ideas.
  'common/characters/**/*.txt',
] as const;

/** Index kinds whose ids identifier arguments name. */
const identifierKinds: Readonly<Record<string, IdentifierKind>> = {
  idea: 'idea',
  event: 'event',
  decision: 'decision',
  focus: 'focus',
  continuous_focus: 'focus',
  technology: 'technology',
};

function identifierContext(snapshot: ScanSnapshot): IdentifierContext {
  const ids = new Map<IdentifierKind, Set<string>>();
  for (const symbol of snapshot.index.symbols) {
    const kind = identifierKinds[symbol.kind];
    if (kind === undefined) continue;
    let set = ids.get(kind);
    if (set === undefined) ids.set(kind, (set = new Set()));
    set.add(symbol.id);
  }
  return { ids, complete: snapshot.complete };
}

function playerTextSource(relativePath: string): boolean {
  const file = relativePath.replaceAll('\\', '/').toLowerCase();
  return (
    (file.startsWith('localisation/') && file.endsWith('_l_english.yml')) ||
    file.startsWith('common/scripted_localisation/')
  );
}

/** Files whose player-facing text and requirement tooltips file mode checks. */
function playerTextFamily(relativePath: string): boolean {
  const file = relativePath.replaceAll('\\', '/').toLowerCase();
  return (
    file.startsWith('events/') ||
    file.startsWith('common/national_focus/') ||
    (file.startsWith('common/decisions/') && !file.startsWith('common/decisions/categories/'))
  );
}

/** The script families file validation checks, in the mod's own folder. */
const HEALTH_SCRIPT_PATTERNS = [
  'events/**/*.txt',
  'common/decisions/**/*.txt',
  'common/national_focus/**/*.txt',
  'common/on_actions/**/*.txt',
  'common/scripted_effects/**/*.txt',
  'common/scripted_triggers/**/*.txt',
];
const HEALTH_SCRIPT_BUDGET_MS = 30_000;
/** The families script validation reads, for the guard's second pass. */
const SCRIPT_FILE =
  /^(?:events|common\/(?:decisions|national_focus|on_actions|scripted_effects|scripted_triggers))\//u;
const HEALTH_SCRIPT_MAX_FILES = 400;

/** The engine's whole-mod check: findings in the mod's own layer. */
async function healthEngineCheck(
  workspace: ResolvedWorkspace,
  signal?: AbortSignal,
): Promise<Omit<CheckRun, 'check' | 'ms'>> {
  const report = await runEngineCheck(
    {
      mod: workspace.modRoot,
      ...(workspace.gameRoot === undefined ? {} : { game: workspace.gameRoot }),
      dependencies: workspace.dependencyRoots,
      includeDlc: workspace.dlcLayers.length > 0,
    },
    signal === undefined ? {} : { signal },
  );
  const layer = checkedLayerName(report);
  return {
    status: 'ran',
    findings: report.findings
      .filter((finding) => finding.layer === layer && finding.severity !== 'info')
      .map((finding) => ({
        code: finding.code,
        severity: finding.severity === 'error' ? ('error' as const) : ('warning' as const),
        message: finding.message,
        path: finding.path,
        line: finding.line,
      })),
  };
}

/** The engine's localisation audit; information is not a problem players see. */
async function healthLocalisation(
  workspace: ResolvedWorkspace,
  signal?: AbortSignal,
): Promise<Omit<CheckRun, 'check' | 'ms'>> {
  const inspected = await inspectLocalisation(
    workspace,
    localisationInspectRequestSchema.parse({ mode: 'audit', limit: 2 }),
    signal,
  );
  const problems = (inspected.audit?.problems ?? []).filter(
    ({ severity }) => severity === 'warning',
  );
  const codes = new Set(problems.map(({ code }) => code));
  return {
    status: 'ran',
    findings: problems.map(({ code, message, path: file, line }) => ({
      code,
      severity: 'warning' as const,
      message,
      path: file,
      line,
    })),
    counts: Object.fromEntries(
      Object.entries(inspected.audit?.counts ?? {}).filter(([code]) => codes.has(code)),
    ),
  };
}

/** The engine's sprite and flag audits, without what players would not notice. */
async function healthAssets(
  workspace: ResolvedWorkspace,
  signal?: AbortSignal,
): Promise<Omit<CheckRun, 'check' | 'ms'>> {
  const findings: HealthFinding[] = [];
  const counts: Record<string, number> = {};
  for (const kind of ['sprite', 'flag'] as const) {
    const inspected = await inspectAssets(
      workspace,
      assetInspectRequestSchema.parse({ kind, audit: true, limit: 2 }),
      signal,
    );
    for (const problem of inspected.audit?.problems ?? []) {
      if (problem.severity !== 'warning' || ASSET_INFORMATION.has(problem.code)) continue;
      findings.push({
        code: problem.code,
        severity: 'warning',
        message: problem.message,
        path: problem.path,
        line: problem.line,
      });
    }
    for (const [code, count] of Object.entries(inspected.audit?.counts ?? {}))
      if (!ASSET_INFORMATION.has(code)) counts[code] = (counts[code] ?? 0) + count;
  }
  const codes = new Set(findings.map(({ code }) => code));
  return {
    status: 'ran',
    findings,
    counts: Object.fromEntries(Object.entries(counts).filter(([code]) => codes.has(code))),
  };
}
