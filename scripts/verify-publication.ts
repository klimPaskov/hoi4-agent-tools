import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import {
  verifyContainerAttestationStatement,
  verifyContainerReleaseManifest,
  verifyNpmReleaseOrder,
  verifyReleaseArtifact,
  verifySlsaProvenance,
  type ContainerReleaseManifest,
  type SigstoreBundleVerifier,
  type VerifiedReleaseArtifact,
} from './distribution/release-verification.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  mcpName: string;
  name: string;
  version: string;
};
const serverJson = JSON.parse(await readFile(path.join(root, 'server.json'), 'utf8')) as Record<
  string,
  unknown
> & {
  name: string;
  repository: { url: string };
  version: string;
};
const scope = process.env.PUBLICATION_VERIFY_SCOPE ?? 'all';
if (scope !== 'npm' && scope !== 'ghcr' && scope !== 'all') {
  throw new Error(`Unsupported PUBLICATION_VERIFY_SCOPE: ${scope}`);
}
const attempts = Math.max(1, Number(process.env.PUBLICATION_VERIFY_ATTEMPTS ?? 1));
const delayMs = Math.max(250, Number(process.env.PUBLICATION_VERIFY_DELAY_MS ?? 5000));
const sourceCommitValue = process.env.GITHUB_SHA;
if (sourceCommitValue === undefined || !/^[0-9a-f]{40}$/u.test(sourceCommitValue)) {
  throw new Error('GITHUB_SHA must name the full release commit');
}
const sourceCommit: string = sourceCommitValue;
const sourceRepository = serverJson.repository.url;
const releaseTag = `v${packageJson.version}`;
const imageRepository = 'ghcr.io/klimpaskov/hoi4-agent-tools';

