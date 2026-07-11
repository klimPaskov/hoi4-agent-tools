import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export interface PackFile {
  mode: number;
  path: string;
  size: number;
}

export interface PackManifest {
  filename: string;
  files: PackFile[];
  integrity: string;
  name: string;
  shasum: string;
  size: number;
  unpackedSize: number;
  version: string;
}

export interface VerifiedReleaseArtifact {
  filename: string;
  integrity: string;
  manifest: PackManifest;
  sha1: string;
  sha256: string;
  sha512: string;
  size: number;
}

export interface ExpectedProvenance {
  buildType: string;
  builderId: string;
  certificateIdentity: string;
  certificateIssuer: string;
  commit: string;
  packageName: string;
  repository: string;
  version: string;
  workflowPath: string;
  workflowRef: string;
}

export interface SigstoreVerificationPolicy {
  certificateIdentityURI: string;
  certificateIssuer: string;
  ctLogThreshold: number;
  tlogThreshold: number;
}

export type SigstoreBundleVerifier = (
  bundle: Record<string, unknown>,
  policy: SigstoreVerificationPolicy,
) => Promise<void>;

export interface ExpectedContainerAttestation {
  imageRepository: string;
  platform: string;
  sourceCommit: string;
  sourceRepository: string;
  sourceTag: string;
  subjectDigest: string;
}

export interface ContainerReleaseManifest {
  digest: string;
  image: string;
  platforms: string[];
  schemaVersion: number;
  sourceCommit: string;
  sourceRepository: string;
}

export type NpmReleaseOrder = 'advance' | 'rerun';

export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/';

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

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function strictSemverParts(value: string, label: string): readonly [bigint, bigint, bigint] {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(value);
  if (match === null) throw new Error(`${label} must be a strict stable semantic version`);
  return [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)];
}

function compareStrictSemver(left: string, right: string): number {
  const leftParts = strictSemverParts(left, 'Candidate npm version');
  const rightParts = strictSemverParts(right, 'Current npm latest version');
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index]! < rightParts[index]!) return -1;
    if (leftParts[index]! > rightParts[index]!) return 1;
  }
  return 0;
}

const FIRST_RELEASE_BOOTSTRAP_VERSION = '0.0.0-bootstrap.1';
const FIRST_STABLE_VERSION = '0.1.2';

function requireExactFirstReleaseBootstrapState(
  versions: Record<string, unknown>,
  distTags: Record<string, unknown>,
  expectedPackageName: string,
): void {
  const publishedVersions = Object.keys(versions).sort();
  const tagNames = Object.keys(distTags).sort();
  if (
    distTags.bootstrap !== FIRST_RELEASE_BOOTSTRAP_VERSION ||
    publishedVersions.length !== 1 ||
    publishedVersions[0] !== FIRST_RELEASE_BOOTSTRAP_VERSION ||
    tagNames.length !== 2 ||
    tagNames[0] !== 'bootstrap' ||
    tagNames[1] !== 'latest'
  ) {
    throw new Error('npm prerelease latest does not match the exact first-release bootstrap state');
  }
  const bootstrapManifest = record(
    versions[FIRST_RELEASE_BOOTSTRAP_VERSION],
    'npm bootstrap version manifest',
  );
  if (
    bootstrapManifest.name !== expectedPackageName ||
    bootstrapManifest.version !== FIRST_RELEASE_BOOTSTRAP_VERSION
  ) {
    throw new Error('npm bootstrap version manifest identity is invalid');
  }
}

