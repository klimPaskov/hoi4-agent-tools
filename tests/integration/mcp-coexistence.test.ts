import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceScanner } from '../../src/hoi4_agent_tools/core/scanner.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

afterEach(async () => {
  for (const callback of cleanup.splice(0).reverse()) await callback();
});

async function treeSnapshot(root: string, current = root): Promise<Record<string, string>> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files: Array<[string, string]> = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...Object.entries(await treeSnapshot(root, absolute)));
    } else if (entry.isFile()) {
      files.push([
        path.relative(root, absolute).replaceAll('\\', '/'),
        (await readFile(absolute)).toString('base64'),
      ]);
    }
  }
  return Object.fromEntries(files.sort(([left], [right]) => left.localeCompare(right, 'en-US')));
}

async function typescriptSource(current: string): Promise<string> {
  const entries = await readdir(current, { withFileTypes: true });
  const chunks: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) chunks.push(await typescriptSource(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts'))
      chunks.push(await readFile(absolute, 'utf8'));
  }
  return chunks.join('\n');
}

describe('MCP coding-agent coexistence', () => {
  it('advertises bounded tool guidance without prompts, task ownership, or host-specific coupling', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-coexistence-surface-'));
    const mod = path.join(temporary, 'mod');
    const runtime = path.join(temporary, 'runtime');
    await Promise.all([mkdir(mod), mkdir(runtime)]);
    cleanup.push(async () => rm(temporary, { recursive: true, force: true }));

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'server-state'),
      storageRoots: [runtime],
      workspaces: [
        {
          id: 'coexistence',
          name: 'Coexistence fixture',
          root: mod,
          artifactRoot: path.join(runtime, 'artifacts'),
          cacheRoot: path.join(runtime, 'cache'),
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    const server = createMcpServer(engine);
    const client = new Client({ name: 'coexistence-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
    );

    const tools = (await client.listTools()).tools;
    const ownershipClaim =
      /\b(?:take|assume|claim)\s+(?:full\s+)?ownership\b|\b(?:complete|finish|manage)\s+(?:the|your)\s+(?:task|project)\b|\bdo not stop\b/iu;
    for (const tool of tools) {
      expect(tool.description?.length ?? 0, tool.name).toBeLessThanOrEqual(600);
      expect(tool.description ?? '', tool.name).not.toMatch(ownershipClaim);
      expect(tool.description ?? '', tool.name).not.toMatch(/AGENTS\.md|SKILL\.md|subagents?/iu);
    }
    const instructions = client.getInstructions() ?? '';
    expect(instructions.length).toBeLessThanOrEqual(1_200);
    expect(instructions).not.toMatch(ownershipClaim);
    expect(instructions).not.toMatch(/AGENTS\.md|SKILL\.md|subagents?/iu);
    await expect(client.listPrompts()).rejects.toThrow(/Method not found/iu);

    const runtimeSource = await typescriptSource(path.join(repositoryRoot, 'src'));
    expect(runtimeSource).not.toMatch(/chaos[_ -]?redux/iu);
    expect(runtimeSource).not.toContain('SKILL.md');
    expect(runtimeSource).not.toMatch(/(?:^|[\\/])\.agents(?:[\\/]|$)/u);
  });

  it('leaves host workflow files untouched and scans source only after an explicit domain call', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-coexistence-files-'));
    const mod = path.join(temporary, 'mod');
    const runtime = path.join(temporary, 'runtime');
    const guiRelativePath = 'interface/coexistence.gui';
    const hostFiles: Record<string, string> = {
      'AGENTS.md': '# Host repository policy\nHOST_POLICY_SENTINEL\n',
      '.agents/skills/host-review/SKILL.md': '# Host skill\nHOST_SKILL_SENTINEL\n',
      '.agents/subagents/auditor.md': '# Host subagent\nHOST_SUBAGENT_SENTINEL\n',
      'docs/plans/active-plan.md': '# Host plan\nHOST_PLAN_SENTINEL\n',
      [guiRelativePath]: [
        'guiTypes = {',
        '\tcontainerWindowType = {',
        '\t\tname = "coexistence_window"',
        '\t\tposition = { x = 0 y = 0 }',
        '\t\tsize = { width = 100 height = 100 }',
        '\t}',
        '}',
        '',
      ].join('\n'),
    };
    await mkdir(runtime, { recursive: true });
    for (const [relativePath, contents] of Object.entries(hostFiles)) {
      const absolute = path.join(mod, ...relativePath.split('/'));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, 'utf8');
    }
    cleanup.push(async () => rm(temporary, { recursive: true, force: true }));
    const sourceBefore = await treeSnapshot(mod);

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'server-state'),
      storageRoots: [runtime],
      workspaces: [
        {
          id: 'coexistence',
          name: 'Coexistence fixture',
          root: mod,
          artifactRoot: path.join(runtime, 'artifacts'),
          cacheRoot: path.join(runtime, 'cache'),
        },
      ],
    });
    const scanner = new WorkspaceScanner();
    const scan = vi.spyOn(scanner, 'scan');
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration), { scanner });
    await engine.initialize();
    expect(scan).not.toHaveBeenCalled();
    expect(await treeSnapshot(mod)).toEqual(sourceBefore);
    const generatedBeforeDiscovery = await treeSnapshot(runtime);

    const server = createMcpServer(engine);
    const client = new Client({ name: 'coexistence-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
    );

    await client.listTools();
    await client.listResourceTemplates();
    expect(scan).not.toHaveBeenCalled();
    expect(await treeSnapshot(mod)).toEqual(sourceBefore);
    expect(await treeSnapshot(runtime)).toEqual(generatedBeforeDiscovery);

    const inspected = await client.callTool({
      name: 'hoi4.gui_inspect',
      arguments: { workspaceId: 'coexistence' },
    });
    const result = inspected.structuredContent as {
      status: string;
      changedFiles: string[];
      filesScanned: string[];
    };
    expect(result.status).toBe('ok');
    expect(result.changedFiles).toEqual([]);
    expect(scan).toHaveBeenCalled();
    expect(JSON.stringify(result.filesScanned)).not.toMatch(
      /AGENTS\.md|SKILL\.md|active-plan|auditor\.md/iu,
    );
    expect(await treeSnapshot(mod)).toEqual(sourceBefore);
    expect(await treeSnapshot(runtime)).not.toEqual(generatedBeforeDiscovery);
  });
});
