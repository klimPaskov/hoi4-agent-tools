import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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
    expect(
      verifyNpmReleaseOrder(
        metadata(undefined, ['0.0.0-bootstrap.0']),
        'hoi4-agent-tools',
        '0.1.0',
      ),
    ).toBe('advance');
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