/** Fail closed when a release would overwrite npm's latest tag with an older or ambiguous version. */
export function verifyNpmReleaseOrder(
  metadata: unknown,
  expectedPackageName: string,
  candidateVersion: string,
): NpmReleaseOrder {
  strictSemverParts(candidateVersion, 'Candidate npm version');
  const root = record(metadata, 'npm package metadata');
  if (root.name !== expectedPackageName) {
    throw new Error('npm package metadata identity does not match package.json');
  }
  const versions = record(root.versions, 'npm package metadata.versions');
  const distTags = record(root['dist-tags'], 'npm package metadata.dist-tags');
  if (distTags.latest === undefined) {
    throw new Error('Published npm package metadata is missing the latest dist-tag');
  }
  const latest = string(distTags.latest, 'npm package metadata.dist-tags.latest');
  if (latest === FIRST_RELEASE_BOOTSTRAP_VERSION) {
    if (candidateVersion !== FIRST_STABLE_VERSION) {
      throw new Error(`npm bootstrap state may advance only to ${FIRST_STABLE_VERSION}`);
    }
    requireExactFirstReleaseBootstrapState(versions, distTags, expectedPackageName);
    return 'advance';
  }
  strictSemverParts(latest, 'Current npm latest version');
  if (!Object.hasOwn(versions, latest)) {
    throw new Error('npm latest tag does not name a published package version');
  }
  if (Object.hasOwn(versions, candidateVersion)) {
    if (latest !== candidateVersion) {
      throw new Error('A stale release rerun cannot replace a newer npm latest version');
    }
    return 'rerun';
  }
  if (compareStrictSemver(candidateVersion, latest) <= 0) {
    throw new Error('Candidate npm version must advance the current latest version');
  }
  return 'advance';
}

function digest(bytes: Uint8Array, algorithm: 'sha1' | 'sha256' | 'sha512'): string {
  return createHash(algorithm).update(bytes).digest('hex');
}

export function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function expectedTarballName(packageName: string, version: string): string {
  return `${packageName.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`;
}

export function verifyReleaseArtifact(
  manifestBytes: Uint8Array,
  tarballBytes: Uint8Array,
  packageName: string,
  version: string,
): VerifiedReleaseArtifact {
  const parsed = JSON.parse(
    Buffer.from(manifestBytes)
      .toString('utf8')
      .replace(/^\uFEFF/u, ''),
  ) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('npm-pack.json must contain exactly one pack result');
  }
  const value = record(parsed[0], 'npm-pack.json[0]');
  const manifest: PackManifest = {
    filename: string(value.filename, 'npm-pack.json[0].filename'),
    files: records(value.files, 'npm-pack.json[0].files').map((file, index) => ({
      mode: number(file.mode, `npm-pack.json[0].files[${index}].mode`),
      path: string(file.path, `npm-pack.json[0].files[${index}].path`),
      size: number(file.size, `npm-pack.json[0].files[${index}].size`),
    })),
    integrity: string(value.integrity, 'npm-pack.json[0].integrity'),
    name: string(value.name, 'npm-pack.json[0].name'),
    shasum: string(value.shasum, 'npm-pack.json[0].shasum'),
    size: number(value.size, 'npm-pack.json[0].size'),
    unpackedSize: number(value.unpackedSize, 'npm-pack.json[0].unpackedSize'),
    version: string(value.version, 'npm-pack.json[0].version'),
  };

  const filename = expectedTarballName(packageName, version);
  if (
    manifest.name !== packageName ||
    manifest.version !== version ||
    manifest.filename !== filename
  ) {
    throw new Error('npm-pack.json package identity does not match package.json');
  }
  if (manifest.files.length === 0) throw new Error('npm-pack.json contains no package files');

  const sha1 = digest(tarballBytes, 'sha1');
  const sha256 = digest(tarballBytes, 'sha256');
  const sha512 = digest(tarballBytes, 'sha512');
  const integrity = sha512Integrity(tarballBytes);
  if (manifest.size !== tarballBytes.byteLength) {
    throw new Error('Tarball byte size differs from npm-pack.json');
  }
  if (manifest.shasum !== sha1 || manifest.integrity !== integrity) {
    throw new Error('Tarball digest differs from npm-pack.json');
  }

  return {
    filename,
    integrity,
    manifest,
    sha1,
    sha256,
    sha512,
    size: tarballBytes.byteLength,
  };
}

function packagePurl(packageName: string, version: string): string {
  return `pkg:npm/${packageName}@${version}`;
}

