import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { usageError, ForgejoAxiError } from './errors.js';

export interface ConnectionInput {
  baseUrl?: string;
  tokenEnv?: string;
  timeoutMs?: string;
  caFile?: string;
}

export interface ConnectionConfig {
  baseUrl: URL;
  apiUrl: URL;
  token?: string;
  timeoutMs: number;
  ca?: Buffer;
  source: 'flag' | 'env';
  tokenSource: string | null;
}

const ENCODED_PATH_HAZARD = /%(?:2e|2f|5c)/i;
const DEFAULT_TIMEOUT_MS = 15_000;

export async function resolveConnection(
  input: ConnectionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectionConfig> {
  const rawBase = input.baseUrl ?? env['FORGEJO_BASE_URL'];
  if (!rawBase) {
    throw usageError(
      '--base-url is required when FORGEJO_BASE_URL is not set',
      ['Set FORGEJO_BASE_URL or pass `--base-url https://forgejo.example`'],
    );
  }
  const source = input.baseUrl ? 'flag' : 'env';
  const baseUrl = canonicalizeBaseUrl(rawBase);
  const timeoutMs = parsePositiveInteger(
    input.timeoutMs ?? env['FORGEJO_TIMEOUT_MS'] ?? String(DEFAULT_TIMEOUT_MS),
    '--timeout-ms',
  );
  const caPath = input.caFile ?? env['FORGEJO_CA_FILE'];
  let ca: Buffer | undefined;
  if (caPath) {
    try {
      ca = await readFile(caPath);
    } catch {
      throw new ForgejoAxiError(
        `Unable to read CA file: ${caPath}`,
        'CA_FILE_ERROR',
      );
    }
  }

  const tokenResolution = resolveToken(baseUrl, source, input.tokenEnv, env);
  if (
    tokenResolution.token &&
    baseUrl.protocol === 'http:' &&
    !isLoopbackHostname(baseUrl.hostname)
  ) {
    throw new ForgejoAxiError(
      'Refusing to send authentication over HTTP to a non-loopback host',
      'INSECURE_AUTH',
    );
  }

  const config: ConnectionConfig = {
    baseUrl,
    apiUrl: appendPath(baseUrl, 'api/v1/'),
    timeoutMs,
    source,
    tokenSource: tokenResolution.source,
  };
  if (tokenResolution.token) config.token = tokenResolution.token;
  if (ca) config.ca = ca;
  return config;
}

export function canonicalizeBaseUrl(raw: string): URL {
  if (ENCODED_PATH_HAZARD.test(raw) || raw.includes('\\')) {
    throw usageError(
      'Base URL contains an encoded or ambiguous path separator',
    );
  }
  const rawPath =
    raw.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*(\/[^?#]*)?/)?.[1] ?? '';
  if (
    rawPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw usageError('Base URL must not contain dot segments');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`Invalid base URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw usageError('Base URL must use http or https');
  }
  if (url.username || url.password) {
    throw usageError('Base URL must not contain credentials');
  }
  if (url.search || url.hash) {
    throw usageError('Base URL must not contain a query string or fragment');
  }
  const segments = url.pathname.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw usageError('Base URL must not contain dot segments');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

export function appendPath(base: URL, relativePath: string): URL {
  if (relativePath.includes('#')) {
    throw usageError('API path must not contain a fragment');
  }
  const question = relativePath.indexOf('?');
  const rawPath =
    question === -1 ? relativePath : relativePath.slice(0, question);
  const rawQuery = question === -1 ? '' : relativePath.slice(question + 1);
  if (ENCODED_PATH_HAZARD.test(rawPath) || rawPath.includes('\\')) {
    throw usageError(
      'API path contains an encoded or ambiguous path separator',
    );
  }
  const clean = rawPath.replace(/^\/+/, '');
  if (clean.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw usageError('API path must not contain dot segments');
  }
  try {
    const result = new URL(base.toString());
    result.pathname = `${base.pathname.replace(/\/+$/, '')}/${clean}`;
    result.search = rawQuery ? `?${rawQuery}` : '';
    return result;
  } catch {
    throw usageError('Unable to construct API URL');
  }
}

export function hostKey(url: URL): string {
  return url.host.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function resolveToken(
  baseUrl: URL,
  baseSource: 'flag' | 'env',
  explicitName: string | undefined,
  env: NodeJS.ProcessEnv,
): { token?: string; source: string | null } {
  if (explicitName !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(explicitName)) {
      throw usageError(`Invalid environment variable name: ${explicitName}`);
    }
    const value = env[explicitName];
    if (!value) {
      throw usageError(
        `Token environment variable ${explicitName} is unset or empty`,
        [
          `Export ${explicitName} with a Forgejo token or omit --token-env to use host-scoped defaults`,
        ],
      );
    }
    return { token: value, source: explicitName };
  }
  const names = [
    `FORGEJO_TOKEN_${hostKey(baseUrl)}`,
    ...(baseSource === 'env' ? ['FORGEJO_TOKEN'] : []),
  ];
  for (const name of names) {
    const value = env[name];
    if (value) return { token: value, source: name };
  }
  return { source: null };
}

function parsePositiveInteger(raw: string, label: string): number {
  if (!/^[1-9]\d*$/.test(raw))
    throw usageError(`${label} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw usageError(`${label} is too large`);
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost'))
    return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.startsWith('127.');
  if (ipVersion === 6) return normalized === '::1';
  return false;
}
