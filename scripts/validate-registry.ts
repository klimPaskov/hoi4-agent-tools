import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import Ajv from 'ajv/dist/ajv.js';
import addFormats from 'ajv-formats/dist/index.js';
import {
  MCP_REGISTRY_IDENTITY,
  MCP_REGISTRY_SCHEMA_URL,
} from '../src/hoi4_agent_tools/mcp/registry/metadata.js';

type Validator = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvLike {
  compile(schema: object): Validator;
  errorsText(errors: unknown): string;
}

const root = path.resolve(import.meta.dirname, '..');
const server = JSON.parse(await readFile(path.join(root, 'server.json'), 'utf8')) as Record<
  string,
  unknown
>;
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Record<
  string,
  unknown
>;
const schemaUrl = server.$schema;
if (typeof schemaUrl !== 'string') {
  throw new Error('server.json must contain an official schema URL');
}
const serverName = server.name;
if (typeof serverName !== 'string') throw new Error('server.json must contain a string name');
if (!schemaUrl.startsWith('https://static.modelcontextprotocol.io/schemas/')) {
  throw new Error('server.json must reference a pinned official MCP Registry schema');
}
if (schemaUrl !== MCP_REGISTRY_SCHEMA_URL) {
  throw new Error('server.json and the compiled Registry schema baseline differ');
}
const response = await fetch(schemaUrl);
if (!response.ok) throw new Error(`Unable to fetch Registry schema: ${response.status}`);
const schema = (await response.json()) as object;
const AjvConstructor = Ajv as unknown as new (options: Record<string, unknown>) => AjvLike;
const ajv = new AjvConstructor({ allErrors: true, strict: false });
(addFormats as unknown as (instance: AjvLike) => void)(ajv);
const validate = ajv.compile(schema);
if (!validate(server))
  throw new Error(`server.json is invalid:\n${ajv.errorsText(validate.errors)}`);

const version = String(packageJson.version);
if (
  packageJson.name !== MCP_REGISTRY_IDENTITY.packageName ||
  version !== MCP_REGISTRY_IDENTITY.version ||
  serverName !== MCP_REGISTRY_IDENTITY.name
) {
  throw new Error('Registry source identity differs from package.json or server.json');
}
if (server.version !== version) throw new Error('server.json and package.json versions differ');
if (packageJson.mcpName !== serverName)
  throw new Error('package.json mcpName and server.json name differ');
const packages = server.packages as Array<Record<string, unknown>>;
const ownPackage = packages.find(({ registryType }) => registryType === 'npm');
if (ownPackage?.identifier !== packageJson.name || ownPackage.version !== version) {
  throw new Error('server.json npm package identifier/version differs from package.json');
}

if (process.env.REGISTRY_LIVE_VALIDATION === '1') {
  const live = await fetch('https://registry.modelcontextprotocol.io/v0.1/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(server),
  });
  const body = (await live.json()) as { valid?: boolean; issues?: unknown };
  if (!live.ok || body.valid !== true) {
    const issues = JSON.stringify(body.issues);
    throw new Error(`Live Registry validation failed (${live.status}): ${issues}`);
  }
}

process.stderr.write(`Registry metadata valid for ${serverName}@${version}\n`);
