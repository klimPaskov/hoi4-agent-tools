import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SmokeResult } from './mcp-stdio-smoke.js';

/** Collects one row per smoke call and renders the tool -> pass coverage table. */

export interface LedgerRow {
  tool: string;
  kind: 'success' | 'wrong-field' | 'rewrite' | 'job';
  label: string;
  passed: boolean;
  code: string;
  milliseconds: number;
  structuredBytes: number;
  note: string;
}

export class SmokeLedger {
  readonly rows: LedgerRow[] = [];

  record(result: SmokeResult, kind: LedgerRow['kind'], problems: string[]): LedgerRow {
    const row: LedgerRow = {
      tool: result.tool,
      kind,
      label: result.label,
      passed: problems.length === 0,
      code: result.structured.code,
      milliseconds: result.milliseconds,
      structuredBytes: result.structuredBytes,
      note: problems.join('; ').slice(0, 300),
    };
    this.rows.push(row);
    return row;
  }

  /** Tools with at least one passing row of each of the given kinds. */
  coverage(tools: readonly string[], kinds: readonly LedgerRow['kind'][]): Map<string, boolean> {
    return new Map(
      tools.map((tool) => [
        tool,
        kinds.every((kind) =>
          this.rows.some((row) => row.tool === tool && row.kind === kind && row.passed),
        ),
      ]),
    );
  }

  markdown(title: string, tools: readonly string[]): string {
    const lines = [
      `## ${title}`,
      '',
      '| Tool | Success | Wrong-field | Calls | Slowest (ms) | Largest result (bytes) |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    for (const tool of tools) {
      const rows = this.rows.filter((row) => row.tool === tool);
      const mark = (kinds: LedgerRow['kind'][]): string => {
        const relevant = rows.filter((row) => kinds.includes(row.kind));
        if (relevant.length === 0) return 'n/a';
        return relevant.every((row) => row.passed) ? 'pass' : 'FAIL';
      };
      lines.push(
        `| \`${tool}\` | ${mark(['success', 'rewrite', 'job'])} | ${mark(['wrong-field'])} | ${rows.length} | ${Math.max(0, ...rows.map((row) => row.milliseconds))} | ${Math.max(0, ...rows.map((row) => row.structuredBytes))} |`,
      );
    }
    const failures = this.rows.filter((row) => !row.passed);
    if (failures.length > 0) {
      lines.push('', 'Failures:');
      for (const row of failures) lines.push(`- ${row.tool} (${row.label}): ${row.note}`);
    }
    return `${lines.join('\n')}\n`;
  }

  async write(file: string | undefined, title: string, tools: readonly string[]): Promise<void> {
    if (file === undefined || file === '') return;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, this.markdown(title, tools));
  }
}
