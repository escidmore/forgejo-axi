import { open, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { positiveInteger } from './args.js';
import { usageError, ForgejoAxiError } from './errors.js';

export interface ConnectionInput {
  baseUrl?: string | undefined;
  tokenEnv?: string | undefined;
  timeoutMs?: string | undefined;
  caFile?: string | undefined;
}

export interface ConnectionConfig {
  baseUrl: URL;
  apiUrl: URL;
  token?: string;
  timeoutMs: number;
  ca?: Buffer;
  source: 'flag' | 'env' | 'file';
  tokenSource: string | null;
}

interface HostsFileEntry {
  baseUrl: URL;
  token: string;
}

type HostsFile = Record<string, HostsFileEntry>;

const ENCODED_PATH_HAZARD = /%(?:2e|2f|5c)/i;
const TRUSTED_ENCODED_PATH_HAZARD = /%(?:2e|5c)/i;
const DEFAULT_TIMEOUT_MS = 15_000;

export async function resolveConnection(
  input: ConnectionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectionConfig> {
  let hosts: HostsFile | undefined;
  let rawBase = input.baseUrl ?? env['FORGEJO_BASE_URL'];
  let source: ConnectionConfig['source'] = input.baseUrl ? 'flag' : 'env';
  if (!rawBase) {
    hosts = await readHostsFile(env);
    const entries = Object.values(hosts ?? {});
    if (entries.length === 1) {
      rawBase = entries[0]?.baseUrl.toString();
      source = 'file';
    } else if (entries.length > 1) {
      throw usageError(
        '--base-url is required when the Forgejo hosts file has multiple entries',
        ['Pass `--base-url https://forgejo.example` or set FORGEJO_BASE_URL'],
      );
    }
  }
  if (!rawBase) {
    throw usageError(
      '--base-url is required when FORGEJO_BASE_URL is not set',
      [
        'Set FORGEJO_BASE_URL, configure ~/.config/forgejo-axi/hosts.json, or pass `--base-url https://forgejo.example`',
      ],
    );
  }
  const baseUrl = canonicalizeBaseUrl(rawBase);
  // Every answer an agent acts on — merge proofs, check states, mergeability —
  // is forgeable on a plaintext hop whether or not there is a credential to
  // steal, so the transport is refused rather than the credential alone.
  if (baseUrl.protocol === 'http:' && !isLoopbackHostname(baseUrl.hostname)) {
    throw new ForgejoAxiError(
      'Refusing to reach a non-loopback host over plaintext HTTP',
      'INSECURE_TRANSPORT',
      {
        suggestions: [
          'Use an https:// base URL, adding --ca-file PATH when the host presents a private CA certificate',
          'Forward the host to loopback (ssh -L) when it cannot serve TLS',
        ],
      },
    );
  }
  const timeoutMs = positiveInteger(
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

  let tokenResolution = resolveToken(baseUrl, source, input.tokenEnv, env);
  if (!tokenResolution.token) {
    hosts ??= await readHostsFile(env);
    const entry = hosts?.[baseUrl.host];
    if (entry) {
      tokenResolution = {
        token: entry.token,
        source: '~/.config/forgejo-axi/hosts.json',
      };
    }
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
    throw usageError('Base URL is not a valid absolute URL');
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
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

export function appendPath(
  base: URL,
  relativePath: string,
  options: { allowEncodedSlash?: boolean } = {},
): URL {
  if (relativePath.includes('#')) {
    throw usageError('API path must not contain a fragment');
  }
  const question = relativePath.indexOf('?');
  const rawPath =
    question === -1 ? relativePath : relativePath.slice(0, question);
  const rawQuery = question === -1 ? '' : relativePath.slice(question + 1);
  const encodedHazard = options.allowEncodedSlash
    ? TRUSTED_ENCODED_PATH_HAZARD
    : ENCODED_PATH_HAZARD;
  if (encodedHazard.test(rawPath) || rawPath.includes('\\')) {
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
  return url.host
    .toUpperCase()
    .replace(
      /[^A-Z0-9]/gu,
      (character) =>
        `_${character.codePointAt(0)?.toString(16).toUpperCase()}_`,
    );
}

function resolveToken(
  baseUrl: URL,
  baseSource: ConnectionConfig['source'],
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
    ...(baseSource === 'env' || baseSource === 'file' ? ['FORGEJO_TOKEN'] : []),
  ];
  for (const name of names) {
    const value = env[name];
    if (value) return { token: value, source: name };
  }
  return { source: null };
}

async function readHostsFile(
  env: NodeJS.ProcessEnv,
): Promise<HostsFile | undefined> {
  const home = env['HOME'];
  if (!home) return undefined;
  const path = join(home, '.config', 'forgejo-axi', 'hosts.json');
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw hostsFileError('Unable to open the Forgejo hosts file');
  }

  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)
    ) {
      throw hostsFileError(
        'Forgejo hosts file must be a regular mode 0600 file',
      );
    }
    let contents: string;
    try {
      contents = await file.readFile('utf8');
    } catch {
      throw hostsFileError('Unable to read the Forgejo hosts file');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw hostsFileError('Forgejo hosts file is not valid JSON');
    }
    return validateHostsFile(parsed);
  } finally {
    await file.close();
  }
}

function validateHostsFile(value: unknown): HostsFile {
  if (!isRecord(value)) throw hostsFileError('Forgejo hosts file is invalid');
  const hosts = Object.create(null) as HostsFile;
  for (const [host, valueEntry] of Object.entries(value)) {
    if (!isRecord(valueEntry))
      throw hostsFileError('Forgejo hosts file contains an invalid entry');
    const rawBaseUrl = valueEntry['base_url'];
    const token = valueEntry['token'];
    if (
      typeof rawBaseUrl !== 'string' ||
      !rawBaseUrl ||
      typeof token !== 'string' ||
      !token
    ) {
      throw hostsFileError('Forgejo hosts file contains an invalid entry');
    }
    let baseUrl: URL;
    try {
      baseUrl = canonicalizeBaseUrl(rawBaseUrl);
    } catch {
      throw hostsFileError('Forgejo hosts file contains an invalid entry');
    }
    if (baseUrl.host !== host)
      throw hostsFileError('Forgejo hosts file contains an invalid entry');
    hosts[host] = { baseUrl, token };
  }
  return hosts;
}

function hostsFileError(message: string): ForgejoAxiError {
  return new ForgejoAxiError(message, 'HOSTS_FILE_ERROR', {
    usage: true,
    suggestions: [
      'Use host keys with matching non-empty base_url and token values in ~/.config/forgejo-axi/hosts.json',
      'Set the file mode with `chmod 600 ~/.config/forgejo-axi/hosts.json`',
    ],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
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
