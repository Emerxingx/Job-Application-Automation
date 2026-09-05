/**
 * Stage 14 (ADR-0013, ADR-0028) - the candidate API contract as code.
 *
 * `docs/api/openapi.candidate.v1.json` is the published contract. This module
 * loads it, checks its structure (every operation names a response schema,
 * every schema referenced exists, every path maps to a route file), and
 * validates a response body against a named component schema with ajv - the
 * contract tests do exactly that against the live handlers.
 *
 * FREEZE: `docs/api/openapi.candidate.v1.lock` holds the SHA-256 of the
 * canonical JSON. A test fails when the spec changes without the lock being
 * updated on purpose, and the ADR says a breaking change is a new version,
 * never an edit. Nothing here reads a database.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';

export const CONTRACT_PATH = path.join(process.cwd(), 'docs', 'api', 'openapi.candidate.v1.json');
export const CONTRACT_LOCK_PATH = path.join(process.cwd(), 'docs', 'api', 'openapi.candidate.v1.lock');

export interface OpenApiOperation {
  operationId: string;
  summary?: string;
  /** An API scope, or `public` for the one operation that has no key yet (sign-in), which must also declare `security: []`. */
  'x-scope': string;
  security?: unknown[];
  requestBody?: { required?: boolean; content?: Record<string, { schema: { $ref: string } }> };
  parameters?: { name: string; in: string; required?: boolean; schema: unknown }[];
  responses: Record<string, { description: string; content?: Record<string, { schema: { $ref: string } }> }>;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; 'x-frozen-on'?: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
  security?: unknown[];
}

/** The scope vocabulary of api-keys.ts, repeated here so this module stays free of Prisma imports. */
const KNOWN_SCOPES = new Set(['admin', 'write', 'read', 'apply:write', 'scan:read', 'match:score']);

let cached: OpenApiDocument | null = null;

export function loadContract(): OpenApiDocument {
  if (!cached) cached = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as OpenApiDocument;
  return cached;
}