function singleSlsaAttestation(value: unknown, label: string): Record<string, unknown> {
  const root = record(value, label);
  const matches = records(root.attestations, `${label}.attestations`).filter(
    (entry) => entry.predicateType === 'https://slsa.dev/provenance/v1',
  );
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one SLSA provenance v1 attestation`);
  }
  return matches[0]!;
}

function verifiedNpmAttestation(
  auditReport: unknown,
  expected: ExpectedProvenance,
): Record<string, unknown> {
  const audit = record(auditReport, 'npm audit signatures report');
  if (records(audit.invalid, 'npm audit signatures report.invalid').length !== 0) {
    throw new Error('npm audit signatures reported an invalid signature or attestation');
  }
  if (records(audit.missing, 'npm audit signatures report.missing').length !== 0) {
    throw new Error('npm audit signatures reported a missing registry signature');
  }
  const matches = records(audit.verified, 'npm audit signatures report.verified').filter(
    (entry) => entry.name === expected.packageName && entry.version === expected.version,
  );
  if (matches.length !== 1) {
    throw new Error('npm audit signatures did not uniquely verify the released package');
  }
  const verified = matches[0]!;
  if (verified.registry !== OFFICIAL_NPM_REGISTRY) {
    throw new Error('npm audit signatures used an unexpected package registry');
  }
  const bundles = records(
    verified.attestationBundles,
    'npm audit signatures verified attestationBundles',
  );
  const provenance = bundles.filter(
    (entry) => entry.predicateType === 'https://slsa.dev/provenance/v1',
  );
  if (provenance.length !== 1) {
    throw new Error('npm audit signatures did not uniquely verify SLSA provenance v1');
  }
  return provenance[0]!;
}

function verifyTransparencyMaterial(bundle: Record<string, unknown>): void {
  const material = record(bundle.verificationMaterial, 'SLSA provenance verification material');
  const hasCertificate =
    material.certificate !== undefined || material.x509CertificateChain !== undefined;
  if (!hasCertificate) throw new Error('SLSA provenance has no signing certificate material');
  const entries = records(material.tlogEntries, 'SLSA provenance transparency log entries');
  if (entries.length === 0) throw new Error('SLSA provenance has no transparency log inclusion');
  for (const [index, entry] of entries.entries()) {
    string(entry.logIndex, `SLSA provenance tlogEntries[${index}].logIndex`);
    string(entry.integratedTime, `SLSA provenance tlogEntries[${index}].integratedTime`);
    const promise = entry.inclusionPromise;
    const proof = entry.inclusionProof;
    if (promise === undefined && proof === undefined) {
      throw new Error('SLSA provenance transparency entry has no inclusion promise or proof');
    }
  }
}

export async function verifySlsaProvenance(
  auditReport: unknown,
  registryResponse: unknown,
  expectedSha512: string,
  expected: ExpectedProvenance,
  verifyBundle: SigstoreBundleVerifier,
): Promise<void> {
  const provenance = verifiedNpmAttestation(auditReport, expected);
  const registryProvenance = singleSlsaAttestation(registryResponse, 'npm attestations response');
  if (!isDeepStrictEqual(provenance, registryProvenance)) {
    throw new Error('npm audit signatures verified a replayed or stale provenance bundle');
  }

  const bundle = record(provenance.bundle, 'SLSA provenance bundle');
  const envelope = record(bundle.dsseEnvelope, 'SLSA provenance DSSE envelope');
  if (envelope.payloadType !== 'application/vnd.in-toto+json') {
    throw new Error('SLSA provenance DSSE payload type is incorrect');
  }
  const signatures = records(envelope.signatures, 'SLSA provenance DSSE signatures');
  if (signatures.length !== 1)
    throw new Error('SLSA provenance DSSE must have exactly one signature');
  string(signatures[0]!.sig, 'SLSA provenance DSSE signature');
  verifyTransparencyMaterial(bundle);
  await verifyBundle(bundle, {
    certificateIdentityURI: expected.certificateIdentity,
    certificateIssuer: expected.certificateIssuer,
    ctLogThreshold: 1,
    tlogThreshold: 1,
  });

  const payload = string(envelope.payload, 'SLSA provenance DSSE payload');
  const statement = record(
    JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as unknown,
    'SLSA provenance statement',
  );
  if (statement._type !== 'https://in-toto.io/Statement/v1') {
    throw new Error('SLSA statement type is incorrect');
  }
  if (statement.predicateType !== 'https://slsa.dev/provenance/v1') {
    throw new Error('SLSA statement predicate type is incorrect');
  }

  const subjects = records(statement.subject, 'SLSA provenance statement.subject');
  if (subjects.length !== 1) throw new Error('SLSA provenance must have exactly one npm subject');
  const subject = subjects[0]!;
  if (subject.name !== packagePurl(expected.packageName, expected.version)) {
    throw new Error('SLSA provenance has no matching npm subject');
  }
  const subjectDigest = record(subject.digest, 'SLSA provenance subject.digest');
  if (subjectDigest.sha512 !== expectedSha512) {
    throw new Error('SLSA provenance subject digest differs from the release tarball');
  }

  const predicate = record(statement.predicate, 'SLSA provenance statement.predicate');
  const buildDefinition = record(predicate.buildDefinition, 'SLSA provenance buildDefinition');
  if (buildDefinition.buildType !== expected.buildType) {
    throw new Error('SLSA provenance build type differs from npm GitHub Actions provenance');
  }
  const external = record(buildDefinition.externalParameters, 'SLSA provenance externalParameters');
  const workflow = record(external.workflow, 'SLSA provenance workflow');
  if (
    workflow.repository !== expected.repository ||
    workflow.path !== expected.workflowPath ||
    workflow.ref !== expected.workflowRef
  ) {
    throw new Error('SLSA provenance workflow identity differs from the release workflow');
  }

  const dependencies = records(
    buildDefinition.resolvedDependencies,
    'SLSA provenance resolvedDependencies',
  );
  const matchingDependencies = dependencies.filter((dependency) => {
    const dependencyDigest = record(
      dependency.digest,
      'SLSA provenance resolved dependency digest',
    );
    return (
      dependency.uri === `git+${expected.repository}@${expected.workflowRef}` &&
      dependencyDigest.gitCommit === expected.commit
    );
  });
  if (matchingDependencies.length !== 1) {
    throw new Error('SLSA provenance does not uniquely resolve to the release commit');
  }

  const runDetails = record(predicate.runDetails, 'SLSA provenance runDetails');
  const builder = record(runDetails.builder, 'SLSA provenance builder');
  if (builder.id !== expected.builderId) {
    throw new Error('SLSA provenance builder identity is incorrect');
  }
}

export function verifyRemoteTagListing(
  output: string,
  tag: string,
  expectedCommit: string,
): 'annotated' | 'lightweight' {
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) {
    throw new Error('Expected release commit must be a full lowercase Git object ID');
  }
  const reference = `refs/tags/${tag}`;
  const peeledReference = `${reference}^{}`;
  const entries = output
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^([0-9a-f]{40})\s+(\S+)$/u.exec(line);
      if (match === null) throw new Error('git ls-remote returned malformed tag data');
      return { object: match[1]!, reference: match[2]! };
    });
  if (
    entries.some((entry) => entry.reference !== reference && entry.reference !== peeledReference)
  ) {
    throw new Error('git ls-remote returned an unexpected reference');
  }
  const direct = entries.filter((entry) => entry.reference === reference);
  const peeled = entries.filter((entry) => entry.reference === peeledReference);
  if (direct.length !== 1 || peeled.length > 1) {
    throw new Error('git ls-remote did not uniquely resolve the release tag');
  }
  const resolved = peeled[0]?.object ?? direct[0]!.object;
  if (resolved !== expectedCommit)
    throw new Error('Remote release tag moved to a different commit');
  return peeled.length === 1 ? 'annotated' : 'lightweight';
}

function sha256Digest(value: unknown, label: string): string {
  const digestValue = string(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digestValue)) {
    throw new Error(`${label} must be a sha256 OCI digest`);
  }
  return digestValue;
}

export function verifyContainerReleaseManifest(
  value: unknown,
  expected: ContainerReleaseManifest,
): ContainerReleaseManifest {
  const manifest = record(value, 'container-image.json');
  const platforms = manifest.platforms;
  if (!Array.isArray(platforms) || platforms.some((entry) => typeof entry !== 'string')) {
    throw new Error('container-image.json platforms must be strings');
  }
  const platformStrings: string[] = [];
  for (const entry of platforms) {
    if (typeof entry !== 'string') throw new Error('container-image.json platform is not a string');
    platformStrings.push(entry);
  }
  const actual: ContainerReleaseManifest = {
    digest: sha256Digest(manifest.digest, 'container-image.json digest'),
    image: string(manifest.image, 'container-image.json image'),
    platforms: platformStrings,
    schemaVersion: number(manifest.schemaVersion, 'container-image.json schemaVersion'),
    sourceCommit: string(manifest.sourceCommit, 'container-image.json sourceCommit'),
    sourceRepository: string(manifest.sourceRepository, 'container-image.json sourceRepository'),
  };
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error('container-image.json differs from the expected immutable image release');
  }
  return actual;
}

function containerSubjectMatches(
  subject: Record<string, unknown>,
  expected: ExpectedContainerAttestation,
): boolean {
  const digest = record(subject.digest, 'container attestation subject.digest');
  if (typeof digest.sha256 !== 'string' || `sha256:${digest.sha256}` !== expected.subjectDigest) {
    return false;
  }
  if (typeof subject.name !== 'string') return false;
  const [identity, query = ''] = subject.name.split('?', 2);
  if (!identity?.startsWith(`pkg:docker/${expected.imageRepository}@`)) return false;
  return new URLSearchParams(query).get('platform') === expected.platform;
}

function matchingContainerSource(
  predicate: Record<string, unknown>,
  expected: ExpectedContainerAttestation,
): boolean {
  const invocation = record(predicate.invocation, 'container provenance invocation');
  const source = record(invocation.configSource, 'container provenance configSource');
  const digest = record(source.digest, 'container provenance configSource.digest');
  if (digest.sha1 !== expected.sourceCommit || typeof source.uri !== 'string') return false;
  const tagPrefix = 'refs/tags/';
  if (!expected.sourceTag.startsWith(tagPrefix)) return false;
  const tagName = expected.sourceTag.slice(tagPrefix.length);
  if (tagName.length === 0) return false;
  const repositoryPrefix = 'https://github.com/';
  if (!expected.sourceRepository.startsWith(repositoryPrefix)) return false;
  const repository = expected.sourceRepository.slice(repositoryPrefix.length);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) return false;
  const sourceUris = [
    `${expected.sourceRepository}.git#${expected.sourceTag}`,
    `${expected.sourceRepository}#${expected.sourceTag}`,
    `${expected.sourceRepository}.git#${expected.sourceCommit}`,
    `${expected.sourceRepository}#${expected.sourceCommit}`,
  ];
  if (!sourceUris.includes(source.uri) || source.entryPoint !== 'Dockerfile') return false;
  const environmentValue = invocation.environment;
  if (
    typeof environmentValue !== 'object' ||
    environmentValue === null ||
    Array.isArray(environmentValue)
  ) {
    return false;
  }
  const environment = environmentValue as Record<string, unknown>;
  return (
    environment.github_event_name === 'push' &&
    environment.github_job === 'publish_image' &&
    environment.github_ref === expected.sourceTag &&
    environment.github_ref_name === tagName &&
    environment.github_ref_type === 'tag' &&
    environment.github_repository === repository &&
    environment.github_workflow_ref ===
      `${repository}/.github/workflows/release.yml@${expected.sourceTag}` &&
    environment.github_workflow_sha === expected.sourceCommit
  );
}

