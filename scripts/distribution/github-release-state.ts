import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export type GitHubReleaseState = 'absent' | 'complete' | 'draft';
export type ReleaseAssetCompleteness = 'exact' | 'subset';

export interface ExpectedGitHubReleaseAsset {
  bytes: Buffer;
  name: string;
}

export type ReleaseAssetDownloader = (url: string) => Promise<Buffer>;

export interface SelectedGitHubRelease {
  release: Record<string, unknown>;
  status: 200 | 404;
}

const GITHUB_RELEASE_LIST_LIMIT = 10_000;
const GITHUB_ACTIONS_BOT_ID = 41_898_282;
const GITHUB_ACTIONS_BOT_LOGIN = 'github-actions[bot]';

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function assertGitHubActionsBot(value: unknown, label: string): void {
  const actor = record(value, label);
  if (
    actor.id !== GITHUB_ACTIONS_BOT_ID ||
    actor.login !== GITHUB_ACTIONS_BOT_LOGIN ||
    actor.type !== 'Bot'
  ) {
    throw new Error(`${label} is not the canonical GitHub Actions bot`);
  }
}

export function validateGitHubReleaseMetadata(
  value: unknown,
  expectedTag: string,
  expectedBody: string,
): void {
  const release = record(value, 'GitHub release');
  const expectedName = `HOI4 Agent Tools ${expectedTag}`;
  if (release.name !== expectedName) {
    throw new Error('GitHub release title differs from the canonical title');
  }
  if (release.body !== expectedBody) {
    throw new Error('GitHub release body differs from the canonical changelog');
  }
  assertGitHubActionsBot(release.author, 'GitHub release author');
}

export function classifyGitHubRelease(
  status: number,
  value: unknown,
  expectedTag: string,
): GitHubReleaseState {
  if (status === 404) return 'absent';
  if (status !== 200) throw new Error(`GitHub release lookup returned unsafe status ${status}`);

  const release = record(value, 'GitHub release');
  positiveInteger(release.id, 'GitHub release id');
  if (release.tag_name !== expectedTag) {
    throw new Error('GitHub release tag differs from the workflow tag');
  }
  if (release.prerelease !== false) {
    throw new Error('GitHub release must not be a prerelease');
  }
  if (typeof release.draft !== 'boolean' || typeof release.immutable !== 'boolean') {
    throw new Error('GitHub release draft and immutable states must be explicit booleans');
  }
  assertGitHubActionsBot(release.author, 'GitHub release author');

  if (release.draft && !release.immutable) return 'draft';
  if (!release.draft && release.immutable) return 'complete';
  throw new Error('GitHub release is neither a mutable draft nor an immutable publication');
}

export function selectGitHubReleaseByTag(
  value: unknown,
  expectedTag: string,
): SelectedGitHubRelease {
  if (!Array.isArray(value)) throw new Error('GitHub release listing must be an array');
  if (value.length > GITHUB_RELEASE_LIST_LIMIT) {
    throw new Error('GitHub release listing exceeds the fixed verification limit');
  }

  const observedIds = new Set<number>();
  const matches: Record<string, unknown>[] = [];
  for (const [index, candidate] of value.entries()) {
    const release = record(candidate, `GitHub release listing entry ${index}`);
    const id = positiveInteger(release.id, `GitHub release listing entry ${index} id`);
    if (observedIds.has(id)) {
      throw new Error(`GitHub release listing contains duplicate release id ${String(id)}`);
    }
    observedIds.add(id);
    const tag = nonEmptyString(release.tag_name, `GitHub release listing entry ${index} tag_name`);
    if (tag === expectedTag) matches.push(release);
  }
  if (matches.length > 1) {
    throw new Error(`GitHub release listing contains ambiguous releases for tag ${expectedTag}`);
  }
  if (matches.length === 0) {
    return { status: 404, release: { message: 'Not Found' } };
  }
  return { status: 200, release: matches[0]! };
}

