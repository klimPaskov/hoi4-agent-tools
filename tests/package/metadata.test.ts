import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  GENERATED_SCHEMA_FILES,
  PACKAGE_BIN_TARGETS,
  REQUIRED_PACKAGE_FILES,
} from '../../scripts/distribution/package-fixture.js';
import { focusTreePlanSchema } from '../../src/hoi4_agent_tools/schemas/focus.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');

interface PackageJson {
  bin: Record<string, string>;
  engines: { node: string };
  exports: Record<string, unknown>;
  files: string[];
  mcpName: string;
  name: string;
  publishConfig: { access: string; provenance: boolean };
  version: string;
}

interface PackageLock {
  name: string;
  packages: Record<string, { name?: string; version?: string }>;
  version: string;
}

interface ServerJson {
  $schema: string;
  description: string;
  name: string;
  packages: {
    environmentVariables?: {
      name: string;
      description: string;
      format: string;
      isRequired: boolean;
      isSecret?: boolean;
      placeholder: string;
    }[];
    identifier: string;
    registryType: string;
    transport: { type: string };
    version: string;
  }[];
  repository: { source: string; url: string };
  title: string;
  version: string;
  websiteUrl: string;
}

async function json<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(path.join(projectRoot, relative), 'utf8')) as T;
}

async function sourceFiles(current: string): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(absolute)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
  }
  return files.sort();
}