export function verifyContainerAttestationStatement(
  value: unknown,
  predicateType: 'https://slsa.dev/provenance/v0.2' | 'https://spdx.dev/Document',
  expected: ExpectedContainerAttestation,
): void {
  const statement = record(value, 'container attestation statement');
  if (statement._type !== 'https://in-toto.io/Statement/v0.1') {
    throw new Error('Container attestation statement type is incorrect');
  }
  if (statement.predicateType !== predicateType) {
    throw new Error('Container attestation predicate type is incorrect');
  }
  const subjects = records(statement.subject, 'container attestation subjects');
  if (subjects.filter((subject) => containerSubjectMatches(subject, expected)).length !== 1) {
    throw new Error('Container attestation subject does not uniquely match the platform manifest');
  }
  const predicate = record(statement.predicate, 'container attestation predicate');
  if (predicateType === 'https://slsa.dev/provenance/v0.2') {
    if (predicate.buildType !== 'https://mobyproject.org/buildkit@v1') {
      throw new Error('Container provenance builder type is incorrect');
    }
    if (!matchingContainerSource(predicate, expected)) {
      throw new Error('Container provenance source tag or commit is incorrect');
    }
  } else if (predicate.spdxVersion !== 'SPDX-2.3' || predicate.SPDXID !== 'SPDXRef-DOCUMENT') {
    throw new Error('Container SBOM is not an SPDX 2.3 document');
  }
}
