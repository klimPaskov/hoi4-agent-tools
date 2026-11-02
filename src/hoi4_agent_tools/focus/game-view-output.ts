import sharp from 'sharp';
import {
  ArtifactStore,
  boundedSourceHashEvidence,
  type ArtifactWrite,
  type StoredArtifact,
} from '../core/artifacts.js';
import { canonicalJson, sha256Bytes } from '../core/canonical.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import { PACKAGE_VERSION } from '../version.js';
import type { FocusGameViewReport } from './game-render.js';
import type { FocusLayoutResult, FocusTreePlan } from './model.js';

/**
 * Artifacts of the game view alone (`view: "game"`): the PNG, a JSON report, an SVG hover map
 * on the same pixels and a self-contained HTML viewer with zoom and hover titles. No schematic is
 * drawn, so this is the fast path an in-app preview calls on every edit.
 */

const artifacts = new ArtifactStore();
/** Longest edge of the inline overview. */
const INLINE_EDGE = 1500;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function safeStem(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/^[_-]+/u, '')
    .slice(0, 80);
  return safe.length === 0 ? 'focus-tree' : safe;
}

export interface GameViewBundle {
  png: Buffer;
  svg: string;
  html: string;
  json: string;
  hashes: { html: string; svg: string; png: string; json: string };
  inline: { png: Buffer; width: number; height: number };
}

export async function gameViewBundle(
  plan: FocusTreePlan,
  layout: FocusLayoutResult,
  png: Buffer,
  report: FocusGameViewReport,
  titles: Record<string, { text: string; resolved: boolean }>,
): Promise<GameViewBundle> {
  const boxes = report.focuses
    .map((box) => {
      const title = titles[box.id]?.text ?? box.id;
      return `<rect class="focus" data-focus-id="${escapeXml(box.id)}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"><title>${escapeXml(`${title} (${box.id})`)}</title></rect>`;
    })
    .join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${report.width}" height="${report.height}" viewBox="0 0 ${report.width} ${report.height}" role="img" aria-label="${escapeXml(plan.id)} focus tree, game view hover map">
<style>.focus{fill:transparent;stroke:none}.focus:hover{stroke:#66d9ef;stroke-width:2}</style>
${boxes}
</svg>
`;
  const json = `${canonicalJson({
    schemaVersion: 1,
    view: 'game',
    tree: {
      id: plan.id,
      sourcePath: plan.provenance.sourcePath,
      sourceHash: plan.provenance.sourceHash,
      focusCount: plan.focuses.length,
    },
    layout: { hash: layout.layoutHash, nodes: layout.nodes.map(({ id, x, y }) => ({ id, x, y })) },
    render: report,
    titles,
  })}\n`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeXml(plan.id)} focus tree · game view · HOI4 Agent Tools</title>
<style>
html,body{margin:0;height:100%;background:#111;color:#ddd;font-family:system-ui,sans-serif}
#view{position:absolute;inset:0;overflow:hidden;cursor:grab}
#stage{position:absolute;transform-origin:0 0}
#stage img,#stage svg{position:absolute;left:0;top:0;display:block}
#note{position:fixed;left:8px;bottom:8px;font-size:12px;background:#000a;padding:4px 8px;border-radius:4px}
</style>
</head>
<body>
<div id="view"><div id="stage"><img alt="${escapeXml(plan.id)} focus tree as the game draws it" width="${report.width}" height="${report.height}" src="data:image/png;base64,${png.toString('base64')}">${svg}</div></div>
<div id="note">${escapeXml(plan.id)} · ${plan.focuses.length} focuses · wheel to zoom, drag to move, hover for titles. Tool render, not a game screenshot.</div>
<script>
const view=document.getElementById('view'),stage=document.getElementById('stage');
let scale=Math.min(1,view.clientWidth/${report.width}),x=0,y=0,drag;
const apply=()=>{stage.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')'};
view.addEventListener('wheel',(e)=>{e.preventDefault();const k=Math.exp(-e.deltaY*0.0015),n=Math.min(8,Math.max(0.05,scale*k));x=e.clientX-(e.clientX-x)*n/scale;y=e.clientY-(e.clientY-y)*n/scale;scale=n;apply()},{passive:false});
view.addEventListener('pointerdown',(e)=>{drag=[e.clientX-x,e.clientY-y];view.setPointerCapture(e.pointerId)});
view.addEventListener('pointermove',(e)=>{if(drag){x=e.clientX-drag[0];y=e.clientY-drag[1];apply()}});
view.addEventListener('pointerup',()=>{drag=undefined});
apply();
</script>
</body>
</html>
`;
  const fit = Math.min(1, INLINE_EDGE / Math.max(report.width, report.height));
  const inlinePng =
    fit >= 1
      ? png
      : await sharp(png)
          .resize(
            Math.max(1, Math.round(report.width * fit)),
            Math.max(1, Math.round(report.height * fit)),
            { fit: 'fill', kernel: sharp.kernel.lanczos3 },
          )
          .png({ compressionLevel: 6 })
          .toBuffer();
  return {
    png,
    svg,
    html,
    json,
    hashes: {
      html: sha256Bytes(html),
      svg: sha256Bytes(svg),
      png: sha256Bytes(png),
      json: sha256Bytes(json),
    },
    inline: {
      png: inlinePng,
      width: Math.max(1, Math.round(report.width * fit)),
      height: Math.max(1, Math.round(report.height * fit)),
    },
  };
}

export async function storeGameViewArtifacts(
  workspace: ResolvedWorkspace,
  plan: FocusTreePlan,
  bundle: GameViewBundle,
  renderProfile: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<StoredArtifact[]> {
  const stem = safeStem(plan.id);
  const sourceEvidence = boundedSourceHashEvidence({
    [plan.provenance.sourcePath]: plan.provenance.sourceHash,
  });
  const provenance = {
    toolVersion: PACKAGE_VERSION,
    schemaVersion: 'focus-render.v1',
    sourceHashes: sourceEvidence.sourceHashes,
    renderProfile: { renderer: 'hoi4-engine game view', ...renderProfile },
    metadata: { sourceHashInventory: sourceEvidence.inventory },
  };
  const writes: ArtifactWrite[] = [
    {
      name: `${stem}.focus.png`,
      mimeType: 'image/png',
      content: bundle.png,
      provenance: { ...provenance, kind: 'focus-png' },
    },
    {
      name: `${stem}.focus.json`,
      mimeType: 'application/json',
      content: bundle.json,
      provenance: { ...provenance, kind: 'focus-json' },
    },
    {
      name: `${stem}.focus.svg`,
      mimeType: 'image/svg+xml',
      content: bundle.svg,
      provenance: { ...provenance, kind: 'focus-svg' },
      description: 'Hover map of the game view: one titled box per focus, on the PNG pixels',
    },
    {
      name: `${stem}.focus.html`,
      mimeType: 'text/html',
      content: bundle.html,
      provenance: { ...provenance, kind: 'focus-html' },
      description: 'The game view with zoom, pan and hover titles',
    },
  ];
  return artifacts.withAtomicChunkedWrites(
    workspace,
    writes,
    (stored) => Promise.resolve([...stored]),
    signal,
  );
}
