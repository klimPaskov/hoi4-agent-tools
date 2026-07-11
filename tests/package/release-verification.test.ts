import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyGitHubRelease,
  crossCheckPublishedGitHubRelease,
  selectGitHubReleaseByTag,
  validateGitHubReleaseAssets,
  validateGitHubReleaseMetadata,
  type ExpectedGitHubReleaseAsset,
  type ReleaseAssetDownloader,
} from '../../scripts/distribution/github-release-state.js';
import {
  sha512Integrity,
  verifyContainerAttestationStatement,
  verifyNpmReleaseOrder,
  verifyReleaseArtifact,
  verifyRemoteTagListing,
  verifySlsaProvenance,
  type ExpectedProvenance,
  type SigstoreBundleVerifier,
} from '../../scripts/distribution/release-verification.js';

function hash(bytes: Uint8Array, algorithm: 'sha1' | 'sha512'): string {
  return createHash(algorithm).update(bytes).digest('hex');
}

interface MutableProvenanceEntry {
  bundle: {
    dsseEnvelope: { signatures: Array<{ sig: string }> };
    verificationMaterial: { tlogEntries: unknown[] };
  };
  predicateType: string;
}

interface MutableAuditReport {
  verified: Array<{ attestationBundles: MutableProvenanceEntry[] }>;
}

interface MutableRegistryResponse {
  attestations: MutableProvenanceEntry[];
}

function provenanceFixture(): {
  audit: unknown;
  expected: ExpectedProvenance;
  registry: unknown;
  sha512: string;
} {
  const sha512 = 'a'.repeat(128);
  const expected: ExpectedProvenance = {
    buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
    builderId: 'https://github.com/actions/runner/github-hosted',
    certificateIdentity:
      'https://github.com/klimPaskov/hoi4-agent-tools/.github/workflows/release.yml@refs/tags/v0.1.0',
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    commit: '0123456789abcdef0123456789abcdef01234567',
    packageName: 'hoi4-agent-tools',
    repository: 'https://github.com/klimPaskov/hoi4-agent-tools',
    version: '0.1.0',
    workflowPath: '.github/workflows/release.yml',
    workflowRef: 'refs/tags/v0.1.0',
  };
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'pkg:npm/hoi4-agent-tools@0.1.0', digest: { sha512 } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: expected.buildType,
        externalParameters: {
          workflow: {
            repository: expected.repository,
            path: expected.workflowPath,
            ref: expected.workflowRef,
          },
        },
        resolvedDependencies: [
          {
            uri: `git+${expected.repository}@${expected.workflowRef}`,
            digest: { gitCommit: expected.commit },
          },
        ],
      },
      runDetails: { builder: { id: expected.builderId } },
    },
  };
  const provenance = {
    predicateType: 'https://slsa.dev/provenance/v1',
    bundle: {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement), 'utf8').toString('base64'),
        payloadType: 'application/vnd.in-toto+json',
        signatures: [{ sig: 'c3ludGhldGljLXNpZ25hdHVyZQ==' }],
      },
      verificationMaterial: {
        certificate: { rawBytes: 'c3ludGhldGljLWNlcnRpZmljYXRl' },
        tlogEntries: [
          {
            integratedTime: '1700000000',
            logIndex: '1234',
            inclusionPromise: { signedEntryTimestamp: 'c3ludGhldGljLXNldA==' },
          },
        ],
      },
    },
  };
  return {
    audit: {
      invalid: [],
      missing: [],
      verified: [
        {
          name: expected.packageName,
          version: expected.version,
          registry: 'https://registry.npmjs.org/',
          attestationBundles: [provenance],
        },
      ],
    },
    expected,
    registry: { attestations: [structuredClone(provenance)] },
    sha512,
  };
}