export function crossCheckPublishedGitHubRelease(
  selectedStatus: number,
  selectedValue: unknown,
  publishedStatus: number,
  publishedValue: unknown,
  expectedTag: string,
): void {
  const selectedState = classifyGitHubRelease(selectedStatus, selectedValue, expectedTag);
  if (selectedState !== 'complete') {
    if (publishedStatus !== 404) {
      throw new Error(
        `GitHub published-release lookup returned ${String(publishedStatus)} for ${selectedState} list state`,
      );
    }
    return;
  }
  const publishedState = classifyGitHubRelease(publishedStatus, publishedValue, expectedTag);
  if (publishedState !== 'complete') {
    throw new Error('GitHub published-release lookup did not return an immutable publication');
  }
  const selectedId = positiveInteger(
    record(selectedValue, 'selected GitHub release').id,
    'selected GitHub release id',
  );
  const publishedId = positiveInteger(
    record(publishedValue, 'published GitHub release').id,
    'published GitHub release id',
  );
  if (selectedId !== publishedId) {
    throw new Error('GitHub release listing and published tag lookup disagree on release id');
  }
}

function releaseAssets(value: unknown): Record<string, unknown>[] {
  const release = record(value, 'GitHub release');
  if (!Array.isArray(release.assets)) throw new Error('GitHub release assets must be an array');
  return release.assets.map((asset, index) => record(asset, `GitHub release asset ${index}`));
}

function assertCanonicalAssetUrl(value: unknown, label: string, expectedAssetId: number): string {
  const url = new URL(nonEmptyString(value, label));
  const expectedPath = `/repos/klimPaskov/hoi4-agent-tools/releases/assets/${String(expectedAssetId)}`;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.github.com' ||
    url.pathname !== expectedPath ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw new Error(`${label} is not a canonical release-asset API URL`);
  }
  return url.href;
}

export async function validateGitHubReleaseAssets(
  value: unknown,
  expectedAssets: ReadonlyMap<string, ExpectedGitHubReleaseAsset>,
  completeness: ReleaseAssetCompleteness,
  download: ReleaseAssetDownloader,
): Promise<void> {
  if (expectedAssets.size !== 4) {
    throw new Error('GitHub release verification requires exactly four expected assets');
  }
  const assets = releaseAssets(value);
  if (completeness === 'exact' && assets.length !== expectedAssets.size) {
    throw new Error('GitHub release does not contain the exact expected asset count');
  }
  if (completeness === 'subset' && assets.length > expectedAssets.size) {
    throw new Error('GitHub draft contains more assets than the release allows');
  }

  const observed = new Set<string>();
  const observedIds = new Set<number>();
  for (const asset of assets) {
    const name = nonEmptyString(asset.name, 'GitHub release asset name');
    const id = positiveInteger(asset.id, `GitHub release asset ${name} id`);
    const expected = expectedAssets.get(name);
    if (expected === undefined) {
      throw new Error(`GitHub release contains unexpected asset ${name}`);
    }
    if (observed.has(name)) {
      throw new Error(`GitHub release contains duplicate asset ${name}`);
    }
    if (observedIds.has(id)) {
      throw new Error(`GitHub release contains duplicate asset id ${String(id)}`);
    }
    observed.add(name);
    observedIds.add(id);
    if (asset.state !== 'uploaded') {
      throw new Error(`GitHub release asset ${name} is not uploaded`);
    }
    if (asset.label !== null) {
      throw new Error(`GitHub release asset ${name} must not override its canonical filename`);
    }
    assertGitHubActionsBot(asset.uploader, `GitHub release asset ${name} uploader`);
    if (asset.size !== expected.bytes.byteLength) {
      throw new Error(`GitHub release asset ${name} has the wrong size`);
    }
    const digest = `sha256:${createHash('sha256').update(expected.bytes).digest('hex')}`;
    if (asset.digest !== digest) {
      throw new Error(`GitHub release asset ${name} has the wrong digest`);
    }
    const url = assertCanonicalAssetUrl(asset.url, `GitHub release asset ${name} URL`, id);
    const downloaded = await download(url);
    if (!downloaded.equals(expected.bytes)) {
      throw new Error(`GitHub release asset ${name} bytes differ from the workflow artifact`);
    }
  }

  if (completeness === 'exact') {
    for (const name of expectedAssets.keys()) {
      if (!observed.has(name)) throw new Error(`GitHub release is missing asset ${name}`);
    }
  }
}

async function loadExpectedAssets(
  paths: string[],
): Promise<Map<string, ExpectedGitHubReleaseAsset>> {
  if (paths.length !== 4) throw new Error('Exactly four expected release asset paths are required');
  const expected = new Map<string, ExpectedGitHubReleaseAsset>();
  for (const filePath of paths) {
    const name = path.basename(filePath);
    if (name.length === 0 || expected.has(name)) {
      throw new Error('Expected release asset names must be unique non-empty basenames');
    }
    expected.set(name, { bytes: await readFile(filePath), name });
  }
  return expected;
}