interface ReleaseArtifactFiles {
  artifact: VerifiedReleaseArtifact;
  identityBytes: Buffer;
  manifestBytes: Buffer;
  tarballBytes: Buffer;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function records(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(
      Buffer.from(bytes)
        .toString('utf8')
        .replace(/^\uFEFF/u, ''),
    ) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function releaseArtifactFiles(): Promise<ReleaseArtifactFiles> {
  const directory = path.resolve(root, process.env.RELEASE_ARTIFACT_DIR ?? 'release');
  const manifestBytes = await readFile(path.join(directory, 'npm-pack.json'));
  const envelope = parseJson(manifestBytes, 'npm-pack.json');
  if (!Array.isArray(envelope)) throw new Error('npm-pack.json must be an array');
  const filename = record(envelope[0], 'npm-pack.json[0]').filename;
  if (typeof filename !== 'string') throw new Error('npm-pack.json does not name a tarball');
  const tarballBytes = await readFile(path.join(directory, filename));
  const artifact = verifyReleaseArtifact(
    manifestBytes,
    tarballBytes,
    packageJson.name,
    packageJson.version,
  );
  const identityBytes = await readFile(path.join(directory, 'release-identity.json'));
  const identity = record(
    parseJson(identityBytes, 'release-identity.json'),
    'release-identity.json',
  );
  if (
    identity.package !== packageJson.name ||
    identity.version !== packageJson.version ||
    identity.tag !== releaseTag ||
    identity.commit !== sourceCommit ||
    identity.filename !== artifact.filename ||
    identity.sha256 !== artifact.sha256 ||
    identity.sha512 !== artifact.sha512 ||
    identity.npmAuditSignatures !== true
  ) {
    throw new Error(
      'release-identity.json is not bound to the workflow tarball and release commit',
    );
  }
  return { artifact, identityBytes, manifestBytes, tarballBytes };
}

async function containerManifestBytes(): Promise<{
  bytes: Buffer;
  manifest: ContainerReleaseManifest;
}> {
  const directory = path.resolve(root, process.env.CONTAINER_ARTIFACT_DIR ?? 'container-release');
  const bytes = await readFile(path.join(directory, 'container-image.json'));
  const expected: ContainerReleaseManifest = {
    digest: nonEmptyString(
      record(parseJson(bytes, 'container-image.json'), 'container-image.json').digest,
      'container-image.json digest',
    ),
    image: `${imageRepository}:${packageJson.version}`,
    platforms: ['linux/amd64', 'linux/arm64'],
    schemaVersion: 1,
    sourceCommit,
    sourceRepository,
  };
  const manifest = verifyContainerReleaseManifest(
    parseJson(bytes, 'container-image.json'),
    expected,
  );
  return { bytes, manifest };
}

async function fetchResponse(url: string, accept: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept,
    'cache-control': 'no-cache',
    'user-agent': 'hoi4-agent-tools-publication-verifier',
  };
  if (new URL(url).hostname === 'api.github.com') {
    headers['x-github-api-version'] = '2026-03-10';
  }
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetchResponse(url, 'application/json');
  return record((await response.json()) as unknown, url);
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetchResponse(url, 'application/octet-stream');
  if (new URL(response.url).protocol !== 'https:') {
    throw new Error(`${url} redirected away from HTTPS`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function npmExecPath(): string {
  const value = process.env.npm_execpath;
  if (value === undefined)
    throw new Error('npm_execpath is unavailable; run through the pinned npm CLI');
  return value;
}

async function runNpm(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [npmExecPath(), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_AUTH_TOKEN: '',
      NPM_TOKEN: '',
      npm_config_ignore_scripts: 'true',
      npm_config_registry: 'https://registry.npmjs.org',
    },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

async function auditPublishedPackage(): Promise<unknown> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-provenance-'));
  try {
    await writeFile(
      path.join(temporary, 'package.json'),
      `${JSON.stringify({
        dependencies: { [packageJson.name]: packageJson.version },
        name: 'hoi4-agent-publication-audit',
        private: true,
        version: '0.0.0',
      })}\n`,
    );
    await runNpm(
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'],
      temporary,
    );
    const output = await runNpm(
      ['audit', 'signatures', '--json', '--include-attestations', '--ignore-scripts'],
      temporary,
    );
    return parseJson(Buffer.from(output, 'utf8'), 'npm audit signatures output');
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

let sigstoreVerifier: SigstoreBundleVerifier | undefined;

async function officialSigstoreVerifier(): Promise<SigstoreBundleVerifier> {
  if (sigstoreVerifier !== undefined) return sigstoreVerifier;
  const npmRoot = path.resolve(path.dirname(npmExecPath()), '..');
  const npmMetadata = JSON.parse(await readFile(path.join(npmRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  const expectedVersion = process.env.RELEASE_NPM_VERSION ?? '11.15.0';
  if (npmMetadata.version !== expectedVersion) {
    throw new Error(`Publication verification requires npm ${expectedVersion}`);
  }
  const require = createRequire(import.meta.url);
  const loaded = require(path.join(npmRoot, 'node_modules', 'sigstore')) as unknown;
  const module = record(loaded, 'npm-bundled sigstore module');
  if (typeof module.verify !== 'function')
    throw new Error('npm-bundled sigstore verifier is missing');
  const verify = module.verify as (
    bundle: Record<string, unknown>,
    policy: object,
  ) => Promise<unknown>;
  sigstoreVerifier = async (bundle, policy) => {
    await verify(bundle, policy);
  };
  return sigstoreVerifier;
}

async function verifyNpmPublication(release: ReleaseArtifactFiles): Promise<void> {
  const npmPackage = await fetchJson(
    `https://registry.npmjs.org/${encodeURIComponent(packageJson.name)}`,
  );
  if (verifyNpmReleaseOrder(npmPackage, packageJson.name, packageJson.version) !== 'rerun') {
    throw new Error('Published npm version is not the current latest release');
  }
  const npm = await fetchJson(
    `https://registry.npmjs.org/${encodeURIComponent(packageJson.name)}/${encodeURIComponent(packageJson.version)}`,
  );
  if (npm.version !== packageJson.version || npm.mcpName !== packageJson.mcpName) {
    throw new Error('Published npm package version or mcpName does not match local metadata');
  }

  const npmDist = record(npm.dist, 'Published npm dist metadata');
  const integrity = nonEmptyString(npmDist.integrity, 'Published npm dist.integrity');
  const shasum = nonEmptyString(npmDist.shasum, 'Published npm dist.shasum');
  const tarballUrl = nonEmptyString(npmDist.tarball, 'Published npm dist.tarball');
  if (new URL(tarballUrl).protocol !== 'https:') {
    throw new Error('Published npm tarball does not use HTTPS');
  }
  if (integrity !== release.artifact.integrity || shasum !== release.artifact.sha1) {
    throw new Error('Published npm digest differs from the workflow release tarball');
  }

  const distAttestations = record(npmDist.attestations, 'Published npm dist.attestations');
  const provenance = record(
    distAttestations.provenance,
    'Published npm dist.attestations.provenance',
  );
  if (provenance.predicateType !== 'https://slsa.dev/provenance/v1') {
    throw new Error('Published npm package does not advertise SLSA provenance v1');
  }
  const attestationsUrl = nonEmptyString(
    distAttestations.url,
    'Published npm dist.attestations.url',
  );
  const parsedAttestationsUrl = new URL(attestationsUrl);
  if (
    parsedAttestationsUrl.protocol !== 'https:' ||
    parsedAttestationsUrl.hostname !== 'registry.npmjs.org'
  ) {
    throw new Error('Published npm attestations are not served by the HTTPS npm registry');
  }

  const publicTarball = await fetchBytes(tarballUrl);
  if (!publicTarball.equals(release.tarballBytes)) {
    throw new Error('Public npm tarball bytes differ from the workflow release tarball');
  }
  const attestations = await fetchJson(attestationsUrl);
  const auditReport = await auditPublishedPackage();
  await verifySlsaProvenance(
    auditReport,
    attestations,
    release.artifact.sha512,
    {
      buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      builderId: 'https://github.com/actions/runner/github-hosted',
      certificateIdentity: `${sourceRepository}/.github/workflows/release.yml@refs/tags/${releaseTag}`,
      certificateIssuer: 'https://token.actions.githubusercontent.com',
      commit: sourceCommit,
      packageName: packageJson.name,
      repository: sourceRepository,
      version: packageJson.version,
      workflowPath: '.github/workflows/release.yml',
      workflowRef: `refs/tags/${releaseTag}`,
    },
    await officialSigstoreVerifier(),
  );
}

function requiredAsset(assets: Record<string, unknown>[], name: string): Record<string, unknown> {
  const matches = assets.filter((entry) => entry.name === name);
  if (matches.length !== 1)
    throw new Error(`Public GitHub release does not uniquely contain ${name}`);
  const asset = matches[0]!;
  if (asset.state !== 'uploaded') throw new Error(`GitHub release asset ${name} is not uploaded`);
  return asset;
}

async function verifyAssetBytes(
  asset: Record<string, unknown>,
  expected: Buffer,
  label: string,
): Promise<void> {
  const sha256 = createHash('sha256').update(expected).digest('hex');
  if (asset.size !== expected.byteLength || asset.digest !== `sha256:${sha256}`) {
    throw new Error(`GitHub release ${label} size or SHA-256 digest is incorrect`);
  }
  const bytes = await fetchBytes(
    nonEmptyString(asset.browser_download_url, `GitHub ${label} browser_download_url`),
  );
  if (!bytes.equals(expected))
    throw new Error(`GitHub release ${label} bytes differ from the workflow`);
}

async function verifyGitHubRelease(
  releaseArtifact: ReleaseArtifactFiles,
  container: { bytes: Buffer; manifest: ContainerReleaseManifest },
): Promise<void> {
  const release = await fetchJson(
    `https://api.github.com/repos/klimPaskov/hoi4-agent-tools/releases/tags/${encodeURIComponent(releaseTag)}`,
  );
  if (
    release.tag_name !== releaseTag ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.immutable !== true
  ) {
    throw new Error('Public GitHub release tag, state, or immutable policy is incorrect');
  }

  const assets = records(release.assets, 'GitHub release assets');
  await verifyAssetBytes(
    requiredAsset(assets, releaseArtifact.artifact.filename),
    releaseArtifact.tarballBytes,
    'tarball',
  );
  await verifyAssetBytes(
    requiredAsset(assets, 'npm-pack.json'),
    releaseArtifact.manifestBytes,
    'npm-pack.json',
  );
  await verifyAssetBytes(
    requiredAsset(assets, 'release-identity.json'),
    releaseArtifact.identityBytes,
    'release-identity.json',
  );
  await verifyAssetBytes(
    requiredAsset(assets, 'container-image.json'),
    container.bytes,
    'container-image.json',
  );
}

async function verifyGitHubTag(): Promise<void> {
  const tag = await fetchJson(
    `https://api.github.com/repos/klimPaskov/hoi4-agent-tools/git/ref/tags/${encodeURIComponent(releaseTag)}`,
  );
  let object = record(tag.object, 'GitHub release tag object');
  for (let depth = 0; depth < 5 && object.type === 'tag'; depth += 1) {
    const annotated = await fetchJson(
      `https://api.github.com/repos/klimPaskov/hoi4-agent-tools/git/tags/${encodeURIComponent(nonEmptyString(object.sha, 'GitHub annotated tag SHA'))}`,
    );
    object = record(annotated.object, 'GitHub annotated tag target');
  }
  if (object.type !== 'commit' || object.sha !== sourceCommit) {
    throw new Error('Public Git tag no longer peels to the release commit');
  }
}

interface OciResponse {
  bytes: Buffer;
  contentDigest?: string;
}

async function ghcrToken(): Promise<string> {
  const url = new URL('https://ghcr.io/token');
  url.searchParams.set('service', 'ghcr.io');
  url.searchParams.set('scope', 'repository:klimpaskov/hoi4-agent-tools:pull');
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'hoi4-agent-tools-publication-verifier' },
  });
  if (!response.ok) throw new Error(`Anonymous GHCR token request returned ${response.status}`);
  const payload = record((await response.json()) as unknown, 'Anonymous GHCR token response');
  return nonEmptyString(payload.token, 'Anonymous GHCR token');
}

async function fetchOci(pathName: string, accept: string, token: string): Promise<OciResponse> {
  const response = await fetch(`https://ghcr.io/v2/klimpaskov/hoi4-agent-tools/${pathName}`, {
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      'cache-control': 'no-cache',
      'user-agent': 'hoi4-agent-tools-publication-verifier',
    },
  });
  if (!response.ok) throw new Error(`Anonymous GHCR ${pathName} returned ${response.status}`);
  if (new URL(response.url).protocol !== 'https:') {
    throw new Error(`Anonymous GHCR ${pathName} redirected away from HTTPS`);
  }
  const contentDigest = response.headers.get('docker-content-digest') ?? undefined;
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    ...(contentDigest === undefined ? {} : { contentDigest }),
  };
}

function verifyDigest(bytes: Uint8Array, expected: unknown, label: string): string {
  const value = ociDigest(expected, label);
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== value) throw new Error(`${label} does not match downloaded OCI bytes`);
  return value;
}

function ociDigest(expected: unknown, label: string): string {
  const value = nonEmptyString(expected, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} is not a SHA-256 digest`);
  return value;
}

function descriptorPlatform(descriptor: Record<string, unknown>): string | undefined {
  const platform = descriptor.platform;
  if (typeof platform !== 'object' || platform === null || Array.isArray(platform))
    return undefined;
  const value = platform as Record<string, unknown>;
  if (typeof value.os !== 'string' || typeof value.architecture !== 'string') return undefined;
  return `${value.os}/${value.architecture}`;
}

function statementFromLayer(bytes: Buffer, mediaType: string): unknown {
  if (mediaType === 'application/vnd.in-toto+json') return parseJson(bytes, 'OCI attestation');
  if (!/^application\/vnd\.in-toto\..*\+dsse$/u.test(mediaType)) {
    throw new Error(`Unsupported OCI attestation media type: ${mediaType}`);
  }
  const envelope = record(parseJson(bytes, 'OCI DSSE attestation'), 'OCI DSSE attestation');
  const payload = nonEmptyString(envelope.payload, 'OCI DSSE payload');
  return parseJson(Buffer.from(payload, 'base64'), 'OCI DSSE statement');
}

async function verifyRuntimeConfig(
  descriptor: Record<string, unknown>,
  token: string,
): Promise<void> {
  const digest = ociDigest(descriptor.digest, 'OCI runtime descriptor digest');
  const response = await fetchOci(
    `manifests/${digest}`,
    'application/vnd.oci.image.manifest.v1+json',
    token,
  );
  verifyDigest(response.bytes, digest, 'OCI runtime manifest digest');
  const manifest = record(
    parseJson(response.bytes, 'OCI runtime manifest'),
    'OCI runtime manifest',
  );
  const config = record(manifest.config, 'OCI runtime config descriptor');
  const configDigest = ociDigest(config.digest, 'OCI runtime config digest');
  const configResponse = await fetchOci(
    `blobs/${configDigest}`,
    'application/vnd.oci.image.config.v1+json',
    token,
  );
  verifyDigest(configResponse.bytes, configDigest, 'OCI runtime config digest');
  const image = record(parseJson(configResponse.bytes, 'OCI image config'), 'OCI image config');
  const configuration = record(image.config, 'OCI image config.config');
  const labels = record(configuration.Labels, 'OCI image labels');
  if (
    labels['org.opencontainers.image.source'] !== sourceRepository ||
    labels['org.opencontainers.image.revision'] !== sourceCommit ||
    labels['org.opencontainers.image.version'] !== packageJson.version
  ) {
    throw new Error('OCI image labels do not bind the release source, commit, and version');
  }
}

async function verifyPlatformAttestations(
  runtime: Record<string, unknown>,
  attestationDescriptors: Record<string, unknown>[],
  token: string,
): Promise<void> {
  const platform = nonEmptyString(descriptorPlatform(runtime), 'OCI runtime platform');
  const subjectDigest = ociDigest(runtime.digest, 'OCI runtime digest');
  const associated = attestationDescriptors.filter((descriptor) => {
    const annotations = record(descriptor.annotations, 'OCI attestation descriptor annotations');
    return (
      annotations['vnd.docker.reference.digest'] === subjectDigest ||
      annotations['com.docker.reference.digest'] === subjectDigest
    );
  });
  if (associated.length === 0)
    throw new Error(`OCI image ${platform} has no attached attestations`);

  const statements = new Map<string, unknown[]>();
  for (const descriptor of associated) {
    const digest = ociDigest(descriptor.digest, 'OCI attestation manifest digest');
    const response = await fetchOci(
      `manifests/${digest}`,
      'application/vnd.oci.image.manifest.v1+json',
      token,
    );
    verifyDigest(response.bytes, digest, 'OCI attestation manifest digest');
    const manifest = record(
      parseJson(response.bytes, 'OCI attestation manifest'),
      'OCI attestation manifest',
    );
    for (const layer of records(manifest.layers, 'OCI attestation layers')) {
      const annotations = record(layer.annotations, 'OCI attestation layer annotations');
      const predicateType = nonEmptyString(
        annotations['in-toto.io/predicate-type'],
        'OCI attestation predicate type',
      );
      const layerDigest = ociDigest(layer.digest, 'OCI attestation layer digest');
      const mediaType = nonEmptyString(layer.mediaType, 'OCI attestation layer media type');
      const layerResponse = await fetchOci(`blobs/${layerDigest}`, mediaType, token);
      verifyDigest(layerResponse.bytes, layerDigest, 'OCI attestation layer digest');
      const existing = statements.get(predicateType) ?? [];
      existing.push(statementFromLayer(layerResponse.bytes, mediaType));
      statements.set(predicateType, existing);
    }
  }

  const expected = {
    imageRepository,
    platform,
    sourceCommit,
    sourceRepository,
    sourceTag: `refs/tags/${releaseTag}`,
    subjectDigest,
  };
  const provenance = statements.get('https://slsa.dev/provenance/v0.2') ?? [];
  const sbom = statements.get('https://spdx.dev/Document') ?? [];
  if (provenance.length !== 1 || sbom.length !== 1) {
    throw new Error(
      `OCI image ${platform} must have exactly one provenance and one SBOM statement`,
    );
  }
  verifyContainerAttestationStatement(provenance[0], 'https://slsa.dev/provenance/v0.2', expected);
  verifyContainerAttestationStatement(sbom[0], 'https://spdx.dev/Document', expected);
}

async function verifyGhcrPublication(container: ContainerReleaseManifest): Promise<void> {
  const token = await ghcrToken();
  const response = await fetchOci(
    `manifests/${packageJson.version}`,
    [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
    ].join(', '),
    token,
  );
  if (response.contentDigest !== container.digest) {
    throw new Error('Anonymous GHCR tag digest differs from container-image.json');
  }
  verifyDigest(response.bytes, container.digest, 'Anonymous GHCR image index digest');
  const index = record(parseJson(response.bytes, 'OCI image index'), 'OCI image index');
  if (
    index.schemaVersion !== 2 ||
    (index.mediaType !== 'application/vnd.oci.image.index.v1+json' &&
      index.mediaType !== 'application/vnd.docker.distribution.manifest.list.v2+json')
  ) {
    throw new Error('Anonymous GHCR tag is not an OCI/Docker image index');
  }
  const descriptors = records(index.manifests, 'OCI image index manifests');
  const attestationDescriptors = descriptors.filter(
    (descriptor) => descriptorPlatform(descriptor) === 'unknown/unknown',
  );
  const runtime = descriptors.filter(
    (descriptor) => descriptorPlatform(descriptor) !== 'unknown/unknown',
  );
  const runtimePlatforms = runtime.map((descriptor) => descriptorPlatform(descriptor)!).sort();
  if (!isDeepStrictEqual(runtimePlatforms, container.platforms)) {
    throw new Error('Anonymous GHCR runtime platform set is incorrect');
  }
  if (attestationDescriptors.length === 0) {
    throw new Error('Anonymous GHCR image index has no attestation manifests');
  }
  const runtimeDigests = new Set(
    runtime.map((descriptor) => ociDigest(descriptor.digest, 'OCI runtime descriptor digest')),
  );
  for (const descriptor of attestationDescriptors) {
    const annotations = record(descriptor.annotations, 'OCI attestation descriptor annotations');
    const subject =
      annotations['vnd.docker.reference.digest'] ?? annotations['com.docker.reference.digest'];
    if (typeof subject !== 'string' || !runtimeDigests.has(subject)) {
      throw new Error('OCI image index contains an orphaned attestation manifest');
    }
  }
  for (const descriptor of runtime) {
    await verifyRuntimeConfig(descriptor, token);
    await verifyPlatformAttestations(descriptor, attestationDescriptors, token);
  }
}

function validTimestamp(value: unknown, label: string): void {
  const text = nonEmptyString(value, label);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${label} is not an ISO timestamp`);
}

async function verifyRegistryPublication(): Promise<void> {
  const registry = await fetchJson(
    `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(serverJson.name)}/versions/${encodeURIComponent(serverJson.version)}`,
  );
  const published = record(registry.server, 'Official MCP Registry server metadata');
  if (!isDeepStrictEqual(published, serverJson)) {
    throw new Error('Official MCP Registry server metadata differs from server.json');
  }

  const meta = record(registry._meta, 'Official MCP Registry _meta');
  const official = record(
    meta['io.modelcontextprotocol.registry/official'],
    'Official MCP Registry status metadata',
  );
  if (official.status !== 'active' || official.isLatest !== true) {
    throw new Error('Official MCP Registry version is not active and latest');
  }
  validTimestamp(official.statusChangedAt, 'Registry statusChangedAt');
  validTimestamp(official.publishedAt, 'Registry publishedAt');
  validTimestamp(official.updatedAt, 'Registry updatedAt');
}

async function verify(): Promise<void> {
  await verifyGitHubTag();
  if (scope === 'npm') {
    await verifyNpmPublication(await releaseArtifactFiles());
    return;
  }
  if (scope === 'ghcr') {
    await verifyGhcrPublication((await containerManifestBytes()).manifest);
    return;
  }
  const release = await releaseArtifactFiles();
  const container = await containerManifestBytes();
  await verifyNpmPublication(release);
  await verifyGhcrPublication(container.manifest);
  await verifyGitHubRelease(release, container);
  await verifyRegistryPublication();
}

let lastError: unknown;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    await verify();
    process.stderr.write(
      scope === 'npm'
        ? `Public npm publication verified: ${packageJson.name}@${packageJson.version}\n`
        : scope === 'ghcr'
          ? `Public GHCR publication verified: ${imageRepository}:${packageJson.version}\n`
          : `Public release verified: ${serverJson.name}@${serverJson.version} (GitHub, npm, GHCR, MCP Registry)\n`,
    );
    lastError = undefined;
    break;
  } catch (error) {
    lastError = error;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
if (lastError !== undefined) {
  if (lastError instanceof Error) throw lastError;
  throw new Error(typeof lastError === 'string' ? lastError : 'Publication verification failed', {
    cause: lastError,
  });
}
