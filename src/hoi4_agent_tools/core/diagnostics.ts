import { compareCodeUnits } from './canonical.js';
export type DiagnosticSeverity = 'info' | 'warning' | 'error' | 'blocker';
export type DiagnosticCategory =
  | 'syntax'
  | 'reference'
  | 'layout'
  | 'design'
  | 'rendering'
  | 'security'
  | 'validation'
  | 'map'
  | 'configuration';

export interface SourcePosition {
  line: number;
  column: number;
  offset: number;
}

export interface SourceLocation {
  path: string;
  start: SourcePosition;
  end: SourcePosition;
  symbol?: string;
}

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  message: string;
  location?: SourceLocation;
  related?: SourceLocation[];
  operationId?: string;
  details?: Record<string, unknown>;
}

const severityOrder: Record<DiagnosticSeverity, number> = {
  blocker: 0,
  error: 1,
  warning: 2,
  info: 3,
};

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const severity = severityOrder[left.severity] - severityOrder[right.severity];
    if (severity !== 0) return severity;
    const path = compareCodeUnits(left.location?.path ?? '', right.location?.path ?? '');
    if (path !== 0) return path;
    const offset = (left.location?.start.offset ?? 0) - (right.location?.start.offset ?? 0);
    if (offset !== 0) return offset;
    return compareCodeUnits(left.code, right.code);
  });
}

export function hasBlockingDiagnostics(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(({ severity }) => severity === 'error' || severity === 'blocker');
}
