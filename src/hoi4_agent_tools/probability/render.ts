import sharp from 'sharp';
import { canonicalJson, compareCodeUnits } from '../core/canonical.js';
import type { ArtifactWrite } from '../core/artifacts.js';
import type { ProbabilityAnalysisResult } from './model.js';

export type ProbabilityVisual =
  | 'ranking'
  | 'matrix'
  | 'waterfall'
  | 'timing'
  | 'sensitivity'
  | 'threshold'
  | 'sequence'
  | 'comparison'
  | 'unresolved';

export interface ProbabilityRenderBundle {
  writes: ArtifactWrite[];
  visualCount: number;
}

function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function valueFor(
  candidate: ProbabilityAnalysisResult['scenarios'][number]['candidates'][number],
): number {
  if (candidate.conditionalProbability !== undefined && candidate.conditionalProbability !== null)
    return candidate.conditionalProbability;
  if (candidate.conditionalProbabilityInterval !== undefined)
    return candidate.conditionalProbabilityInterval.high;
  if (candidate.cumulativeChance !== undefined) return candidate.cumulativeChance;
  if (candidate.cumulativeChanceInterval !== undefined)
    return candidate.cumulativeChanceInterval.high;
  if (candidate.effectiveMtthDays !== undefined) return candidate.effectiveMtthDays;
  if (typeof candidate.rawValue === 'object' && candidate.rawValue !== null)
    return candidate.rawValue.value;
  return candidate.rawInterval?.max ?? 0;
}

function frame(
  title: string,
  subtitle: string,
  width: number,
  height: number,
  content: string,
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}"><rect width="100%" height="100%" fill="#0d1721"/><text x="28" y="38" fill="#f1f5f8" font-family="Arial,sans-serif" font-size="22" font-weight="700">${escapeXml(title)}</text><text x="28" y="61" fill="#9fb3c8" font-family="Arial,sans-serif" font-size="12">${escapeXml(subtitle)}</text>${content}</svg>`;
}

function ranking(result: ProbabilityAnalysisResult): string {
  const scenario = result.scenarios[0];
  const allRows = [...(scenario?.candidates ?? [])].sort(
    (left, right) => valueFor(right) - valueFor(left) || compareCodeUnits(left.id, right.id),
  );
  const rows = allRows.slice(0, 100);
  const maximum = Math.max(...rows.map(valueFor), 1e-12);
  const width = 1_100;
  const rowHeight = 28;
  const height = Math.max(150, 95 + rows.length * rowHeight);
  const content = rows
    .map((candidate, index) => {
      const value = valueFor(candidate);
      const bar = (value / maximum) * 610;
      const y = 86 + index * rowHeight;
      const label =
        candidate.conditionalProbability === null || candidate.conditionalProbability === undefined
          ? value.toPrecision(6)
          : `${(value * 100).toFixed(3)}%`;
      return `<text x="28" y="${y + 16}" fill="#dce7ef" font-family="Arial,sans-serif" font-size="12">${escapeXml(candidate.id)}</text><rect x="360" y="${y}" width="${bar.toFixed(3)}" height="19" rx="3" fill="#4ca7d8"/><text x="${Math.min(1040, 370 + bar)}" y="${y + 15}" fill="#f1f5f8" font-family="Arial,sans-serif" font-size="11">${escapeXml(label)}</text>`;
    })
    .join('');
  return frame(
    `Ranking — ${scenario?.id ?? 'no scenario'}`,
    `${result.adapter.id} · ${result.analysisId} · showing ${rows.length} of ${allRows.length}`,
    width,
    height,
    content,
  );
}

