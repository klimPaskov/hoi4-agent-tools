import { PACKAGE_NAME, PACKAGE_VERSION } from '../../version.js';

export const MCP_REGISTRY_SCHEMA_URL =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
export const MCP_REGISTRY_SERVER_NAME = 'io.github.klimPaskov/hoi4-agent-tools';

/** Canonical identity fields shared by Registry validation and release tooling. */
export const MCP_REGISTRY_IDENTITY = {
  name: MCP_REGISTRY_SERVER_NAME,
  packageName: PACKAGE_NAME,
  version: PACKAGE_VERSION,
} as const;
