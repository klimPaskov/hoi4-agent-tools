import { compareCodeUnits } from '../core/canonical.js';
import type { ScanSnapshot } from '../core/engine.js';
import type { ScannedFile } from '../core/scanner.js';
import { ServiceError } from '../core/result.js';
import { parseClausewitz } from '../core/source/index.js';
import {
  enrichFocusPlanFromSidecar,
  focusPlanningSidecarPath,
  importContinuousFocusPalettes,
  importFocusTrees,
  linkContinuousFocusPalettes,
  parseFocusPlanningSidecar,
  type ContinuousFocusPalettePlan,
  type FocusImportResult,
  type FocusReferenceCatalog,
  type FocusTreePlan,
} from './index.js';

function normalizedRoot(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '').toLowerCase();
}

export function underConfiguredRoot(relativePath: string, roots: readonly string[]): boolean {
  const candidate = relativePath.replaceAll('\\', '/').toLowerCase();
  return roots.some((root) => {
    const normalized = normalizedRoot(root);
    return candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}

export function activeFocusFiles(
  snapshot: ScanSnapshot,
  focusRoots: readonly string[],
): ScanSnapshot['files'] {
  return snapshot.files.filter(
    ({ relativePath, shadowedBy }) =>
      shadowedBy === undefined &&
      underConfiguredRoot(relativePath, focusRoots) &&
      relativePath.toLowerCase().endsWith('.txt'),
  );
}

export function activeContinuousFocusFiles(snapshot: ScanSnapshot): ScanSnapshot['files'] {
  return snapshot.files.filter(
    ({ relativePath, shadowedBy }) =>
      shadowedBy === undefined &&
      relativePath.replaceAll('\\', '/').toLowerCase().startsWith('common/continuous_focus/') &&
      relativePath.toLowerCase().endsWith('.txt'),
  );
}

export function continuousPalettes(snapshot: ScanSnapshot): {
  palettes: ContinuousFocusPalettePlan[];
  diagnostics: FocusImportResult['diagnostics'];
} {
  const palettes: ContinuousFocusPalettePlan[] = [];
  const diagnostics: FocusImportResult['diagnostics'] = [];
  for (const file of activeContinuousFocusFiles(snapshot)) {
    const document = parseClausewitz(file.bytes, file.displayPath);
    const imported = importContinuousFocusPalettes(document);
    palettes.push(...imported.continuousFocusPalettes);
    diagnostics.push(...imported.diagnostics);
  }
  return { palettes, diagnostics };
}

export function activeSidecar(
  snapshot: ScanSnapshot,
  focusFile: Pick<ScannedFile, 'relativePath'>,
): { file: ScannedFile; sidecar: ReturnType<typeof parseFocusPlanningSidecar> } | undefined {
  const relativePath = focusPlanningSidecarPath(focusFile.relativePath).toLowerCase();
  const file = snapshot.files.find(
    (candidate) =>
      candidate.shadowedBy === undefined && candidate.relativePath.toLowerCase() === relativePath,
  );
  return file === undefined ? undefined : { file, sidecar: parseFocusPlanningSidecar(file.bytes) };
}

export function importFocusFile(
  snapshot: ScanSnapshot,
  file: ScannedFile,
  palettes: readonly ContinuousFocusPalettePlan[],
): FocusImportResult {
  const document = parseClausewitz(file.bytes, file.displayPath);
  const imported = importFocusTrees(document, { references: referenceCatalog(snapshot) });
  const sidecar = activeSidecar(snapshot, file);
  imported.plans = imported.plans.map((plan) => {
    const enriched =
      sidecar === undefined
        ? { plan, diagnostics: [] }
        : enrichFocusPlanFromSidecar(plan, sidecar.sidecar);
    imported.diagnostics.push(...enriched.diagnostics);
    return linkContinuousFocusPalettes(enriched.plan, palettes);
  });
  return imported;
}

export function selectedFocusFile(
  snapshot: ScanSnapshot,
  focusRoots: readonly string[],
  relativePath: string,
): ScannedFile {
  const file = activeFocusFiles(snapshot, focusRoots).find(
    (candidate) => candidate.relativePath === relativePath,
  );
  if (file === undefined)
    throw new ServiceError('FOCUS_SOURCE_NOT_FOUND', `Focus source was not found: ${relativePath}`);
  return file;
}

export function selectedContinuousFocusFile(
  snapshot: ScanSnapshot,
  relativePath: string,
): ScannedFile {
  const file = activeContinuousFocusFiles(snapshot).find(
    (candidate) => candidate.relativePath === relativePath,
  );
  if (file === undefined)
    throw new ServiceError(
      'CONTINUOUS_FOCUS_SOURCE_NOT_FOUND',
      `Continuous focus source was not found: ${relativePath}`,
    );
  return file;
}

export function selectPlan(result: FocusImportResult, treeId: string | undefined): FocusTreePlan {
  if (result.plans.length === 0)
    throw new ServiceError('FOCUS_TREE_NOT_FOUND', 'The source file contains no focus tree');
  if (treeId === undefined) {
    if (result.plans.length !== 1)
      throw new ServiceError(
        'FOCUS_TREE_ID_REQUIRED',
        'The source file contains multiple focus trees; provide treeId',
        { treeIds: result.plans.map(({ id }) => id) },
      );
    return result.plans[0]!;
  }
  const plan = result.plans.find(({ id }) => id === treeId);
  if (plan === undefined)
    throw new ServiceError('FOCUS_TREE_NOT_FOUND', `Focus tree was not found: ${treeId}`);
  return plan;
}

export function selectContinuousPlan(
  result: FocusImportResult,
  paletteId: string | undefined,
): ContinuousFocusPalettePlan {
  if (result.continuousFocusPalettes.length === 0)
    throw new ServiceError(
      'CONTINUOUS_FOCUS_PALETTE_NOT_FOUND',
      'The source file contains no continuous focus palette',
    );
  if (paletteId === undefined) {
    if (result.continuousFocusPalettes.length !== 1)
      throw new ServiceError(
        'CONTINUOUS_FOCUS_PALETTE_ID_REQUIRED',
        'The source file contains multiple continuous focus palettes; provide paletteId',
        { paletteIds: result.continuousFocusPalettes.map(({ id }) => id) },
      );
    return result.continuousFocusPalettes[0]!;
  }
  const plan = result.continuousFocusPalettes.find(({ id }) => id === paletteId);
  if (plan === undefined)
    throw new ServiceError(
      'CONTINUOUS_FOCUS_PALETTE_NOT_FOUND',
      `Continuous focus palette was not found: ${paletteId}`,
    );
  return plan;
}

export function referenceCatalog(snapshot: ScanSnapshot): FocusReferenceCatalog {
  const identifiers = (kind: Parameters<ScanSnapshot['index']['findAll']>[0]): string[] =>
    [
      ...new Set(
        snapshot.index
          .findAll(kind)
          .filter(({ overridden }) => !overridden)
          .map(({ id }) => id),
      ),
    ].sort((left, right) => compareCodeUnits(left, right));
  return {
    decision: identifiers('decision'),
    decision_category: identifiers('decision_category'),
    event: identifiers('event'),
    idea: identifiers('idea'),
    leader: identifiers('leader'),
    formable: identifiers('formable'),
    helper: identifiers('scripted_effect'),
  };
}

export function validationFromDiagnostics(diagnostics: FocusImportResult['diagnostics']): {
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; message: string }>;
} {
  const blocking = diagnostics.filter(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  return {
    passed: blocking.length === 0,
    checks: [
      {
        id: 'focus-diagnostics',
        passed: blocking.length === 0,
        message:
          blocking.length === 0
            ? 'Focus source, references, and layout have no blocking diagnostics'
            : `${blocking.length} blocking focus diagnostics`,
      },
    ],
  };
}