describe('immutable GitHub release state verification', () => {
  const tag = 'v0.1.0';
  const canonicalBody = '# Changelog\n';
  const githubActionsBot = {
    id: 41_898_282,
    login: 'github-actions[bot]',
    type: 'Bot',
  };
  const baseRelease = {
    assets: [],
    author: githubActionsBot,
    body: canonicalBody,
    id: 123,
    immutable: false,
    name: `HOI4 Agent Tools ${tag}`,
    prerelease: false,
    draft: true,
    tag_name: tag,
  };

  it('requires canonical release title, body, and GitHub Actions authorship', () => {
    expect(() => validateGitHubReleaseMetadata(baseRelease, tag, canonicalBody)).not.toThrow();
    expect(() =>
      validateGitHubReleaseMetadata(
        { ...baseRelease, name: 'Untrusted title' },
        tag,
        canonicalBody,
      ),
    ).toThrow(/canonical title/iu);
    expect(() =>
      validateGitHubReleaseMetadata({ ...baseRelease, body: 'Untrusted body' }, tag, canonicalBody),
    ).toThrow(/canonical changelog/iu);
    expect(() =>
      validateGitHubReleaseMetadata(
        { ...baseRelease, author: { id: 1, login: 'attacker', type: 'User' } },
        tag,
        canonicalBody,
      ),
    ).toThrow(/canonical GitHub Actions bot/iu);
    expect(() =>
      classifyGitHubRelease(
        200,
        { ...baseRelease, author: { id: 1, login: 'github-actions[bot]', type: 'Bot' } },
        tag,
      ),
    ).toThrow(/canonical GitHub Actions bot/iu);
  });

  it('classifies only absent, mutable-draft, and immutable-complete states', () => {
    expect(classifyGitHubRelease(404, { message: 'Not Found' }, tag)).toBe('absent');
    expect(classifyGitHubRelease(200, baseRelease, tag)).toBe('draft');
    expect(classifyGitHubRelease(200, { ...baseRelease, draft: false, immutable: true }, tag)).toBe(
      'complete',
    );

    expect(() => classifyGitHubRelease(500, baseRelease, tag)).toThrow(/unsafe status/iu);
    expect(() => classifyGitHubRelease(200, { ...baseRelease, tag_name: 'v0.1.1' }, tag)).toThrow(
      /workflow tag/iu,
    );
    expect(() => classifyGitHubRelease(200, { ...baseRelease, prerelease: true }, tag)).toThrow(
      /prerelease/iu,
    );
    expect(() =>
      classifyGitHubRelease(200, { ...baseRelease, draft: false, immutable: false }, tag),
    ).toThrow(/neither/iu);
    expect(() =>
      classifyGitHubRelease(200, { ...baseRelease, draft: true, immutable: true }, tag),
    ).toThrow(/neither/iu);
  });

  it('selects one exact draft or publication from an authenticated paginated listing', () => {
    const unrelated = { ...baseRelease, id: 122, tag_name: 'v0.0.9' };
    expect(selectGitHubReleaseByTag([unrelated, baseRelease], tag)).toEqual({
      status: 200,
      release: baseRelease,
    });
    expect(selectGitHubReleaseByTag([unrelated], tag)).toEqual({
      status: 404,
      release: { message: 'Not Found' },
    });
    expect(() => selectGitHubReleaseByTag([baseRelease, { ...baseRelease, id: 124 }], tag)).toThrow(
      /ambiguous releases/iu,
    );
    expect(() =>
      selectGitHubReleaseByTag([baseRelease, { ...unrelated, id: baseRelease.id }], tag),
    ).toThrow(/duplicate release id/iu);
    expect(() => selectGitHubReleaseByTag([{ ...baseRelease, tag_name: '' }], tag)).toThrow(
      /tag_name must be a non-empty string/iu,
    );
    expect(() => selectGitHubReleaseByTag({ releases: [baseRelease] }, tag)).toThrow(
      /must be an array/iu,
    );
  });

  it('cross-checks list state against the published-by-tag endpoint', () => {
    const absent = { message: 'Not Found' };
    const complete = { ...baseRelease, draft: false, immutable: true };

    expect(() => crossCheckPublishedGitHubRelease(404, absent, 404, absent, tag)).not.toThrow();
    expect(() =>
      crossCheckPublishedGitHubRelease(200, baseRelease, 404, absent, tag),
    ).not.toThrow();
    expect(() => crossCheckPublishedGitHubRelease(200, complete, 200, complete, tag)).not.toThrow();
    expect(() => crossCheckPublishedGitHubRelease(200, baseRelease, 200, complete, tag)).toThrow(
      /published-release lookup returned 200 for draft/iu,
    );
    expect(() => crossCheckPublishedGitHubRelease(200, complete, 404, absent, tag)).toThrow(
      /did not return an immutable publication/iu,
    );
    expect(() =>
      crossCheckPublishedGitHubRelease(
        200,
        complete,
        200,
        { ...complete, id: complete.id + 1 },
        tag,
      ),
    ).toThrow(/disagree on release id/iu);
  });

  it('resumes only exact-byte partial drafts and requires all four assets before publication', async () => {
    const contents = new Map([
      ['hoi4-agent-tools-0.1.0.tgz', Buffer.from('tarball', 'utf8')],
      ['npm-pack.json', Buffer.from('pack', 'utf8')],
      ['release-identity.json', Buffer.from('identity', 'utf8')],
      ['container-image.json', Buffer.from('container', 'utf8')],
    ]);
    const expected = new Map<string, ExpectedGitHubReleaseAsset>(
      [...contents].map(([name, bytes]) => [name, { bytes, name }]),
    );
    const asset = (name: string, id: number) => {
      const bytes = contents.get(name)!;
      return {
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        id,
        label: null,
        name,
        size: bytes.byteLength,
        state: 'uploaded',
        uploader: githubActionsBot,
        url: `https://api.github.com/repos/klimPaskov/hoi4-agent-tools/releases/assets/${id}`,
      };
    };
    const allAssets = [...contents.keys()].map((name, index) => asset(name, index + 1));
    const downloads = new Map(allAssets.map((entry) => [entry.url, contents.get(entry.name)!]));
    const download = vi.fn<ReleaseAssetDownloader>(async (url) => downloads.get(url)!);
    const partialDraft = { ...baseRelease, assets: allAssets.slice(0, 2) };

    await expect(
      validateGitHubReleaseAssets(partialDraft, expected, 'subset', download),
    ).resolves.toBeUndefined();
    await expect(
      validateGitHubReleaseAssets(partialDraft, expected, 'exact', download),
    ).rejects.toThrow(/exact expected asset count/iu);
    await expect(
      validateGitHubReleaseAssets(
        { ...baseRelease, assets: allAssets },
        expected,
        'exact',
        download,
      ),
    ).resolves.toBeUndefined();

    await expect(
      validateGitHubReleaseAssets(
        {
          ...baseRelease,
          assets: [...allAssets.slice(0, 3), { ...allAssets[3]!, name: 'unexpected.json' }],
        },
        expected,
        'exact',
        download,
      ),
    ).rejects.toThrow(/unexpected asset/iu);
    await expect(
      validateGitHubReleaseAssets(
        {
          ...baseRelease,
          assets: [{ ...allAssets[0]!, digest: `sha256:${'0'.repeat(64)}` }],
        },
        expected,
        'subset',
        download,
      ),
    ).rejects.toThrow(/wrong digest/iu);
    await expect(
      validateGitHubReleaseAssets(
        {
          ...baseRelease,
          assets: [allAssets[0]!, { ...allAssets[1]!, id: allAssets[0]!.id }],
        },
        expected,
        'subset',
        download,
      ),
    ).rejects.toThrow(/duplicate asset id/iu);
    await expect(
      validateGitHubReleaseAssets(
        {
          ...baseRelease,
          assets: [{ ...allAssets[0]!, url: allAssets[1]!.url }],
        },
        expected,
        'subset',
        download,
      ),
    ).rejects.toThrow(/canonical release-asset API URL/iu);
    await expect(
      validateGitHubReleaseAssets(
        {
          ...baseRelease,
          assets: [{ ...allAssets[0]!, label: 'Misleading download' }],
        },
        expected,
        'subset',
        download,
      ),
    ).rejects.toThrow(/canonical filename/iu);
    await expect(
      validateGitHubReleaseAssets(
        {
          ...baseRelease,
          assets: [
            {
              ...allAssets[0]!,
              uploader: { id: 1, login: 'attacker', type: 'User' },
            },
          ],
        },
        expected,
        'subset',
        download,
      ),
    ).rejects.toThrow(/canonical GitHub Actions bot/iu);
    const changedDownload: ReleaseAssetDownloader = async (url) => {
      const bytes = downloads.get(url)!;
      return url === allAssets[0]!.url ? Buffer.from('changed', 'utf8') : bytes;
    };
    await expect(
      validateGitHubReleaseAssets(
        { ...baseRelease, assets: [allAssets[0]!] },
        expected,
        'subset',
        changedDownload,
      ),
    ).rejects.toThrow(/bytes differ/iu);
  });
});

