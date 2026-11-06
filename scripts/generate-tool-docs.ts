import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { listDefaultTools, renderToolDocs, TOOL_DOCS_PATH } from './tool-docs.js';

// npm run docs:tools rewrites the generated parts of docs/tools.md; --check only reports drift.
const current = await readFile(TOOL_DOCS_PATH, 'utf8');
const next = await renderToolDocs(current, await listDefaultTools());
if (process.argv.includes('--check')) {
  if (next !== current) {
    process.stderr.write('docs/tools.md is stale. Run npm run docs:tools.\n');
    process.exit(1);
  }
  process.stderr.write('docs/tools.md matches tools/list.\n');
} else {
  await writeFile(TOOL_DOCS_PATH, next);
  process.stderr.write('Wrote docs/tools.md from tools/list.\n');
}
process.exit(0);