function matrix(result: ProbabilityAnalysisResult): string {
  const candidateIds = [
    ...new Set(result.scenarios.flatMap(({ candidates }) => candidates.map(({ id }) => id))),
  ].slice(0, 100);
  const scenarios = result.scenarios.slice(0, 250);
  const cellWidth = Math.max(18, Math.min(80, 800 / Math.max(1, candidateIds.length)));
  const cellHeight = 25;
  const width = Math.max(700, 260 + candidateIds.length * cellWidth);
  const height = Math.max(180, 115 + scenarios.length * cellHeight);
  const usesProbability = scenarios.some(({ candidates }) =>
    candidates.some(
      ({ conditionalProbability }) =>
        conditionalProbability !== undefined && conditionalProbability !== null,
    ),
  );
  const maximumRawValue = Math.max(
    ...scenarios.flatMap(({ candidates }) => candidates.map(valueFor)),
    1e-12,
  );
  const cells = scenarios
    .flatMap((scenario, row) =>
      candidateIds.map((candidateId, column) => {
        const candidate = scenario.candidates.find(({ id }) => id === candidateId);
        const value = candidate === undefined ? 0 : valueFor(candidate);
        const normalized = Math.max(
          0,
          Math.min(
            1,
            usesProbability ? (candidate?.conditionalProbability ?? 0) : value / maximumRawValue,
          ),
        );
        const blue = Math.round(70 + normalized * 160);
        return `<rect x="${250 + column * cellWidth}" y="${90 + row * cellHeight}" width="${Math.max(1, cellWidth - 1)}" height="${cellHeight - 1}" fill="rgb(30,${Math.round(75 + normalized * 90)},${blue})"><title>${escapeXml(`${scenario.id} / ${candidateId}: ${value}`)}</title></rect>`;
      }),
    )
    .join('');
  const labels = scenarios
    .map(
      ({ id }, row) =>
        `<text x="242" y="${107 + row * cellHeight}" text-anchor="end" fill="#dce7ef" font-family="Arial,sans-serif" font-size="11">${escapeXml(id)}</text>`,
    )
    .join('');
  const columns = candidateIds
    .map(
      (id, column) =>
        `<text transform="translate(${263 + column * cellWidth},82) rotate(-45)" fill="#9fb3c8" font-family="Arial,sans-serif" font-size="9">${escapeXml(id)}</text>`,
    )
    .join('');
  return frame(
    'Scenario matrix',
    `${scenarios.length} scenarios · ${candidateIds.length} candidates`,
    width,
    height,
    `${cells}${labels}${columns}`,
  );
}

function waterfall(result: ProbabilityAnalysisResult): string {
  const candidate = result.scenarios[0]?.candidates[0];
  const trace = candidate?.trace ?? [];
  const width = 1_200;
  const height = Math.max(180, 110 + trace.length * 34);
  const rows = trace
    .map((step, index) => {
      const y = 91 + index * 34;
      const after = step.after?.decimal ?? 'bounded/unresolved';
      return `<circle cx="45" cy="${y}" r="7" fill="${step.applied === 'true' ? '#56c596' : step.applied === 'false' ? '#667788' : '#f2b84b'}"/><line x1="52" y1="${y}" x2="82" y2="${y}" stroke="#526778"/><text x="92" y="${y + 4}" fill="#dce7ef" font-family="Arial,sans-serif" font-size="12">${escapeXml(`${step.operation}: ${step.expression}`)}</text><text x="860" y="${y + 4}" fill="#9fd6f2" font-family="Arial,sans-serif" font-size="12">${escapeXml(after)}</text>`;
    })
    .join('');
  return frame(
    `Modifier trace — ${candidate?.id ?? 'no candidate'}`,
    result.scenarios[0]?.id ?? '',
    width,
    height,
    rows,
  );
}