describe('release artifact verification', () => {
  it('permits only a monotonic npm latest advance or exact latest rerun', () => {
    const metadata = (latest: string | undefined, versions: string[]) => ({
      name: 'hoi4-agent-tools',
      'dist-tags': latest === undefined ? { bootstrap: '0.0.0-bootstrap.0' } : { latest },
      versions: Object.fromEntries(versions.map((version) => [version, { version }])),
    });

    expect(verifyNpmReleaseOrder(metadata('0.1.0', ['0.1.0']), 'hoi4-agent-tools', '0.1.0')).toBe(
      'rerun',
    );
    expect(verifyNpmReleaseOrder(metadata('0.1.0', ['0.1.0']), 'hoi4-agent-tools', '0.2.0')).toBe(
      'advance',
    );
    expect(() =>
      verifyNpmReleaseOrder(
        metadata(undefined, ['0.0.0-bootstrap.0']),
        'hoi4-agent-tools',
        '0.1.0',
      ),
    ).toThrow(/missing the latest/iu);
    expect(() =>
      verifyNpmReleaseOrder(metadata('0.2.0', ['0.1.0', '0.2.0']), 'hoi4-agent-tools', '0.1.0'),
    ).toThrow(/stale release rerun/iu);
    expect(() =>
      verifyNpmReleaseOrder(metadata('0.2.0', ['0.2.0']), 'hoi4-agent-tools', '0.1.0'),
    ).toThrow(/must advance/iu);
    expect(() =>
      verifyNpmReleaseOrder(metadata('next', ['next']), 'hoi4-agent-tools', '0.2.0'),
    ).toThrow(/semantic version/iu);
    expect(() =>
      verifyNpmReleaseOrder(metadata('0.2.0', ['0.1.0']), 'hoi4-agent-tools', '0.3.0'),
    ).toThrow(/does not name/iu);
  });

  it('permits only the exact immutable bootstrap state before the first stable release', () => {
    const metadata = (distTags: Record<string, string>, versions: string[]) => ({
      name: 'hoi4-agent-tools',
      'dist-tags': distTags,
      versions: Object.fromEntries(
        versions.map((version) => [version, { name: 'hoi4-agent-tools', version }]),
      ),
    });
    const bootstrapVersion = '0.0.0-bootstrap.1';
    const exactTags = { bootstrap: bootstrapVersion, latest: bootstrapVersion };
    const exact = metadata(exactTags, [bootstrapVersion]);

    expect(verifyNpmReleaseOrder(exact, 'hoi4-agent-tools', '0.1.1')).toBe('advance');
    for (const candidate of ['0.1.0', '0.1.2']) {
      expect(() => verifyNpmReleaseOrder(exact, 'hoi4-agent-tools', candidate)).toThrow(
        /may advance only to 0\.1\.1/iu,
      );
    }
    expect(() => verifyNpmReleaseOrder(exact, 'hoi4-agent-tools', '0.1.1-rc.1')).toThrow(
      /strict stable semantic version/iu,
    );
    expect(() =>
      verifyNpmReleaseOrder(
        metadata({ bootstrap: bootstrapVersion }, [bootstrapVersion]),
        'hoi4-agent-tools',
        '0.1.1',
      ),
    ).toThrow(/missing the latest/iu);
    expect(() =>
      verifyNpmReleaseOrder(
        metadata({ latest: bootstrapVersion }, [bootstrapVersion]),
        'hoi4-agent-tools',
        '0.1.1',
      ),
    ).toThrow(/exact first-release bootstrap state/iu);
    expect(() =>
      verifyNpmReleaseOrder(
        metadata({ bootstrap: '0.0.0-bootstrap.0', latest: bootstrapVersion }, [bootstrapVersion]),
        'hoi4-agent-tools',
        '0.1.1',
      ),
    ).toThrow(/exact first-release bootstrap state/iu);
    expect(() =>
      verifyNpmReleaseOrder(
        metadata({ ...exactTags, next: bootstrapVersion }, [bootstrapVersion]),
        'hoi4-agent-tools',
        '0.1.1',
      ),
    ).toThrow(/exact first-release bootstrap state/iu);
    expect(() =>
      verifyNpmReleaseOrder(metadata(exactTags, []), 'hoi4-agent-tools', '0.1.1'),
    ).toThrow(/exact first-release bootstrap state/iu);
    expect(() =>
      verifyNpmReleaseOrder(
        metadata(exactTags, [bootstrapVersion, '0.0.0-bootstrap.2']),
        'hoi4-agent-tools',
        '0.1.1',
      ),
    ).toThrow(/exact first-release bootstrap state/iu);
    expect(() =>
      verifyNpmReleaseOrder(
        metadata(exactTags, [bootstrapVersion, '0.1.0']),
        'hoi4-agent-tools',
        '0.1.1',
      ),
    ).toThrow(/exact first-release bootstrap state/iu);
    for (const invalidManifest of [
      null,
      { name: 'attacker', version: bootstrapVersion },
      { name: 'hoi4-agent-tools', version: '0.0.0-bootstrap.0' },
    ]) {
      expect(() =>
        verifyNpmReleaseOrder(
          { ...exact, versions: { [bootstrapVersion]: invalidManifest } },
          'hoi4-agent-tools',
          '0.1.1',
        ),
      ).toThrow(/bootstrap version manifest/iu);
    }
    expect(() =>
      verifyNpmReleaseOrder(
        metadata({ bootstrap: '0.0.0-bootstrap.2', latest: '0.0.0-bootstrap.2' }, [
          '0.0.0-bootstrap.2',
        ]),
        'hoi4-agent-tools',
        '0.1.1',
      ),
    ).toThrow(/strict stable semantic version/iu);
    expect(() =>
      verifyNpmReleaseOrder({ ...exact, 'dist-tags': null }, 'hoi4-agent-tools', '0.1.1'),
    ).toThrow(/dist-tags/iu);
    expect(() =>
      verifyNpmReleaseOrder({ ...exact, versions: null }, 'hoi4-agent-tools', '0.1.1'),
    ).toThrow(/versions/iu);

    const published = metadata({ bootstrap: bootstrapVersion, latest: '0.1.1' }, [
      bootstrapVersion,
      '0.1.1',
    ]);
    expect(verifyNpmReleaseOrder(published, 'hoi4-agent-tools', '0.1.1')).toBe('rerun');
    expect(verifyNpmReleaseOrder(published, 'hoi4-agent-tools', '0.1.2')).toBe('advance');
  });

  it('binds npm-pack.json to the exact tarball bytes and identity', () => {
    const tarball = Buffer.from('synthetic deterministic package bytes', 'utf8');
    const manifest = Buffer.from(
      `${JSON.stringify([
        {
          filename: 'hoi4-agent-tools-0.1.0.tgz',
          files: [{ mode: 420, path: 'package.json', size: 10 }],
          integrity: sha512Integrity(tarball),
          name: 'hoi4-agent-tools',
          shasum: hash(tarball, 'sha1'),
          size: tarball.length,
          unpackedSize: 10,
          version: '0.1.0',
        },
      ])}\n`,
      'utf8',
    );

    const result = verifyReleaseArtifact(manifest, tarball, 'hoi4-agent-tools', '0.1.0');
    expect(result.filename).toBe('hoi4-agent-tools-0.1.0.tgz');
    expect(result.integrity).toBe(sha512Integrity(tarball));
    expect(() =>
      verifyReleaseArtifact(
        manifest,
        Buffer.concat([tarball, Buffer.from('changed')]),
        'hoi4-agent-tools',
        '0.1.0',
      ),
    ).toThrow(/size|digest/u);
  });

  it('cryptographically gates exact npm OIDC, workflow, builder, subject, and commit identity', async () => {
    const fixture = provenanceFixture();
    const verifier = vi.fn<SigstoreBundleVerifier>().mockResolvedValue(undefined);
    await expect(
      verifySlsaProvenance(
        fixture.audit,
        fixture.registry,
        fixture.sha512,
        fixture.expected,
        verifier,
      ),
    ).resolves.toBeUndefined();
    expect(verifier).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        certificateIdentityURI: fixture.expected.certificateIdentity,
        certificateIssuer: fixture.expected.certificateIssuer,
        ctLogThreshold: 1,
        tlogThreshold: 1,
      }),
    );

    await expect(
      verifySlsaProvenance(
        fixture.audit,
        fixture.registry,
        fixture.sha512,
        { ...fixture.expected, builderId: 'https://attacker.invalid/builder' },
        verifier,
      ),
    ).rejects.toThrow(/builder identity/iu);
    await expect(
      verifySlsaProvenance(
        fixture.audit,
        fixture.registry,
        fixture.sha512,
        { ...fixture.expected, workflowRef: 'refs/tags/v0.1.1' },
        verifier,
      ),
    ).rejects.toThrow(/workflow identity/iu);
    const identityVerifier: SigstoreBundleVerifier = async (_bundle, policy) => {
      if (policy.certificateIdentityURI !== fixture.expected.certificateIdentity) {
        throw new Error('certificate identity mismatch');
      }
    };
    await expect(
      verifySlsaProvenance(
        fixture.audit,
        fixture.registry,
        fixture.sha512,
        { ...fixture.expected, certificateIdentity: 'https://attacker.invalid/workflow.yml' },
        identityVerifier,
      ),
    ).rejects.toThrow(/certificate identity/iu);
    await expect(
      verifySlsaProvenance(
        fixture.audit,
        fixture.registry,
        'b'.repeat(128),
        fixture.expected,
        verifier,
      ),
    ).rejects.toThrow(/subject digest/iu);
    await expect(
      verifySlsaProvenance(
        fixture.audit,
        fixture.registry,
        fixture.sha512,
        { ...fixture.expected, commit: 'f'.repeat(40) },
        verifier,
      ),
    ).rejects.toThrow(/release commit/iu);
  });

  it('rejects unsigned, invalidly signed, unlogged, and replayed npm provenance', async () => {
    const unsigned = provenanceFixture();
    const unsignedAudit = structuredClone(unsigned.audit) as MutableAuditReport;
    unsignedAudit.verified[0]!.attestationBundles[0]!.bundle.dsseEnvelope.signatures = [];
    const unsignedRegistry = structuredClone(unsignedAudit.verified[0]!.attestationBundles[0]!);
    await expect(
      verifySlsaProvenance(
        unsignedAudit,
        { attestations: [unsignedRegistry] },
        unsigned.sha512,
        unsigned.expected,
        vi.fn<SigstoreBundleVerifier>(),
      ),
    ).rejects.toThrow(/signature/iu);

    const invalid = provenanceFixture();
    await expect(
      verifySlsaProvenance(
        invalid.audit,
        invalid.registry,
        invalid.sha512,
        invalid.expected,
        vi
          .fn<SigstoreBundleVerifier>()
          .mockRejectedValue(new Error('signature verification failed')),
      ),
    ).rejects.toThrow(/signature verification failed/iu);

    const unlogged = provenanceFixture();
    const unloggedAudit = structuredClone(unlogged.audit) as MutableAuditReport;
    unloggedAudit.verified[0]!.attestationBundles[0]!.bundle.verificationMaterial.tlogEntries = [];
    const unloggedRegistry = structuredClone(unloggedAudit.verified[0]!.attestationBundles[0]!);
    await expect(
      verifySlsaProvenance(
        unloggedAudit,
        { attestations: [unloggedRegistry] },
        unlogged.sha512,
        unlogged.expected,
        vi.fn<SigstoreBundleVerifier>(),
      ),
    ).rejects.toThrow(/transparency log/iu);

    const replayed = provenanceFixture();
    const replayedRegistry = structuredClone(replayed.registry) as MutableRegistryResponse;
    replayedRegistry.attestations[0]!.bundle.dsseEnvelope.signatures[0]!.sig = 'cmVwbGF5ZWQ=';
    await expect(
      verifySlsaProvenance(
        replayed.audit,
        replayedRegistry,
        replayed.sha512,
        replayed.expected,
        vi.fn<SigstoreBundleVerifier>(),
      ),
    ).rejects.toThrow(/replayed|stale/iu);
  });

  it('peels lightweight and annotated tags and rejects moved or ambiguous tags', () => {
    const commit = 'a'.repeat(40);
    expect(verifyRemoteTagListing(`${commit}\trefs/tags/v0.1.0\n`, 'v0.1.0', commit)).toBe(
      'lightweight',
    );
    expect(
      verifyRemoteTagListing(
        `${'b'.repeat(40)}\trefs/tags/v0.1.0\n${commit}\trefs/tags/v0.1.0^{}\n`,
        'v0.1.0',
        commit,
      ),
    ).toBe('annotated');
    expect(() =>
      verifyRemoteTagListing(`${'c'.repeat(40)}\trefs/tags/v0.1.0\n`, 'v0.1.0', commit),
    ).toThrow(/moved/iu);
    expect(() =>
      verifyRemoteTagListing(
        `${commit}\trefs/tags/v0.1.0\n${commit}\trefs/tags/v0.1.1\n`,
        'v0.1.0',
        commit,
      ),
    ).toThrow(/unexpected reference/iu);
  });

  it('binds container provenance and SBOM subjects to the platform and source commit', () => {
    const expected = {
      imageRepository: 'ghcr.io/klimpaskov/hoi4-agent-tools',
      platform: 'linux/amd64',
      sourceCommit: 'a'.repeat(40),
      sourceRepository: 'https://github.com/klimPaskov/hoi4-agent-tools',
      sourceTag: 'refs/tags/v0.1.0',
      subjectDigest: `sha256:${'b'.repeat(64)}`,
    };
    const subject = [
      {
        name: 'pkg:docker/ghcr.io/klimpaskov/hoi4-agent-tools@0.1.0?platform=linux%2Famd64',
        digest: { sha256: 'b'.repeat(64) },
      },
    ];
    const provenance = {
      _type: 'https://in-toto.io/Statement/v0.1',
      predicateType: 'https://slsa.dev/provenance/v0.2',
      subject,
      predicate: {
        buildType: 'https://mobyproject.org/buildkit@v1',
        invocation: {
          configSource: {
            uri: `${expected.sourceRepository}.git#${expected.sourceTag}`,
            digest: { sha1: expected.sourceCommit },
          },
        },
      },
    };
    const sbom = {
      _type: 'https://in-toto.io/Statement/v0.1',
      predicateType: 'https://spdx.dev/Document',
      subject,
      predicate: { SPDXID: 'SPDXRef-DOCUMENT', spdxVersion: 'SPDX-2.3' },
    };
    expect(() =>
      verifyContainerAttestationStatement(provenance, 'https://slsa.dev/provenance/v0.2', expected),
    ).not.toThrow();
    expect(() =>
      verifyContainerAttestationStatement(sbom, 'https://spdx.dev/Document', expected),
    ).not.toThrow();
    expect(() =>
      verifyContainerAttestationStatement(provenance, 'https://slsa.dev/provenance/v0.2', {
        ...expected,
        sourceCommit: 'c'.repeat(40),
      }),
    ).toThrow(/source tag or commit/iu);
    expect(() =>
      verifyContainerAttestationStatement(sbom, 'https://spdx.dev/Document', {
        ...expected,
        subjectDigest: `sha256:${'d'.repeat(64)}`,
      }),
    ).toThrow(/subject/iu);
  });
});
