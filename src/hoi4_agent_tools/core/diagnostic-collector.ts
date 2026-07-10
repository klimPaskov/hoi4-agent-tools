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
        this.dropped += 1;
        if (
          diagnostic.severity === 'blocker' &&
          !this.items.some(
            ({ code, severity }) => code === diagnostic.code && severity === 'blocker',
          )
        ) {
          const replacement = this.items.findLastIndex(({ severity }) => severity !== 'blocker');
          if (replacement >= 0) this.items[replacement] = diagnostic;
        }
      }
    }
  }

  public values(): Diagnostic[] {
    if (this.dropped === 0) return [...this.items];
    return [
      ...this.items,
      {
        code: this.truncation.code,
        severity: 'blocker',
        category: this.truncation.category,
        message: this.truncation.message,
        details: { retained: this.items.length, dropped: this.dropped, maximum: this.maximum },
      },
    ];
  }
}
