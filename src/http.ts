import { open, rm } from 'node:fs/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { appendPath, type ConnectionConfig } from './config.js';
import { ForgejoAxiError } from './errors.js';
import { VERSION } from './version.js';

export interface HttpResponse<T> {
  status: number;
  headers: IncomingHttpHeaders;
  data: T;
}

export interface RequestInput {
  method?: string;
  path?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  accept?: string;
  allowEncodedSlash?: boolean;
  /** Skip JSON parsing and token redaction; `data` is the raw response Buffer. */
  raw?: boolean;
  /**
   * Stream a successful body to this path instead of buffering it, never
   * overwriting an existing file; `data` is the number of bytes written.
   */
  file?: string;
}

export interface Paginated<T> {
  items: T[];
  complete: boolean;
  pages: number;
  total: number | null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const MAX_PAGES = 100;
const PAGE_SIZE = 50;
/**
 * A buffered body is bounded so a hostile or broken host cannot OOM the process
 * mid-flow: an agent that dies cannot report what happened or roll back its
 * intent, while a typed refusal is a definite answer. Bodies that are large by
 * design stream to a `file` instead and are not buffered at all.
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RAW_BODY_BYTES = 64 * 1024 * 1024;

interface Attempt {
  url: URL;
  method: string;
  body: string | undefined;
  accept: string | undefined;
  raw: boolean;
  sink: Writable | undefined;
}

export class ForgejoHttpClient {
  constructor(private readonly config: ConnectionConfig) {}

  api<T>(input: RequestInput): Promise<HttpResponse<T>> {
    const path = input.path ?? '';
    return this.request<T>({
      ...input,
      url: appendPath(
        this.config.apiUrl,
        path,
        input.allowEncodedSlash === undefined
          ? {}
          : { allowEncodedSlash: input.allowEncodedSlash },
      ),
    });
  }

  root<T>(input: RequestInput): Promise<HttpResponse<T>> {
    const path = input.path ?? '';
    return this.request<T>({
      ...input,
      url: appendPath(this.config.baseUrl, path),
    });
  }

  paginate<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<Paginated<T>> {
    return this.paginateWith<T, unknown>(path, query, true, (response) => {
      if (!Array.isArray(response.data)) {
        throw new ForgejoAxiError(
          'Forgejo returned a non-array pagination response',
          'INVALID_RESPONSE',
        );
      }
      return {
        entries: response.data as T[],
        total: parseTotal(response.headers['x-total-count']),
      };
    });
  }

  /** Like `paginate`, for `GET /actions/runs`, which wraps rows as `{workflow_runs,total_count}`. */
  paginateEnvelope<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<Paginated<T>> {
    return this.paginateWith<
      T,
      { workflow_runs?: T[]; total_count?: number } | null
    >(path, query, false, (response) => {
      const data = response.data;
      if (!data || !Array.isArray(data.workflow_runs)) {
        throw new ForgejoAxiError(
          'Forgejo returned a malformed paginated response',
          'INVALID_RESPONSE',
        );
      }
      return {
        entries: data.workflow_runs,
        total: typeof data.total_count === 'number' ? data.total_count : null,
      };
    });
  }

