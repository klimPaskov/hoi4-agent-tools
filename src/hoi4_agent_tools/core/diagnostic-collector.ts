import type { Diagnostic, DiagnosticCategory } from './diagnostics.js';

export interface DiagnosticTruncation {
  code: string;
  category: DiagnosticCategory;
  message: string;
}

/** Keeps diagnostics bounded while preserving an explicit deterministic truncation sentinel. */
export class DiagnosticCollector {
  private readonly items: Diagnostic[] = [];
  private dropped = 0;
  private readonly droppedBySeverity: Partial<Record<Diagnostic['severity'], number>> = {};
  private readonly droppedByCode: Record<string, number> = {};

  public constructor(
    private readonly maximum: number,
    private readonly truncation: DiagnosticTruncation,
  ) {}

  public push(...diagnostics: Diagnostic[]): number {
    this.pushMany(diagnostics);
    return this.items.length;
  }

  public pushMany(diagnostics: Iterable<Diagnostic>): void {
    for (const diagnostic of diagnostics) {
      if (this.items.length < Math.max(0, this.maximum - 1)) this.items.push(diagnostic);
      else {
        const hard = diagnostic.severity === 'error' || diagnostic.severity === 'blocker';
        const replacement = hard
          ? this.items.findLastIndex(
              ({ severity }) => severity !== 'error' && severity !== 'blocker',
            )
          : -1;
        if (replacement >= 0) {
          const replaced = this.items[replacement]!;
          this.items[replacement] = diagnostic;
          this.recordDropped(replaced);
        } else {
          this.recordDropped(diagnostic);
        }
      }
    }
  }

  private recordDropped(diagnostic: Diagnostic): void {
    this.dropped += 1;
    this.droppedBySeverity[diagnostic.severity] =
      (this.droppedBySeverity[diagnostic.severity] ?? 0) + 1;
    this.droppedByCode[diagnostic.code] = (this.droppedByCode[diagnostic.code] ?? 0) + 1;
  }

  public values(): Diagnostic[] {
    if (this.dropped === 0) return [...this.items];
    const hardDropped =
      (this.droppedBySeverity.error ?? 0) + (this.droppedBySeverity.blocker ?? 0) > 0;
    return [
      ...this.items,
      {
        code: this.truncation.code,
        severity: hardDropped ? 'blocker' : 'info',
        category: this.truncation.category,
        message: this.truncation.message,
        details: {
          retained: this.items.length,
          dropped: this.dropped,
          maximum: this.maximum,
          droppedBySeverity: this.droppedBySeverity,
          droppedByCode: this.droppedByCode,
        },
      },
    ];
  }
}