describe('offline package and Registry metadata', () => {
  it('ships a schema-valid new focus-tree authoring example', async () => {
    const workflow = await readFile(path.join(projectRoot, 'docs', 'focus-workflow.md'), 'utf8');
    const example = /This minimal national plan[\s\S]*?```json\r?\n([\s\S]*?)\r?\n```/u.exec(
      workflow,
    )?.[1];
    expect(example).toBeDefined();
    const plan = focusTreePlanSchema.parse(JSON.parse(example ?? ''));
    expect(plan.provenance).toEqual({
      sourcePath: 'plan:example_tree',
      sourceHash: '0'.repeat(64),
      importedPlanHash: '0'.repeat(64),
    });
  });

  it('keeps package, Registry, source, schemas, README, lock, and changelog versions aligned', async () => {
    const packageJson = await json<PackageJson>('package.json');
    const packageLock = await json<PackageLock>('package-lock.json');
    const server = await json<ServerJson>('server.json');
    const versionSource = await readFile(
      path.join(projectRoot, 'src', 'hoi4_agent_tools', 'version.ts'),
      'utf8',
    );
    const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
    const changelog = await readFile(path.join(projectRoot, 'CHANGELOG.md'), 'utf8');
    const version = packageJson.version;

    expect(version).toMatch(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
    expect(packageLock.name).toBe(packageJson.name);
    expect(packageLock.version).toBe(version);
    expect(packageLock.packages['']).toMatchObject({ name: packageJson.name, version });
    expect(server.version).toBe(version);
    expect(server.packages).toContainEqual(expect.objectContaining({ version }));
    expect(versionSource).toContain(`export const PACKAGE_VERSION = '${version}';`);
    expect(changelog).toContain(`## [${version}]`);

    const documentedVersions = [...readme.matchAll(/hoi4-agent-tools@(\d+\.\d+\.\d+)/gu)].map(
      ([, documented]) => documented,
    );
    expect(documentedVersions.length).toBeGreaterThan(0);
    expect(new Set(documentedVersions)).toEqual(new Set([version]));

    for (const fileName of GENERATED_SCHEMA_FILES) {
      const filePath = path.join(projectRoot, 'schemas', fileName);
      const contents = await readFile(filePath, 'utf8');
      const schema = JSON.parse(contents) as { $id: string; $schema: string };
      expect(schema.$id).toBe(
        `https://github.com/klimPaskov/hoi4-agent-tools/blob/v${version}/schemas/${fileName}`,
      );
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(contents).toBe(`${JSON.stringify(schema, null, 2)}\n`);
    }

    const hardcodedToolVersions: string[] = [];
    for (const filePath of await sourceFiles(path.join(projectRoot, 'src'))) {
      const contents = await readFile(filePath, 'utf8');
      for (const match of contents.matchAll(/toolVersion:\s*'(\d+\.\d+\.\d+)'/gu)) {
        const toolVersion = match[1];
        if (toolVersion !== undefined) hardcodedToolVersions.push(toolVersion);
      }
    }
    expect(hardcodedToolVersions).toEqual([]);
  });

  it('has deterministic offline Registry metadata for the npm stdio package', async () => {
    const packageJson = await json<PackageJson>('package.json');
    const serverText = await readFile(path.join(projectRoot, 'server.json'), 'utf8');
    const server = JSON.parse(serverText) as ServerJson;

    expect(server).toEqual({
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name: packageJson.mcpName,
      title: 'HOI4 Agent Tools',
      description:
        'Agent-first HOI4 focus, scripted GUI, and map tools with workspace-authorized autonomous rewrites.',
      version: packageJson.version,
      repository: {
        url: 'https://github.com/klimPaskov/hoi4-agent-tools',
        source: 'github',
      },
      websiteUrl: 'https://github.com/klimPaskov/hoi4-agent-tools#readme',
      packages: [
        {
          registryType: 'npm',
          identifier: packageJson.name,
          version: packageJson.version,
          environmentVariables: [
            {
              name: 'HOI4_AGENT_CONFIG',
              description:
                'Absolute path to a persistent allowlisted HOI4 Agent Tools server configuration file.',
              format: 'filepath',
              isRequired: true,
              placeholder: '/absolute/path/to/config.json',
            },
          ],
          transport: { type: 'stdio' },
        },
      ],
    });
    expect(serverText).toBe(`${JSON.stringify(server, null, 2)}\n`);
    expect(server.packages[0]?.environmentVariables?.[0]).not.toHaveProperty('isSecret');
    expect(server.name).toMatch(/^[A-Za-z0-9.-]+\/[a-z0-9._-]+$/u);
    expect(new URL(server.repository.url).protocol).toBe('https:');
    expect(new URL(server.websiteUrl).protocol).toBe('https:');
  });

  it('documents the isolated non-OIDC namespace bootstrap and token revocation', async () => {
    const release = await readFile(path.join(projectRoot, 'docs', 'release.md'), 'utf8');

    expect(release).not.toMatch(/automation token/iu);
    expect(release).toContain('short-lived npm granular access token');
    expect(release).toContain('read/write access to **All Packages**');
    expect(release).toContain('bypass-2FA enabled');
    expect(release).toContain('NPM_BOOTSTRAP_TOKEN');
    expect(release).toContain('0.0.0-bootstrap.1');
    expect(release).toContain('no `id-token` permission');
    expect(release).toContain('Revoke the granular token immediately');
    expect(release).toContain('explicitly select the required allowed action `npm publish`');
    expect(release).toContain('after May 20, 2026');
    expect(release).toContain('Do not create an `NPM_TOKEN`');
  });

  it('requires an authenticated owner immutability check immediately before a stable tag', async () => {
    const release = await readFile(path.join(projectRoot, 'docs', 'release.md'), 'utf8');

    expect(release).toContain('## Required pre-tag immutability check');
    expect(release).toContain('repos/klimPaskov/hoi4-agent-tools/immutable-releases');
    expect(release).toContain("--jq '.enabled'");
    expect(release).toContain("= 'true'");
    expect(release).toContain('immediately before pushing each stable release tag');
    expect(release).toContain('cannot undo a mutable release');
    expect(release).toMatch(/offers no\s+conditional publish operation/u);
  });

  it('declares stable public exports, all bins, and an explicit package payload', async () => {
    const packageJson = await json<PackageJson>('package.json');
    expect(packageJson.bin).toEqual(PACKAGE_BIN_TARGETS);
    expect(packageJson.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './schemas/*': './schemas/*',
    });
    expect(packageJson.files).toEqual([
      'dist/',
      'docs/',
      'schemas/',
      'server.json',
      'README.md',
      'CHANGELOG.md',
      'LICENSE',
      'SECURITY.md',
    ]);
    expect(packageJson.engines.node).toBe('^22.0.0 || ^24.0.0');
    expect(packageJson.publishConfig).toEqual({ access: 'public', provenance: true });
    expect(REQUIRED_PACKAGE_FILES).toContain('server.json');
  });

  it('pins and verifies the Registry publisher before immutable publication', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    expect(workflow).toContain('PUBLISHER_VERSION="1.7.9"');
    expect(workflow).toContain('e84c4329507f205b111b35a9b30f330945ef5c329648a65260f15d69fcdbf94d');
    expect(workflow).toContain('sha256sum --check --strict publisher-checksum.txt');
    expect(workflow).toContain('./mcp-publisher validate');
    expect(workflow).not.toContain('/latest/download/');
  });

  it('enforces the release DAG and a minimal token-free OIDC npm publisher', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const jobs = [
      'validate_pack',
      'publish_npm',
      'verify_npm',
      'publish_image',
      'github_release',
      'publish_registry',
      'verify_public',
    ];
    const positions = jobs.map((job) => workflow.indexOf(`\n  ${job}:`));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(workflow).toContain('group: release\n');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow.match(/npm run release:order:verify/gu)).toHaveLength(1);
    expect(workflow).toContain('publish_npm:\n    needs: validate_pack');
    expect(workflow).toContain('verify_npm:\n    needs: publish_npm');
    expect(workflow).toContain('publish_image:\n    needs: verify_npm');
    expect(workflow).toContain('github_release:\n    needs: publish_image');
    expect(workflow).toContain('publish_registry:\n    needs: github_release');
    expect(workflow).toContain('verify_public:\n    needs: publish_registry');
    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA"');
    expect(workflow).toContain('EXPECTED_MCP_NAME="io.github.${GITHUB_REPOSITORY_OWNER}');
    expect(workflow).toContain('RELEASE_NODE_VERSION: 24.18.0');
    expect(workflow).toContain('RELEASE_NPM_VERSION: 11.16.0');
    expect(workflow).toContain(
      'ARTIFACT_ROOT="$(realpath --canonicalize-existing "$RELEASE_ARTIFACT_DIR")"',
    );
    expect(workflow).toContain(
      'TARBALL_PATH="$(realpath --canonicalize-existing "$RELEASE_ARTIFACT_DIR/$TARBALL")"',
    );
    expect(workflow).toContain('test "$(dirname "$TARBALL_PATH")" = "$ARTIFACT_ROOT"');
    expect(workflow).toContain('npm publish "$TARBALL_PATH"');
    expect(workflow).not.toContain('npm publish "$RELEASE_ARTIFACT_DIR/$TARBALL"');
    expect(workflow.match(/\bnpm publish /gu)).toHaveLength(1);
    expect(workflow).toContain('npm pack --ignore-scripts --json');
    expect(workflow).toContain('PUBLICATION_VERIFY_SCOPE: npm');
    expect(workflow).not.toContain('cache: npm');
    expect(workflow).toContain('actions/upload-artifact@');
    expect(workflow).toContain('actions/download-artifact@');

    const publisher = workflow.slice(
      workflow.indexOf('\n  publish_npm:'),
      workflow.indexOf('\n  verify_npm:'),
    );
    const basenameCheck = publisher.indexOf('test "$(basename "$TARBALL")" = "$TARBALL"');
    const artifactRoot = publisher.indexOf(
      'ARTIFACT_ROOT="$(realpath --canonicalize-existing "$RELEASE_ARTIFACT_DIR")"',
    );
    const tarballPath = publisher.indexOf(
      'TARBALL_PATH="$(realpath --canonicalize-existing "$RELEASE_ARTIFACT_DIR/$TARBALL")"',
    );
    const containment = publisher.indexOf('test "$(dirname "$TARBALL_PATH")" = "$ARTIFACT_ROOT"');
    const publish = publisher.indexOf('npm publish "$TARBALL_PATH"');
    expect(basenameCheck).toBeGreaterThan(0);
    expect(artifactRoot).toBeGreaterThan(basenameCheck);
    expect(tarballPath).toBeGreaterThan(artifactRoot);
    expect(containment).toBeGreaterThan(tarballPath);
    expect(publish).toBeGreaterThan(containment);
    expect(publisher).not.toContain('npm publish "$RELEASE_ARTIFACT_DIR/$TARBALL"');
    expect(publisher).toContain('id-token: write');
    expect(publisher).toContain('FORBIDDEN_NPM_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(publisher).toContain(
      'FORBIDDEN_NPM_BOOTSTRAP_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}',
    );
    expect(publisher).toContain('All npm bearer-token secrets must be deleted');
    expect(publisher).not.toContain('NODE_AUTH_TOKEN:');
    expect(publisher).not.toMatch(/npm ci|npm install|npm run|npm exec|npx/iu);
    expect(publisher).not.toContain('actions/checkout@');
    expect(workflow).not.toContain('npm install --global');
    expect(workflow).toContain('npm audit signatures --ignore-scripts');
    expect(workflow.indexOf('npm audit signatures --ignore-scripts')).toBeLessThan(
      workflow.indexOf('npm publish "$TARBALL_PATH"'),
    );
  });

  it('passes an absolute local tarball spec to npm without Git shorthand resolution', async () => {
    const npmCli = process.env.npm_execpath;
    expect(npmCli).toBeTruthy();
    if (npmCli === undefined) throw new Error('npm_execpath is required for npm path regression');
    const packageName = 'hoi4-agent-tools-absolute-path-regression';
    const packageVersion = '0.0.0';
    const expectedPublication = {
      id: `${packageName}@${packageVersion}`,
      name: packageName,
      version: packageVersion,
    };
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-tools-absolute-tarball-'));
    try {
      const isolatedUserConfig = path.join(temporary, 'empty.npmrc');
      await writeFile(isolatedUserConfig, '', 'utf8');
      const npmEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_ALLOW_PROTOCOL: 'file',
        npm_config_audit: 'false',
        npm_config_cache: path.join(temporary, 'npm-cache'),
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        npm_config_userconfig: isolatedUserConfig,
      };
      delete npmEnvironment.NODE_AUTH_TOKEN;
      delete npmEnvironment.NPM_BOOTSTRAP_TOKEN;
      delete npmEnvironment.NPM_TOKEN;
      await writeFile(
        path.join(temporary, 'package.json'),
        `${JSON.stringify({
          name: packageName,
          version: packageVersion,
          license: 'Apache-2.0',
          files: ['index.js'],
        })}\n`,
        'utf8',
      );
      await writeFile(path.join(temporary, 'index.js'), 'export {};\n', 'utf8');
      const pack = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json'], {
        cwd: temporary,
        encoding: 'utf8',
        env: npmEnvironment,
      });
      expect(pack.status, pack.stderr).toBe(0);
      const result = JSON.parse(pack.stdout) as Array<{ filename?: string }>;
      const filename = result[0]?.filename;
      expect(filename).toBeTruthy();
      if (filename === undefined) throw new Error('npm pack omitted the tarball filename');
      const tarballPath = path.resolve(temporary, filename);
      expect(path.isAbsolute(tarballPath)).toBe(true);
      const publish = spawnSync(
        process.execPath,
        [
          npmCli,
          'publish',
          tarballPath,
          '--access',
          'public',
          '--dry-run',
          '--ignore-scripts',
          '--provenance=false',
          '--json',
        ],
        { cwd: temporary, encoding: 'utf8', env: npmEnvironment },
      );
      expect(publish.status, publish.stderr).toBe(0);
      const publication = JSON.parse(publish.stdout) as Record<string, unknown>;
      const publicationIdentity = 'id' in publication ? publication : publication[packageName];
      expect(publicationIdentity).toMatchObject(expectedPublication);
      expect(`${publish.stdout}\n${publish.stderr}`).not.toMatch(
        /git ls-remote|github\.com.*\.git/iu,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('stages, verifies, and publishes an immutable GitHub release without replacing draft assets', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const releaseDocs = await readFile(path.join(projectRoot, 'docs', 'release.md'), 'utf8');
    const releaseJob = workflow.slice(
      workflow.indexOf('\n  github_release:'),
      workflow.indexOf('\n  publish_registry:'),
    );
    const staging = releaseJob.slice(
      releaseJob.indexOf('uses: softprops/action-gh-release@'),
      releaseJob.indexOf('Verify the staged draft has exactly the four release assets'),
    );
    const stagedVerification = releaseJob.indexOf(
      'scripts/distribution/github-release-state.ts draft-exact',
    );
    const justInTimeDraftVerification = releaseJob.indexOf(
      'Reverify the unique exact draft immediately before publication',
    );
    const publish = releaseJob.indexOf('--request PATCH');
    const finalVerification = releaseJob.indexOf(
      'scripts/distribution/github-release-state.ts complete-exact',
    );

    expect(releaseJob).toContain('scripts/distribution/github-release-state.ts classify');
    expect(releaseJob.match(/github-release-state\.ts select-list/gu)?.length).toBe(4);
    expect(releaseJob.match(/github-release-state\.ts cross-check/gu)?.length).toBe(4);
    expect(releaseJob.match(/releases\?per_page=100/gu)?.length).toBe(4);
    expect(releaseJob).toContain('gh api --paginate');
    expect(releaseJob).toContain('absent|draft|complete)');
    expect(staging).toContain('draft: true');
    expect(staging).toContain('name: HOI4 Agent Tools ${{ github.ref_name }}');
    expect(staging).toContain('body_path: CHANGELOG.md');
    expect(staging).not.toContain('generate_release_notes: true');
    expect(staging).toContain('overwrite_files: false');
    expect(staging).toContain('fail_on_unmatched_files: true');
    expect(staging).toContain('id: stage_release');
    expect(releaseJob).not.toContain('--request DELETE');
    expect(stagedVerification).toBeGreaterThan(
      releaseJob.indexOf('uses: softprops/action-gh-release@'),
    );
    expect(publish).toBeGreaterThan(stagedVerification);
    expect(justInTimeDraftVerification).toBeGreaterThan(stagedVerification);
    expect(publish).toBeGreaterThan(justInTimeDraftVerification);
    expect(releaseJob).toContain('ACTION_RELEASE_ID: ${{ steps.stage_release.outputs.id }}');
    expect(releaseJob).toContain('test "$RELEASE_ID" = "$ACTION_RELEASE_ID"');
    expect(releaseJob).toContain('test "$OBSERVED_RELEASE_ID" = "$EXPECTED_RELEASE_ID"');
    expect(releaseJob).toContain(
      'steps.draft_state.outputs.release_id || steps.release_state.outputs.release_id',
    );
    expect(
      releaseJob.match(/test "\$OBSERVED_RELEASE_ID" = "\$EXPECTED_RELEASE_ID"/gu)?.length,
    ).toBe(2);
    expect(releaseJob.lastIndexOf('git ls-remote --exit-code', publish)).toBeGreaterThan(
      justInTimeDraftVerification,
    );
    expect(finalVerification).toBeGreaterThan(publish);
    expect(releaseJob.match(/container-image\.json/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(releaseDocs).toContain('fully paginated List releases endpoint');
    expect(releaseDocs).toContain('failed GitHub upload left in `starter` state');
    expect(releaseDocs).toMatch(/manual\s+draft-cleanup blocker/u);
  });

  it('pins the reproducible container frontend and multi-platform base', async () => {
    const packageJson = await json<PackageJson>('package.json');
    const dockerfile = await readFile(path.join(projectRoot, 'Dockerfile'), 'utf8');
    expect(dockerfile.split(/\r?\n/u)[0]).toBe(
      '# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e',
    );
    const bases = [
      ...dockerfile.matchAll(/^FROM node:22-bookworm-slim@(sha256:[a-f0-9]{64})/gmu),
    ].map(([, digest]) => digest);
    expect(bases).toHaveLength(2);
    expect(new Set(bases).size).toBe(1);
    expect(dockerfile).toContain(
      `LABEL io.modelcontextprotocol.server.name="${packageJson.mcpName}"`,
    );
  });

  it('publishes GHCR by digest and never overwrites the exact SemVer tag', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const sourceVisibility = workflow.indexOf('Require a public source repository');
    const push = workflow.indexOf('push-by-digest=true');
    const bootstrapVerification = workflow.indexOf(
      'Verify public bootstrap through anonymous OCI access and exact runtime platforms',
    );
    const publicVerification = workflow.indexOf(
      'Verify anonymous digest, SBOM and provenance subjects, and source SHA',
    );
    expect(sourceVisibility).toBeGreaterThan(0);
    expect(sourceVisibility).toBeLessThan(push);
    expect(bootstrapVerification).toBeGreaterThan(sourceVisibility);
    expect(bootstrapVerification).toBeLessThan(push);
    expect(publicVerification).toBeGreaterThan(push);
    expect(workflow).toContain("--jq '.visibility'");
    expect(workflow).toContain('test "$VISIBILITY" = \'public\'');
    expect(workflow).not.toMatch(/api\.github\.com\/[^\s'"]*\/packages\//u);
    expect(workflow).toContain(
      'outputs: type=image,name=${{ env.CONTAINER_IMAGE }},push-by-digest=true',
    );
    expect(workflow).toContain('Refuse replacement and create the exact SemVer tag once');
    expect(workflow).toContain('container-image.json');
    expect(workflow).not.toContain('type=semver,pattern={{major}}.{{minor}}');
    expect(workflow).not.toContain('type=semver,pattern={{version}}');
    expect(workflow).toContain('PUBLICATION_VERIFY_SCOPE: ghcr');
    expect(workflow).not.toMatch(/--method\s+PATCH[^\n]*packages/iu);
  });

  it('uses the verified default Git context for the release image', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const imageJob = workflow.slice(
      workflow.indexOf('\n  publish_image:'),
      workflow.indexOf('\n  github_release:'),
    );
    const buildStep = imageJob.slice(
      imageJob.indexOf('uses: docker/build-push-action@'),
      imageJob.indexOf(
        '      - name: Refuse replacement',
        imageJob.indexOf('uses: docker/build-push-action@'),
      ),
    );

    expect(buildStep).toContain('push-by-digest=true');
    expect(buildStep).not.toMatch(/^\s*context:/mu);
    expect(buildStep).not.toContain('context: .');
  });

  it('recovers only the image-without-release state through exact anonymous verification', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const imageJob = workflow.slice(
      workflow.indexOf('\n  publish_image:'),
      workflow.indexOf('\n  github_release:'),
    );
    const state = imageJob.slice(
      imageJob.indexOf('Capture and validate the immutable exact-tag and release state'),
      imageJob.indexOf('Re-query the peeled release tag immediately before the digest push'),
    );
    const record = imageJob.indexOf('Record the immutable container digest');
    const verify = imageJob.indexOf(
      'Verify anonymous digest, SBOM and provenance subjects, and source SHA',
    );
    const upload = imageJob.indexOf('uses: actions/upload-artifact@');
    const releaseMetadata = imageJob.slice(record, verify);

    expect(state).toContain('case "${STATUS}:${RELEASE_STATUS}" in');
    expect(state).toContain('200:200)');
    expect(state).toContain("echo 'state=complete'");
    expect(state).toContain('200:404)');
    expect(state).toContain("echo 'state=recover'");
    expect(state).toContain('404:404)');
    expect(state).toContain("echo 'state=publish'");
    expect(state).toContain('404:200)');
    expect(state).toContain('release exists without its required immutable image tag');
    expect(state).toContain('Unsafe release state');
    expect(imageJob).toContain('complete|recover) DIGEST="$EXISTING_DIGEST"');
    expect(imageJob).toContain('PUBLICATION_VERIFY_SCOPE: ghcr');
    expect(releaseMetadata).toContain('--arg digest "$DIGEST"');
    expect(releaseMetadata).toContain('--arg commit "$GITHUB_SHA"');
    expect(releaseMetadata).toContain(
      '{schemaVersion: 1, image: $image, digest: $digest, sourceCommit: $commit, sourceRepository: $source, platforms: ["linux/amd64", "linux/arm64"]}',
    );
    expect(record).toBeGreaterThan(0);
    expect(verify).toBeGreaterThan(record);
    expect(upload).toBeGreaterThan(verify);
  });

  it('isolates the one-use npm token in an explicit manual workflow without OIDC', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'bootstrap-npm.yml'),
      'utf8',
    );
    expect(workflow).toContain('on:\n  workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s{2}push:/mu);
    expect(workflow).toContain('permissions: {}');
    expect(workflow).not.toContain('id-token:');
    expect(workflow).toContain('NPM_BOOTSTRAP_TOKEN');
    expect(workflow).toContain('0.0.0-bootstrap.1');
    expect(workflow).toContain('--provenance=false --tag bootstrap');
    expect(workflow).toContain('executableCode: false');
    expect(workflow).toContain('npm audit signatures --ignore-scripts');
    expect(workflow.indexOf('npm audit signatures --ignore-scripts')).toBeLessThan(
      workflow.indexOf('npm publish "./$BOOTSTRAP_ARTIFACT_DIR/$TARBALL"'),
    );
    expect(
      workflow.lastIndexOf(
        'git ls-remote --exit-code',
        workflow.indexOf('npm publish "./$BOOTSTRAP_ARTIFACT_DIR/$TARBALL"'),
      ),
    ).toBeGreaterThan(0);
    expect(workflow).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}');
    expect(workflow.match(/\bnpm publish /gu)).toHaveLength(1);
  });

  it('behavior-tests the dependency-free OIDC npm state recheck embedded in release.yml', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const marker = `<<'NODE'\n`;
    const scriptStart = workflow.indexOf(marker, workflow.indexOf('Recheck monotonic npm state'));
    const scriptEnd = workflow.indexOf('\n          NODE', scriptStart + marker.length);
    expect(scriptStart).toBeGreaterThan(0);
    expect(scriptEnd).toBeGreaterThan(scriptStart);
    const script = workflow
      .slice(scriptStart + marker.length, scriptEnd)
      .split('\n')
      .map((line) => line.replace(/^ {10}/u, ''))
      .join('\n');
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-tools-npm-state-'));
    const metadataPath = path.join(temporary, 'metadata.json');
    const bootstrap = '0.0.0-bootstrap.1';
    const manifest = (version: string, name = 'hoi4-agent-tools') => ({ name, version });
    const exact = {
      name: 'hoi4-agent-tools',
      versions: { [bootstrap]: manifest(bootstrap) },
      'dist-tags': { bootstrap, latest: bootstrap },
    };
    const run = async (metadata: unknown, version = '0.1.2') => {
      await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, 'utf8');
      return spawnSync(process.execPath, ['-', metadataPath, 'hoi4-agent-tools', version], {
        encoding: 'utf8',
        input: `${script}\n`,
      });
    };

    try {
      const advance = await run(exact);
      expect(advance.status).toBe(0);
      expect(advance.stdout).toBe('advance');
      for (const invalid of [
        { ...exact, 'dist-tags': { latest: bootstrap } },
        { ...exact, 'dist-tags': { bootstrap, latest: bootstrap, next: bootstrap } },
        { ...exact, versions: { [bootstrap]: manifest(bootstrap, 'attacker') } },
        { ...exact, versions: { [bootstrap]: manifest(bootstrap), '0.1.0': manifest('0.1.0') } },
        { ...exact, 'dist-tags': { bootstrap } },
      ]) {
        expect((await run(invalid)).status).not.toBe(0);
      }
      for (const invalidCandidate of ['0.1.1', '0.1.3']) {
        expect((await run(exact, invalidCandidate)).status).not.toBe(0);
      }

      const published = {
        name: 'hoi4-agent-tools',
        versions: { [bootstrap]: manifest(bootstrap), '0.1.2': manifest('0.1.2') },
        'dist-tags': { bootstrap, latest: '0.1.2' },
      };
      const rerun = await run(published);
      expect(rerun.status).toBe(0);
      expect(rerun.stdout).toBe('rerun');
      const next = await run(published, '0.1.3');
      expect(next.status).toBe(0);
      expect(next.stdout).toBe('advance');
      expect(
        (
          await run({
            ...published,
            versions: { [bootstrap]: manifest(bootstrap), '0.1.3': manifest('0.1.3') },
          })
        ).status,
      ).not.toBe(0);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('re-queries a peeled remote tag before every release writer and final verification', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const job = (name: string, next: string | undefined): string => {
      const start = workflow.indexOf(`\n  ${name}:`);
      const end =
        next === undefined ? workflow.length : workflow.indexOf(`\n  ${next}:`, start + 1);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      return workflow.slice(start, end);
    };
    const requireTagCheckBefore = (section: string, marker: string): void => {
      const write = section.indexOf(marker);
      const check = section.lastIndexOf('git ls-remote --exit-code', write);
      expect(write, marker).toBeGreaterThan(0);
      expect(check, `${marker} must have a preceding remote tag check`).toBeGreaterThan(0);
      expect(check).toBeLessThan(write);
    };

    requireTagCheckBefore(job('publish_npm', 'verify_npm'), 'npm publish');
    const image = job('publish_image', 'github_release');
    requireTagCheckBefore(image, 'uses: docker/build-push-action@');
    requireTagCheckBefore(image, 'docker buildx imagetools create');
    const githubRelease = job('github_release', 'publish_registry');
    requireTagCheckBefore(githubRelease, 'uses: softprops/action-gh-release@');
    requireTagCheckBefore(githubRelease, '--request PATCH');
    requireTagCheckBefore(job('publish_registry', 'verify_public'), './mcp-publisher publish');
    requireTagCheckBefore(job('verify_public', undefined), 'npm run publication:verify');
  });

  it('bootstraps GHCR from canonical public main with only the repository token', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'bootstrap-ghcr.yml'),
      'utf8',
    );
    const push = workflow.indexOf('push: true');
    const platformVerification = workflow.indexOf(
      'Verify the published bootstrap tag and exact runtime platforms',
    );
    const secretReferences = [...workflow.matchAll(/secrets\.([A-Za-z0-9_]+)/gu)].map(
      ([, secret]) => secret,
    );

    expect(workflow).toContain('on:\n  workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s{2}push:/mu);
    expect(workflow).toContain('test "$GITHUB_REPOSITORY" = \'klimPaskov/hoi4-agent-tools\'');
    expect(workflow).toContain('test "$GITHUB_REF" = \'refs/heads/main\'');
    expect(workflow).toContain('test "$REPOSITORY_VISIBILITY" = \'public\'');
    expect(workflow).toContain('permissions: {}');
    expect(workflow).toContain('contents: read\n      packages: write');
    expect(workflow).not.toContain('id-token:');
    expect(new Set(secretReferences)).toEqual(new Set(['GITHUB_TOKEN']));
    expect(workflow).not.toContain('github.token');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('tags: ghcr.io/klimpaskov/hoi4-agent-tools:bootstrap');
    expect(workflow).not.toContain('type=semver');
    expect(workflow).not.toContain('action-gh-release');
    expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(push).toBeGreaterThan(0);
    expect(platformVerification).toBeGreaterThan(push);
    expect(workflow).toContain('docker buildx imagetools inspect --raw');
    expect(workflow).toContain('test "$RUNTIME_PLATFORMS" = \'linux/amd64,linux/arm64\'');
  });

  it('enforces coverage in CI and before release publication', async () => {
    const ciWorkflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const releaseWorkflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const releaseCoverage = releaseWorkflow.indexOf('npm run test:coverage');
    const firstReleasePush = releaseWorkflow.indexOf('push-by-digest=true');

    expect(ciWorkflow).toContain(
      "if: matrix.os == 'ubuntu-latest' && matrix.node == 22\n        run: npm run test:coverage",
    );
    expect(releaseCoverage).toBeGreaterThan(0);
    expect(releaseCoverage).toBeLessThan(firstReleasePush);
  });

  it('verifies npm Sigstore provenance, release bytes, GHCR, and Registry metadata', async () => {
    const verifier = await readFile(
      path.join(projectRoot, 'scripts', 'verify-publication.ts'),
      'utf8',
    );
    expect(verifier).toContain('https://slsa.dev/provenance/v1');
    expect(verifier).toContain('auditPublishedPackage');
    expect(verifier).toContain('officialSigstoreVerifier');
    expect(verifier).toContain('certificateIdentity');
    expect(verifier).toContain('verifyGhcrPublication');
    expect(verifier).toContain('verifyPlatformAttestations');
    expect(verifier).toContain('isDeepStrictEqual(published, serverJson)');
    expect(verifier).toContain("official.status !== 'active'");
    expect(verifier).toContain('official.isLatest !== true');
  });

  it('pins the current audited major of every automation action', async () => {
    const expected = new Map([
      ['actions/checkout', ['9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0', 'v7']],
      ['actions/setup-node', ['48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e', 'v6']],
      ['docker/setup-qemu-action', ['96fe6ef7f33517b61c61be40b68a1882f3264fb8', 'v4']],
      ['docker/setup-buildx-action', ['bb05f3f5519dd87d3ba754cc423b652a5edd6d2c', 'v4']],
      ['docker/login-action', ['af1e73f918a031802d376d3c8bbc3fe56130a9b0', 'v4']],
      ['docker/build-push-action', ['53b7df96c91f9c12dcc8a07bcb9ccacbed38856a', 'v7']],
      ['softprops/action-gh-release', ['718ea10b132b3b2eba29c1007bb80653f286566b', 'v3']],
      ['actions/upload-artifact', ['b7c566a772e6b6bfb58ed0dc250532a479d7789f', 'v6']],
      ['actions/download-artifact', ['37930b1c2abaa49bbe596cd826c3c89aef350131', 'v7']],
    ]);
    const observed = new Set<string>();
    for (const workflowName of [
      'bootstrap-ghcr.yml',
      'bootstrap-npm.yml',
      'ci.yml',
      'release.yml',
    ]) {
      const workflow = await readFile(
        path.join(projectRoot, '.github', 'workflows', workflowName),
        'utf8',
      );
      for (const match of workflow.matchAll(/\buses:\s+([^\s@]+)@([a-f0-9]{40})\s+#\s+(v\d+)/gu)) {
        const [, action, sha, major] = match;
        expect(expected.has(action ?? ''), `${action} must have an audited pin`).toBe(true);
        expect([sha, major]).toEqual(expected.get(action ?? ''));
        observed.add(action ?? '');
      }
    }
    expect(observed).toEqual(new Set(expected.keys()));
  });

  it('pins every automation action to an immutable commit', async () => {
    for (const workflowName of [
      'bootstrap-ghcr.yml',
      'bootstrap-npm.yml',
      'ci.yml',
      'release.yml',
    ]) {
      const workflow = await readFile(
        path.join(projectRoot, '.github', 'workflows', workflowName),
        'utf8',
      );
      const actionRefs = [...workflow.matchAll(/\buses:\s+[^\s@]+@([^\s#]+)/gu)].map(
        ([, reference]) => reference,
      );
      expect(actionRefs.length).toBeGreaterThan(0);
      expect(actionRefs.every((reference) => /^[a-f0-9]{40}$/u.test(reference ?? ''))).toBe(true);
    }
  });
});