  /**
   * The array shape trusts a Link rel="next" over a short page; the envelope
   * shape (`useLink` false) stops on a short page alone — exactly how the two
   * loops behaved before they were merged.
   */
  private async paginateWith<T, R>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    useLink: boolean,
    extract: (response: HttpResponse<R>) => {
      entries: T[];
      total: number | null;
    },
  ): Promise<Paginated<T>> {
    const items: T[] = [];
    let total: number | null = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await this.api<R>({
        path,
        query: { ...query, page, limit: PAGE_SIZE },
      });
      const extracted = extract(response);
      if (extracted.total !== null) total = extracted.total;
      items.push(...extracted.entries);
      const doneByTotal = total !== null && items.length >= total;
      // An empty page is also a short page, so this covers both stop signals.
      const doneByShortPage = extracted.entries.length < PAGE_SIZE;
      const nextLinked = useLink && hasNextLink(response.headers['link']);
      if (doneByTotal || (doneByShortPage && !nextLinked)) {
        return {
          items,
          complete: true,
          pages: page,
          total: total ?? items.length,
        };
      }
    }
    return { items, complete: false, pages: MAX_PAGES, total };
  }

  private async request<T>(
    input: RequestInput & { url: URL },
  ): Promise<HttpResponse<T>> {
    const url = input.url;
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const attempt: Attempt = {
      url,
      method: (input.method ?? 'GET').toUpperCase(),
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      accept: input.accept,
      raw: input.raw ?? false,
      sink: undefined,
    };
    if (input.file === undefined)
      return this.requestWithRedirects<T>(attempt, 0);
    // Claiming the path with 'wx' before any traffic keeps the refusal to
    // overwrite ahead of the download, and a failure removes only the file this
    // call created.
    const handle = await open(input.file, 'wx');
    // The stream owns the descriptor from here; destroying it closes the file
    // on the paths where the body never arrives.
    const sink = handle.createWriteStream();
    try {
      return await this.requestWithRedirects<T>({ ...attempt, sink }, 0);
    } catch (error) {
      // Wait for the descriptor to close before unlinking, because Windows
      // refuses to remove a file that is still open. Neither step may throw:
      // a failed cleanup would replace the error that caused the cleanup,
      // leaving the caller with a filesystem complaint instead of the reason
      // the download failed.
      sink.destroy();
      await finished(sink).catch(() => {});
      await rm(input.file, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async requestWithRedirects<T>(
    attempt: Attempt,
    redirects: number,
  ): Promise<HttpResponse<T>> {
    const { url, method, body, raw } = attempt;
    const response = await this.requestOnce(attempt);
    if (!REDIRECT_STATUSES.has(response.status))
      return this.validate<T>(response, raw);
    const location = firstHeader(response.headers['location']);
    if (!location) {
      throw new ForgejoAxiError(
        'Redirect response omitted Location',
        'INVALID_REDIRECT',
      );
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new ForgejoAxiError('Too many redirects', 'INVALID_REDIRECT');
    }
    const target = resolveRedirectTarget(location, url);
    if (target.origin !== url.origin) {
      throw new ForgejoAxiError(
        'Refusing cross-origin redirect',
        'CROSS_ORIGIN_REDIRECT',
        {
          details: {
            from: `${url.origin}${url.pathname}`,
            to: `${target.origin}${target.pathname}`,
          },
        },
      );
    }
    if (
      (response.status === 301 || response.status === 302) &&
      method !== 'GET' &&
      method !== 'HEAD'
    ) {
      throw new ForgejoAxiError(
        'Refusing ambiguous mutation redirect',
        'INVALID_REDIRECT',
        { details: { status: response.status, method } },
      );
    }
    const redirectedMethod = response.status === 303 ? 'GET' : method;
    return this.requestWithRedirects<T>(
      {
        ...attempt,
        url: target,
        method: redirectedMethod,
        body: redirectedMethod === 'GET' ? undefined : body,
      },
      redirects + 1,
    );
  }

  private requestOnce(attempt: Attempt): Promise<HttpResponse<unknown>> {
    const { url, method, body, accept, raw, sink } = attempt;
    const headers: Record<string, string | number> = {
      accept: accept ?? 'application/json',
      'user-agent': `forgejo-axi/${VERSION}`,
    };
    if (this.config.token)
      headers['authorization'] = `token ${this.config.token}`;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const options: https.RequestOptions = {
      method,
      headers,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    };
    if (this.config.ca) options.ca = this.config.ca;
    const requestModule = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      let settled = false;
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(
          error instanceof ForgejoAxiError ? error : this.networkError(error),
        );
      };
      const request = requestModule.request(url, options, (response) => {
        const status = response.statusCode ?? 0;
        response.once('error', rejectOnce);
        response.once('close', () => {
          if (!response.complete) {
            rejectOnce(new Error('Forgejo response ended before the body'));
          }
        });
        // Only a success body streams; a redirect or error body stays buffered
        // for the redirect and error paths to read.
        // ponytail: a streamed body has no size ceiling, so a hostile host can
        // fill the disk; cap it against the artifact's declared size if that
        // ever matters more than downloading large artifacts at all.
        if (sink && status >= 200 && status < 300) {
          let written = 0;
          response.on('data', (chunk: Buffer) => {
            written += chunk.length;
          });
          pipeline(response, sink).then(() => {
            if (settled) return;
            settled = true;
            resolve({ status, headers: response.headers, data: written });
          }, rejectOnce);
          return;
        }
        const limit = raw ? MAX_RAW_BODY_BYTES : MAX_BODY_BYTES;
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > limit) {
            response.destroy();
            rejectOnce(
              new ForgejoAxiError(
                `Forgejo response exceeded the ${limit}-byte limit`,
                'RESPONSE_TOO_LARGE',
                { details: { limit } },
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (settled) return;
          try {
            const buffer = Buffer.concat(chunks);
            const data = raw
              ? buffer
              : redactData(
                  parseBody(
                    buffer.toString('utf8'),
                    response.headers['content-type'],
                  ),
                  this.config.token,
                );
            settled = true;
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              data,
            });
          } catch (error) {
            rejectOnce(
              error instanceof Error
                ? error
                : new Error('Unable to parse Forgejo response'),
            );
          }
        });
      });
      request.on('error', (error) => rejectOnce(error));
      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  private validate<T>(
    response: HttpResponse<unknown>,
    raw: boolean,
  ): HttpResponse<T> {
    if (response.status >= 200 && response.status < 300) {
      return response as HttpResponse<T>;
    }
    const body =
      raw && Buffer.isBuffer(response.data)
        ? parseErrorBody(response.data)
        : response.data;
    const message = redact(responseMessage(body), this.config.token);
    const code = statusCode(response.status, message);
    throw new ForgejoAxiError(
      message
        ? `Forgejo API request failed: ${message}`
        : 'Forgejo API request failed',
      code,
      { details: { status: response.status } },
    );
  }

  private networkError(error: Error): ForgejoAxiError {
    const code =
      error.name === 'TimeoutError' || error.name === 'AbortError'
        ? 'TIMEOUT'
        : 'NETWORK_ERROR';
    return new ForgejoAxiError(
      code === 'TIMEOUT'
        ? 'Forgejo request timed out'
        : 'Unable to reach Forgejo',
      code,
    );
  }
}