function timing(result: ProbabilityAnalysisResult): string {
  const rows = result.scenarios
    .flatMap((scenario) =>
      scenario.candidates
        .filter(({ effectiveMtthDays }) => effectiveMtthDays !== undefined)
        .map((candidate) => ({ scenario, candidate })),
    )
    .slice(0, 12);
  const width = 1_200;
  const height = 680;
  const left = 90;
  const top = 95;
  const graphWidth = 820;
  const graphHeight = 500;
  const horizon = Math.max(
    ...rows.map(({ scenario, candidate }) =>
      Math.max(
        scenario.horizonDays ?? 0,
        candidate.timingQuantilesDays?.p95 ?? 0,
        (candidate.effectiveMtthDays ?? 1) * 4,
      ),
    ),
    1,
  );
  const colors = ['#7d69d8', '#4ca7d8', '#56c596', '#e2856e', '#d0a851', '#d879aa'];
  const hazardAt = (
    row: (typeof rows)[number],
    day: number,
    bound: 'minimum' | 'maximum',
  ): number => {
    const intervals = row.scenario.timingIntervals;
    if (intervals === undefined || intervals.length === 0)
      return day / Math.max(Number.MIN_VALUE, row.candidate.effectiveMtthDays ?? horizon);
    return intervals.reduce((sum, interval) => {
      const elapsed = Math.max(0, Math.min(day, interval.endDay) - interval.startDay);
      const duration = interval.endDay - interval.startDay;
      if (elapsed <= 0 || duration <= 0) return sum;
      const contribution =
        bound === 'minimum'
          ? interval.minimumHazardContribution
          : interval.maximumHazardContribution;
      return sum + contribution * (elapsed / duration);
    }, 0);
  };
  const curves = rows
    .map((row, index) => {
      const color = colors[index % colors.length]!;
      const points = Array.from({ length: 101 }, (_, point) => (horizon * point) / 100);
      const path = (bound: 'minimum' | 'maximum') =>
        points
          .map((day, point) => {
            const survival = 2 ** -hazardAt(row, day, bound);
            const x = left + (day / horizon) * graphWidth;
            const y = top + (1 - survival) * graphHeight;
            return `${point === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
          })
          .join(' ');
      const label = `${row.scenario.id} / ${row.candidate.id}`;
      return `<path d="${path('minimum')}" fill="none" stroke="${color}" stroke-width="2"><title>${escapeXml(`${label} upper survival`)}</title></path><path d="${path('maximum')}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="5 4"><title>${escapeXml(`${label} lower survival`)}</title></path><rect x="940" y="${100 + index * 35}" width="16" height="4" fill="${color}"/><text x="966" y="${106 + index * 35}" fill="#dce7ef" font-family="Arial,sans-serif" font-size="10">${escapeXml(label)}</text>`;
    })
    .join('');
  const axes = `<rect x="${left}" y="${top}" width="${graphWidth}" height="${graphHeight}" fill="#111f2a" stroke="#526778"/><text x="${left}" y="${top + graphHeight + 28}" fill="#9fb3c8" font-family="Arial,sans-serif" font-size="11">0 days</text><text x="${left + graphWidth}" y="${top + graphHeight + 28}" text-anchor="end" fill="#9fb3c8" font-family="Arial,sans-serif" font-size="11">${escapeXml(`${horizon.toFixed(1)} days`)}</text><text x="${left - 14}" y="${top + 4}" text-anchor="end" fill="#9fb3c8" font-family="Arial,sans-serif" font-size="11">100% survival</text><text x="${left - 14}" y="${top + graphHeight}" text-anchor="end" fill="#9fb3c8" font-family="Arial,sans-serif" font-size="11">0%</text>`;
  return frame(
    'MTTH survival curves',
    `${result.adapter.gameVersion} · solid upper survival, dashed lower survival`,
    width,
    height,
    `${axes}${curves}`,
  );
}

function sensitivity(result: ProbabilityAnalysisResult): string {
  const points = result.sweep?.points ?? [];
  const width = 1_100;
  const height = 620;
  const left = 80;
  const top = 90;
  const graphWidth = 940;
  const graphHeight = 470;
  const values = points.map(({ value }) => value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const candidateIds = [
    ...new Set(points.flatMap(({ candidates }) => candidates.map(({ id }) => id))),
  ].slice(0, 12);
  const plottedValues = points.flatMap(({ candidates }) =>
    candidates.flatMap(({ conditionalProbability, rawValue }) => {
      const value = conditionalProbability ?? rawValue;
      return value === undefined ? [] : [value];
    }),
  );
  const minimumY = Math.min(...plottedValues, 0);
  const maximumY = Math.max(...plottedValues, 1e-12);
  const ySpan = Math.max(1e-12, maximumY - minimumY);
  const colors = [
    '#4ca7d8',
    '#e2856e',
    '#71c78a',
    '#d0a851',
    '#9d82da',
    '#63c5ba',
    '#d879aa',
    '#92a8c8',
  ];
  const lines = candidateIds
    .map((id, colorIndex) => {
      const candidatePoints = points
        .map((item) => ({
          x: item.value,
          y:
            item.candidates.find((candidate) => candidate.id === id)?.conditionalProbability ??
            item.candidates.find((candidate) => candidate.id === id)?.rawValue ??
            0,
        }))
        .sort((a, b) => a.x - b.x);
      const path = candidatePoints
        .map(
          ({ x, y }, index) =>
            `${index === 0 ? 'M' : 'L'} ${(left + ((x - min) / Math.max(1e-12, max - min)) * graphWidth).toFixed(2)} ${(top + graphHeight - ((y - minimumY) / ySpan) * graphHeight).toFixed(2)}`,
        )
        .join(' ');
      return `<path d="${path}" fill="none" stroke="${colors[colorIndex % colors.length]}" stroke-width="2"><title>${escapeXml(id)}</title></path>`;
    })
    .join('');
  return frame(
    'Sensitivity sweep',
    `${points.length} evaluated points · y ${minimumY.toPrecision(4)}–${maximumY.toPrecision(4)}`,
    width,
    height,
    `<rect x="${left}" y="${top}" width="${graphWidth}" height="${graphHeight}" fill="#111f2a" stroke="#526778"/>${lines}`,
  );
}

function thresholdMap(result: ProbabilityAnalysisResult): string {
  const reversals = result.sweep?.rankReversals ?? [];
  const observations = result.diagnostics.filter(({ code }) =>
    /(?:THRESHOLD|ACCEPTANCE_BAND|DOMINANT|STARVED|UNREACHABLE|UNEXPECTEDLY_COMMON)/u.test(code),
  );
  const rows = [
    ...reversals.map((reversal) => ({
      label: `${reversal.scenarioId} / ${reversal.path}`,
      detail: `${reversal.beforeLeader} -> ${reversal.afterLeader} between ${reversal.between[0]} and ${reversal.between[1]}`,
      color: '#d0a851',
    })),
    ...observations.map((diagnostic) => ({
      label: diagnostic.code,
      detail: diagnostic.message,
      color:
        diagnostic.severity === 'error' || diagnostic.severity === 'blocker'
          ? '#e2856e'
          : '#f2b84b',
    })),
  ].slice(0, 500);
  const width = 1_300;
  const height = Math.max(180, 110 + rows.length * 34);
  const content = rows
    .map(
      ({ label, detail, color }, index) =>
        `<rect x="28" y="${82 + index * 34}" width="8" height="22" fill="${color}"/><text x="48" y="${98 + index * 34}" fill="#dce7ef" font-family="Arial,sans-serif" font-size="11">${escapeXml(label)}</text><text x="430" y="${98 + index * 34}" fill="#9fb3c8" font-family="Arial,sans-serif" font-size="11">${escapeXml(detail.slice(0, 135))}</text>`,
    )
    .join('');
  return frame(
    'Threshold map',
    `${reversals.length} rank reversals and ${observations.length} threshold observations`,
    width,
    height,
    content,
  );
}

function sequence(result: ProbabilityAnalysisResult): string {
  const summary = result.sequence;
  const rows = summary?.candidates ?? [];
  const maximum = Math.max(...rows.map(({ expectedSelections }) => expectedSelections), 1e-12);
  const width = 1_100;
  const height = Math.max(180, 120 + rows.length * 36);
  const content = rows
    .map((candidate, index) => {
      const y = 95 + index * 36;
      const bar = (candidate.expectedSelections / maximum) * 600;
      return `<text x="28" y="${y + 15}" fill="#dce7ef" font-family="Arial,sans-serif" font-size="12">${escapeXml(candidate.id)}</text><rect x="350" y="${y}" width="${bar.toFixed(3)}" height="20" fill="#56c596"/><text x="${Math.min(1010, 362 + bar)}" y="${y + 15}" fill="#f1f5f8" font-family="Arial,sans-serif" font-size="11">${escapeXml(`${candidate.expectedSelections.toFixed(4)} selections · ${(candidate.everSelectedProbability * 100).toFixed(2)}% ever`)}</text>`;
    })
    .join('');
  return frame(
    'Declared pool sequence',
    summary === undefined ? 'no sequence' : `${summary.method} · ${summary.steps} steps`,
    width,
    height,
    content,
  );
}

function comparison(result: ProbabilityAnalysisResult): string {
  const rows = result.comparison?.scenarioChanges ?? [];
  const width = 1_200;
  const height = Math.max(180, 110 + rows.length * 31);
  const content = rows
    .slice(0, 250)
    .map((change, index) => {
      const y = 91 + index * 31;
      const delta = change.probabilityDelta ?? change.rawDelta ?? 0;
      const x = 700;
      const bar = Math.min(350, Math.abs(delta) * 350);
      return `<text x="28" y="${y + 13}" fill="#dce7ef" font-family="Arial,sans-serif" font-size="11">${escapeXml(`${change.scenarioId} / ${change.candidateId}`)}</text><line x1="${x}" y1="${y + 10}" x2="${x + (delta >= 0 ? bar : -bar)}" y2="${y + 10}" stroke="${delta >= 0 ? '#56c596' : '#e2856e'}" stroke-width="12"/><text x="1070" y="${y + 13}" fill="#f1f5f8" font-family="Arial,sans-serif" font-size="11">${escapeXml(delta.toPrecision(5))}</text>`;
    })
    .join('');
  return frame(
    'Before/after comparison',
    `${rows.length} attributed candidate changes`,
    width,
    height,
    content,
  );
}

function unresolved(result: ProbabilityAnalysisResult): string {
  const rows = result.unresolved.slice(0, 250);
  const width = 1_200;
  const height = Math.max(180, 105 + rows.length * 34);
  const content = rows
    .map(
      (item, index) =>
        `<text x="28" y="${95 + index * 34}" fill="#f2b84b" font-family="Arial,sans-serif" font-size="11">${escapeXml(item.code)}</text><text x="280" y="${95 + index * 34}" fill="#dce7ef" font-family="Arial,sans-serif" font-size="11">${escapeXml(item.message.slice(0, 130))}</text>`,
    )
    .join('');
  return frame(
    'Unresolved analysis',
    `${result.unresolved.length} explicit uncertainties`,
    width,
    height,
    content,
  );
}

function svgFor(result: ProbabilityAnalysisResult, visual: ProbabilityVisual): string {
  if (visual === 'ranking') return ranking(result);
  if (visual === 'matrix') return matrix(result);
  if (visual === 'waterfall') return waterfall(result);
  if (visual === 'timing') return timing(result);
  if (visual === 'sensitivity') return sensitivity(result);
  if (visual === 'threshold') return thresholdMap(result);
  if (visual === 'sequence') return sequence(result);
  if (visual === 'comparison') return comparison(result);
  return unresolved(result);
}

export async function renderProbabilityResult(
  result: ProbabilityAnalysisResult,
  visuals: readonly ProbabilityVisual[],
  includeHtml: boolean,
  provenance: ArtifactWrite['provenance'],
  signal?: AbortSignal,
): Promise<ProbabilityRenderBundle> {
  const writes: ArtifactWrite[] = [];
  for (const visual of [...new Set(visuals)]) {
    signal?.throwIfAborted();
    const svg = svgFor(result, visual);
    const prefix = `probability-${result.analysisId}-${visual}`;
    writes.push({
      name: `${prefix}.svg`,
      mimeType: 'image/svg+xml',
      content: svg,
      provenance,
      description: `AI and MTTH ${visual} visualization`,
    });
    const png = await sharp(Buffer.from(svg, 'utf8'), { limitInputPixels: 268_402_689 })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    writes.push({
      name: `${prefix}.png`,
      mimeType: 'image/png',
      content: png,
      provenance,
      description: `AI and MTTH ${visual} raster visualization`,
    });
    if (includeHtml) {
      const json = canonicalJson(result);
      writes.push({
        name: `${prefix}.html`,
        mimeType: 'text/html',
        content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeXml(visual)}</title><style>html,body{margin:0;background:#0d1721;color:#f1f5f8;font-family:system-ui,sans-serif}main{padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><main>${svg}<details><summary>Authoritative JSON</summary><pre>${escapeXml(json)}</pre></details></main></body></html>`,
        provenance,
        description: `AI and MTTH ${visual} static report`,
      });
    }
  }
  return { writes, visualCount: visuals.length };
}