/** Stable serialisation: sorted keys, no whitespace - the hash the lock records. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(sort(value));
}

export function contractHash(doc: OpenApiDocument = loadContract()): string {
  return createHash('sha256').update(canonicalJson(doc)).digest('hex');
}

export function readLock(): { version: string; sha256: string } {
  const [version, sha256] = readFileSync(CONTRACT_LOCK_PATH, 'utf8').trim().split(/\s+/);
  return { version, sha256 };
}

/** Structural problems a spec must not have - returned as words, so a test can print them all. */
export function contractProblems(doc: OpenApiDocument = loadContract()): string[] {
  const problems: string[] = [];
  if (!/^3\.1\./.test(doc.openapi)) problems.push(`openapi must be 3.1.x, got ${doc.openapi}`);
  if (!/^\d+\.\d+\.\d+$/.test(doc.info.version)) problems.push(`info.version must be semver, got ${doc.info.version}`);
  const schemas = doc.components?.schemas ?? {};
  const refOk = (ref: string) => ref.startsWith('#/components/schemas/') && ref.slice('#/components/schemas/'.length) in schemas;
  const seenIds = new Set<string>();
  for (const [route, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const where = `${method.toUpperCase()} ${route}`;
      if (!op.operationId) problems.push(`${where}: operationId missing`);
      else if (seenIds.has(op.operationId)) problems.push(`${where}: duplicate operationId ${op.operationId}`);
      else seenIds.add(op.operationId);
      if (!op['x-scope']) problems.push(`${where}: x-scope missing`);
      else if (op['x-scope'] === 'public') {
        if (!Array.isArray(op.security) || op.security.length !== 0) problems.push(`${where}: a public operation must declare security: []`);
      } else if (!KNOWN_SCOPES.has(op['x-scope'])) problems.push(`${where}: unknown x-scope ${op['x-scope']}`);
      else if (Array.isArray(op.security) && op.security.length === 0) problems.push(`${where}: security: [] on a scoped operation`);
      const bodyRef = op.requestBody?.content?.['application/json']?.schema?.$ref;
      if (op.requestBody && !bodyRef) problems.push(`${where}: requestBody without an application/json schema $ref`);
      if (bodyRef && !refOk(bodyRef)) problems.push(`${where}: unknown request schema ${bodyRef}`);
      const codes = Object.keys(op.responses);
      if (op['x-scope'] !== 'public' && !codes.includes('401')) problems.push(`${where}: every keyed operation can answer 401; document it`);
      if (!codes.includes('429')) problems.push(`${where}: every operation is rate limited and can answer 429; document it`);
      const ok = Object.entries(op.responses).filter(([code]) => code.startsWith('2'));
      if (ok.length === 0) problems.push(`${where}: no 2xx response`);
      for (const [code, res] of Object.entries(op.responses)) {
        const ref = res.content?.['application/json']?.schema?.$ref;
        if (!ref) problems.push(`${where} ${code}: no application/json schema $ref`);
        else if (!refOk(ref)) problems.push(`${where} ${code}: unknown schema ${ref}`);
        if (!code.startsWith('2') && ref && !ref.endsWith('/Error')) problems.push(`${where} ${code}: an error response must use the Error envelope`);
      }
      for (const segment of route.match(/\{(\w+)\}/g) ?? []) {
        const name = segment.slice(1, -1);
        if (!op.parameters?.some((p) => p.in === 'path' && p.name === name && p.required)) problems.push(`${where}: path parameter ${name} not declared required`);
      }
    }
  }
  // Every $ref anywhere in the schemas resolves, and every object schema is
  // CLOSED (additionalProperties: false): the validation the contract test
  // runs must fail when a serialiser starts leaking a column, which an open
  // schema would wave through (Stage 14 review).
  const walk = (v: unknown, at: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'object' && o.properties && o.additionalProperties !== false) problems.push(`${at}: object schema is not closed (additionalProperties: false)`);
      if (o.allOf) problems.push(`${at}: allOf composition cannot be closed - flatten it`);
      for (const [k, x] of Object.entries(o)) {
        if (k === '$ref' && typeof x === 'string' && !refOk(x)) problems.push(`${at}: unresolved $ref ${x}`);
        walk(x, `${at}.${k}`);
      }
    }
  };
  walk(schemas, 'components.schemas');
  return problems;
}

/** The contract's paths as route-file paths under src/app/(app)/api/v1 (`{id}` -> `[id]`). */
export function contractRouteFiles(doc: OpenApiDocument = loadContract()): string[] {
  return Object.keys(doc.paths).map((p) => p.replace(/^\/v1\//, '').replace(/\{(\w+)\}/g, '[$1]') + '/route.ts').sort();
}

const validators = new Map<string, ValidateFunction>();

function ajv(): Ajv2020 {
  const doc = loadContract();
  // OpenAPI 3.1 schemas are JSON Schema 2020-12. Formats (date-time) are
  // documented for clients; they are not validated here (no ajv-formats). The
  // contract test's `conforms` walks every response and asserts each *At /
  // *At-suffixed string parses as a date instead.
  const instance = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  instance.addSchema({ $id: 'contract', components: { schemas: doc.components.schemas } });
  return instance;
}

let ajvInstance: Ajv2020 | null = null;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Validate a response body against a component schema by name. */
export function validateAgainst(schemaName: string, body: unknown): ValidationResult {
  if (!ajvInstance) ajvInstance = ajv();
  let validate = validators.get(schemaName);
  if (!validate) {
    validate = ajvInstance.compile({ $ref: `contract#/components/schemas/${schemaName}` });
    validators.set(schemaName, validate);
  }
  const ok = validate(body) as boolean;
  const errors = ok ? [] : ((validate.errors ?? []) as ErrorObject[]).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`);
  return { ok, errors };
}

/** The schema name an operation's response declares. */
export function responseSchemaOf(doc: OpenApiDocument, method: string, route: string, status: number): string | null {
  const ref = doc.paths[route]?.[method.toLowerCase()]?.responses?.[String(status)]?.content?.['application/json']?.schema?.$ref;
  return ref ? ref.slice('#/components/schemas/'.length) : null;
}