function parseBody(
  text: string,
  contentType: string | string[] | undefined,
): unknown {
  if (text.length === 0) return null;
  if (firstHeader(contentType)?.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ForgejoAxiError(
        'Forgejo returned invalid JSON',
        'INVALID_RESPONSE',
      );
    }
  }
  return text;
}

function responseMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>)['message'];
  return typeof value === 'string' ? value.slice(0, 500) : null;
}

/** Error bodies are JSON even on raw byte endpoints; an undecodable body yields no message. */
function parseErrorBody(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * A host that reflects the token rarely reflects it verbatim: a reflected query
 * string comes back percent-encoded, and job logs carry base64 as a matter of
 * course. Matching the literal alone would hand those reflections to the agent.
 *
 * ponytail: whole-token reflections only. A token split across lines,
 * case-altered, or base64-encoded inside a larger blob still passes — an
 * embedded encoding neither starts on the token's own 3-byte boundary nor
 * carries the trailing padding a standalone encoding ends with. Scrub by
 * entropy instead if a real host is ever seen doing that.
 */
export function redact(
  message: string | null,
  token: string | undefined,
): string | null {
  if (!message || !token) return message;
  let redacted = message;
  for (const form of [
    token,
    encodeURIComponent(token),
    Buffer.from(token).toString('base64'),
  ]) {
    redacted = redacted.replaceAll(form, '[REDACTED]');
  }
  return redacted;
}

function redactData(data: unknown, token: string | undefined): unknown {
  if (!token) return data;
  if (typeof data === 'string') return redact(data, token);
  if (Array.isArray(data)) return data.map((value) => redactData(value, token));
  if (data && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        redact(key, token) ?? key,
        redactData(value, token),
      ]),
    );
  }
  return data;
}

function statusCode(status: number, message: string | null): string {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (
    status === 409 &&
    /head (?:is )?out of date|head (?:changed|mismatch)|commit (?:changed|mismatch|out of date)/i.test(
      message ?? '',
    )
  )
    return 'HEAD_CHANGED';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return 'VALIDATION_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  return 'API_ERROR';
}

function parseTotal(value: string | string[] | undefined): number | null {
  const first = firstHeader(value);
  if (!first || !/^\d+$/.test(first)) return null;
  return Number(first);
}

function hasNextLink(value: string | string[] | undefined): boolean {
  return /rel="next"/.test(firstHeader(value) ?? '');
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolveRedirectTarget(location: string, current: URL): URL {
  try {
    const target = new URL(location, current);
    if (target.username || target.password) {
      throw new ForgejoAxiError(
        'Redirect Location must not contain credentials',
        'INVALID_REDIRECT',
      );
    }
    return target;
  } catch (error) {
    if (error instanceof ForgejoAxiError) throw error;
    throw new ForgejoAxiError(
      'Redirect Location is invalid',
      'INVALID_REDIRECT',
    );
  }
}
