import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { rateLimitClientAddress } from '../../src/hoi4_agent_tools/mcp/transports/http.js';

const configuration = serverConfigurationSchema.parse({
  version: 1,
  http: { trustedProxyAddresses: ['10.0.0.1', '10.0.0.2'] },
});
const request = (remoteAddress: string, forwarded?: string) =>
  ({
    socket: { remoteAddress },
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  }) as unknown as Request;

describe('rate-limit client address', () => {
  it('uses the socket address when the peer is not a trusted proxy', () => {
    expect(rateLimitClientAddress(request('203.0.113.5', '1.2.3.4'), configuration)).toBe(
      '203.0.113.5',
    );
  });

  it('ignores addresses a client prepends and takes the last untrusted hop', () => {
    // The client sent "1.2.3.4"; the trusted proxies appended the real client and themselves.
    expect(
      rateLimitClientAddress(request('10.0.0.1', '1.2.3.4, 198.51.100.7, 10.0.0.2'), configuration),
    ).toBe('198.51.100.7');
    expect(rateLimitClientAddress(request('10.0.0.1', 'not-an-address'), configuration)).toBe(
      undefined,
    );
  });
});