async function downloadReleaseAsset(url: string): Promise<Buffer> {
  const token = process.env.GH_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error('GH_TOKEN is required to verify draft release assets');
  }
  const response = await fetch(url, {
    headers: {
      accept: 'application/octet-stream',
      authorization: `Bearer ${token}`,
      'cache-control': 'no-cache',
      'user-agent': 'hoi4-agent-tools-release-state-verifier',
      'x-github-api-version': '2026-03-10',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`GitHub release asset download returned ${response.status}`);
  if (new URL(response.url).protocol !== 'https:') {
    throw new Error('GitHub release asset redirected away from HTTPS');
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === 'select-list') {
    const [listingPath, expectedTag, outputPath, ...extra] = arguments_;
    if (
      listingPath === undefined ||
      expectedTag === undefined ||
      outputPath === undefined ||
      extra.length !== 0
    ) {
      throw new Error(
        'Usage: github-release-state.ts select-list <release-list-json> <tag> <selected-release-json>',
      );
    }
    const listing = parseJson(await readFile(listingPath), 'GitHub release listing');
    const selected = selectGitHubReleaseByTag(listing, expectedTag);
    await writeFile(outputPath, `${JSON.stringify(selected.release)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    process.stdout.write(`${String(selected.status)}\n`);
    return;
  }
  if (command === 'cross-check') {
    const [
      selectedStatusText,
      selectedPath,
      publishedStatusText,
      publishedPath,
      expectedTag,
      ...extra
    ] = arguments_;
    if (
      selectedStatusText === undefined ||
      selectedPath === undefined ||
      publishedStatusText === undefined ||
      publishedPath === undefined ||
      expectedTag === undefined ||
      extra.length !== 0
    ) {
      throw new Error(
        'Usage: github-release-state.ts cross-check <selected-status> <selected-json> <published-status> <published-json> <tag>',
      );
    }
    const selectedStatus = Number(selectedStatusText);
    const publishedStatus = Number(publishedStatusText);
    if (!Number.isInteger(selectedStatus) || !Number.isInteger(publishedStatus)) {
      throw new Error('GitHub release HTTP statuses must be integers');
    }
    crossCheckPublishedGitHubRelease(
      selectedStatus,
      parseJson(await readFile(selectedPath), 'selected GitHub release response'),
      publishedStatus,
      parseJson(await readFile(publishedPath), 'published GitHub release response'),
      expectedTag,
    );
    process.stdout.write('consistent\n');
    return;
  }

  const [statusText, releasePath, expectedTag, expectedBodyPath, ...assetPaths] = arguments_;
  if (
    command === undefined ||
    statusText === undefined ||
    releasePath === undefined ||
    expectedTag === undefined ||
    expectedBodyPath === undefined
  ) {
    throw new Error(
      'Usage: github-release-state.ts <classify|draft-exact|complete-exact> <status> <release-json> <tag> <release-body-path> <four asset paths>',
    );
  }
  const status = Number(statusText);
  if (!Number.isInteger(status)) throw new Error('GitHub release HTTP status must be an integer');
  const release = parseJson(await readFile(releasePath), 'GitHub release response');
  const state = classifyGitHubRelease(status, release, expectedTag);
  if (command === 'classify' && state === 'absent') {
    process.stdout.write('absent\n');
    return;
  }

  validateGitHubReleaseMetadata(release, expectedTag, await readFile(expectedBodyPath, 'utf8'));

  const expectedAssets = await loadExpectedAssets(assetPaths);
  if (command === 'classify') {
    await validateGitHubReleaseAssets(
      release,
      expectedAssets,
      state === 'draft' ? 'subset' : 'exact',
      downloadReleaseAsset,
    );
    process.stdout.write(`${state}\n`);
    return;
  }
  if (command === 'draft-exact') {
    if (state !== 'draft') throw new Error('GitHub release is not a resumable draft');
    await validateGitHubReleaseAssets(release, expectedAssets, 'exact', downloadReleaseAsset);
    process.stdout.write(
      `${positiveInteger(record(release, 'GitHub release').id, 'release id')}\n`,
    );
    return;
  }
  if (command === 'complete-exact') {
    if (state !== 'complete') throw new Error('GitHub release is not immutable and complete');
    await validateGitHubReleaseAssets(release, expectedAssets, 'exact', downloadReleaseAsset);
    process.stdout.write('complete\n');
    return;
  }
  throw new Error(`Unsupported GitHub release verification command: ${command}`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
