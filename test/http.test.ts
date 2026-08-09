import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendPath,
  canonicalizeBaseUrl,
  hostKey,
  resolveConnection,
} from '../src/config.js';
import { ForgejoAxiError } from '../src/errors.js';
import { createServer } from 'node:net';
import { ForgejoHttpClient } from '../src/http.js';

// WSL2 and some containers expose no ::1 to bind, so run the IPv6 lane only
// where the loopback actually exists (CI runners have it).
const ipv6Available = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});
import { testSubprocessEnv } from './environment.js';
import { closeServers, json, servers, startServer } from './server.js';

afterEach(closeServers);

describe('URL and authentication configuration', () => {
  it('preserves path prefixes and canonicalizes trailing slashes', () => {
    const base = canonicalizeBaseUrl('https://forgejo.example:8443/git');
    expect(base.toString()).toBe('https://forgejo.example:8443/git/');
    expect(appendPath(base, '/api/v1/version').toString()).toBe(
      'https://forgejo.example:8443/git/api/v1/version',
    );
    expect(appendPath(base, 'api/v1/pulls?state=open&page=2').toString()).toBe(
      'https://forgejo.example:8443/git/api/v1/pulls?state=open&page=2',
    );
    expect(() => appendPath(base, 'api/v1/../admin')).toThrow();
    expect(() => appendPath(base, 'api/v1/repos#token')).toThrow();
    expect(hostKey(base)).toBe('FORGEJO_2E_EXAMPLE_3A_8443');
  });

  it('derives collision-resistant host-scoped token keys', () => {
    const dotted = canonicalizeBaseUrl('https://forgejo.example.com');
    const dashed = canonicalizeBaseUrl('https://forgejo-example.com');
    expect(hostKey(dotted)).not.toBe(hostKey(dashed));
    expect(hostKey(dotted)).toBe('FORGEJO_2E_EXAMPLE_2E_COM');
    expect(hostKey(dashed)).toBe('FORGEJO_2D_EXAMPLE_2E_COM');
  });

  it.each([
    'https://user:pass@example.test',
    'https://example.test/root?token=x',
    'https://example.test/root#frag',
    'https://example.test/a/../b',
    'https://example.test/%2e%2e/b',
    'https://example.test/a%2fb',
    'file:///tmp/forgejo',
  ])('rejects unsafe base URL %s', (value) => {
    expect(() => canonicalizeBaseUrl(value)).toThrow();
  });

  it('does not echo an unparseable base URL back in the error', () => {
    // A credential-bearing typo never reaches the credential guard, because the
    // parse fails first — so the parse error is what must stay generic.
    expect(() =>
      canonicalizeBaseUrl('https://user:s3cret@exa mple.test'),
    ).toThrow(/^Base URL is not a valid absolute URL$/);
  });

  it('uses host-scoped tokens and does not use generic tokens for flag URLs', async () => {
    const scoped = await resolveConnection(
      { baseUrl: 'https://forgejo.example:8443' },
      {
        FORGEJO_TOKEN_FORGEJO_2E_EXAMPLE_3A_8443: 'scoped',
        FORGEJO_TOKEN: 'generic',
      },
    );
    expect(scoped.token).toBe('scoped');
    expect(scoped.tokenSource).toBe('FORGEJO_TOKEN_FORGEJO_2E_EXAMPLE_3A_8443');

    const flagged = await resolveConnection(
      { baseUrl: 'https://other.example' },
      { FORGEJO_TOKEN: 'generic' },
    );
    expect(flagged.token).toBeUndefined();

    const environmental = await resolveConnection(
      {},
      { FORGEJO_BASE_URL: 'https://other.example', FORGEJO_TOKEN: 'generic' },
    );
    expect(environmental.token).toBe('generic');
  });

  it('rejects an explicitly selected token variable that is unset or empty', async () => {
    for (const env of [{}, { TOKEN: '' }]) {
      await expect(
        resolveConnection(
          { baseUrl: 'https://forgejo.example', tokenEnv: 'TOKEN' },
          env,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('rejects an explicitly empty base URL before hosts-file fallback', async () => {
    const home = await createHostsHome({
      'forgejo.example': {
        base_url: 'https://forgejo.example',
        token: 'file-token',
      },
    });
    try {
      await expect(
        resolveConnection({ baseUrl: '' }, { HOME: home }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: '--base-url must not be empty',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('resolves explicit, environment, then HOME-relative file credentials', async () => {
    const home = await createHostsHome({
      'file.example': {
        base_url: 'https://file.example/forge',
        token: 'file-token',
      },
    });
    try {
      await expect(
        resolveConnection(
          {
            baseUrl: 'https://explicit.example',
            tokenEnv: 'EXPLICIT_TOKEN',
          },
          {
            HOME: home,
            EXPLICIT_TOKEN: 'explicit-token',
            FORGEJO_BASE_URL: 'https://environment.example',
            FORGEJO_TOKEN: 'environment-token',
          },
        ),
      ).resolves.toMatchObject({
        token: 'explicit-token',
        tokenSource: 'EXPLICIT_TOKEN',
        source: 'flag',
      });

      await expect(
        resolveConnection(
          {},
          {
            HOME: home,
            FORGEJO_BASE_URL: 'https://environment.example',
            FORGEJO_TOKEN: 'environment-token',
          },
        ),
      ).resolves.toMatchObject({
        token: 'environment-token',
        tokenSource: 'FORGEJO_TOKEN',
        source: 'env',
      });

      const file = await resolveConnection({}, { HOME: home });
      expect(file.baseUrl.toString()).toBe('https://file.example/forge/');
      expect(file).toMatchObject({
        token: 'file-token',
        tokenSource: '~/.config/forgejo-axi/hosts.json',
        source: 'file',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses a matching file token with an explicit base URL', async () => {
    const home = await createHostsHome({
      'forgejo.example': {
        base_url: 'https://forgejo.example/forge',
        token: 'file-token',
      },
    });
    try {
      await expect(
        resolveConnection(
          { baseUrl: 'https://forgejo.example/other' },
          { HOME: home },
        ),
      ).resolves.toMatchObject({ token: 'file-token', source: 'flag' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves missing-file behavior and rejects missing or invalid entries', async () => {
    const missingHome = await mkdtemp(join(tmpdir(), 'forgejo-axi-home-'));
    const emptyHome = await createHostsHome({});
    const invalidHome = await createHostsHome({
      'forgejo.example': {
        base_url: 'https://forgejo.example',
        token: '',
      },
    });
    try {
      await expect(
        resolveConnection(
          { baseUrl: 'https://forgejo.example' },
          {
            HOME: missingHome,
          },
        ),
      ).resolves.toMatchObject({ tokenSource: null });
      for (const home of [missingHome, emptyHome]) {
        await expect(
          resolveConnection({}, { HOME: home }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      }
      await expect(
        resolveConnection({}, { HOME: invalidHome }),
      ).rejects.toMatchObject({ code: 'HOSTS_FILE_ERROR' });
    } finally {
      await Promise.all(
        [missingHome, emptyHome, invalidHome].map((home) =>
          rm(home, { recursive: true, force: true }),
        ),
      );
    }
  });

  it('rejects invalid JSON and credential files not protected by mode 0600', async () => {
    const invalidJsonHome = await createHostsHome('{not-json');
    const openHome = await createHostsHome({
      'forgejo.example': {
        base_url: 'https://forgejo.example',
        token: 'must-not-appear',
      },
    });
    const openPath = join(openHome, '.config', 'forgejo-axi', 'hosts.json');
    await chmod(openPath, 0o644);
    try {
      await expect(
        resolveConnection({}, { HOME: invalidJsonHome }),
      ).rejects.toMatchObject({ code: 'HOSTS_FILE_ERROR' });
      let caught: unknown;
      try {
        await resolveConnection({}, { HOME: openHome });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'HOSTS_FILE_ERROR' });
      expect(JSON.stringify(caught)).not.toContain('must-not-appear');
    } finally {
      await Promise.all(
        [invalidJsonHome, openHome].map((home) =>
          rm(home, { recursive: true, force: true }),
        ),
      );
    }
  });

  it('rejects non-loopback HTTP with or without a token', async () => {
    await expect(
      resolveConnection(
        { baseUrl: 'http://forgejo.example', tokenEnv: 'TOKEN' },
        { TOKEN: 'secret' },
      ),
    ).rejects.toMatchObject({ code: 'INSECURE_TRANSPORT' });
    await expect(
      resolveConnection({ baseUrl: 'http://forgejo.example' }, {}),
    ).rejects.toMatchObject({ code: 'INSECURE_TRANSPORT' });
  });

  it('accepts authenticated IPv4 and IPv6 loopback HTTP', async () => {
    for (const baseUrl of ['http://127.0.0.2:3000', 'http://[::1]:3000']) {
      await expect(
        resolveConnection({ baseUrl, tokenEnv: 'TOKEN' }, { TOKEN: 'secret' }),
      ).resolves.toMatchObject({ token: 'secret' });
    }
  });

  it('accepts anonymous loopback HTTP', async () => {
    for (const baseUrl of ['http://127.0.0.2:3000', 'http://[::1]:3000']) {
      await expect(resolveConnection({ baseUrl }, {})).resolves.toMatchObject({
        tokenSource: null,
      });
    }
  });
});

async function createHostsHome(contents: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'forgejo-axi-home-'));
  const directory = join(home, '.config', 'forgejo-axi');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'hosts.json');
  await writeFile(
    path,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return home;
}

describe('HTTP security behavior', () => {
  it('rejects a response whose body is truncated mid-stream', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '100',
      });
      response.write('{"version":"15.0.5"');
      response.destroy();
    });
    servers.push(server);
    const config = await resolveConnection({ baseUrl: server.baseUrl }, {});
    await expect(
      new ForgejoHttpClient(config).api({ path: 'version' }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('rejects a response closed cleanly before the declared body completes', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '100',
      });
      response.write('{"version":"15.0.5"');
      // FIN instead of RST: covers truncation where the stream may end without
      // a socket error. Which client event settles it varies across Node
      // versions, so the client keeps both its error and close guards.
      response.socket?.end();
    });
    servers.push(server);
    const config = await resolveConnection({ baseUrl: server.baseUrl }, {});
    await expect(
      new ForgejoHttpClient(config).api({ path: 'version' }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('stops envelope pagination on a short page even when a Link header claims more', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        link: '<https://example.test/api/v1/x?page=2>; rel="next"',
      });
      response.end(
        JSON.stringify({ workflow_runs: [{ id: 1 }], total_count: 900 }),
      );
    });
    servers.push(server);
    const config = await resolveConnection({ baseUrl: server.baseUrl }, {});
    const result = await new ForgejoHttpClient(config).paginateEnvelope<{
      id: number;
    }>('repos/acme/widgets/actions/runs');
    expect(server.requests.length).toBe(1);
    expect(result).toMatchObject({ complete: true, pages: 1 });
  });

  it.runIf(ipv6Available)(
    'reaches a host addressed by an IPv6 literal',
    async () => {
      const server = await startServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ version: '16.0.0' }));
        },
        '',
        '::1',
      );
      servers.push(server);
      const config = await resolveConnection({ baseUrl: server.baseUrl }, {});
      const response = await new ForgejoHttpClient(config).api<{
        version: string;
      }>({ path: 'version' });
      expect(response.data.version).toBe('16.0.0');
    },
  );

  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    const server = await startServer((_request, response) =>
      json(response, status, { message: 'ordinary API failure' }),
    );
    servers.push(server);
    const config = await resolveConnection({ baseUrl: server.baseUrl }, {});
    await expect(
      new ForgejoHttpClient(config).api({ path: 'failure' }),
    ).rejects.toMatchObject({ code });
  });

  it('rejects malformed JSON as an invalid response', async () => {
    const server = await startServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end('{');
    });
    servers.push(server);
    const config = await resolveConnection({ baseUrl: server.baseUrl }, {});
    await expect(
      new ForgejoHttpClient(config).api({ path: 'malformed' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('follows same-origin redirects with authentication', async () => {
    const server = await startServer((_request, response, recorded) => {
      if (recorded.url === '/prefix/api/v1/version') {
        response.statusCode = 302;
        response.setHeader('location', '/prefix/api/v1/actual');
        response.end();
        return;
      }
      json(response, 200, { version: '15.0.5' });
    }, '/prefix');
    servers.push(server);
    const config = await resolveConnection(
      { baseUrl: server.baseUrl, tokenEnv: 'TOKEN' },
      { TOKEN: 'same-origin-secret' },
    );
    const response = await new ForgejoHttpClient(config).api<{
      version: string;
    }>({
      path: 'version',
    });
    expect(response.data.version).toBe('15.0.5');
    expect(server.requests).toHaveLength(2);
    expect(
      server.requests.every(
        (request) =>
          request.headers.authorization === 'token same-origin-secret',
      ),
    ).toBe(true);
  });

  it.each([
    [303, 'GET', ''],
    [307, 'POST', '{"value":"once"}'],
    [308, 'POST', '{"value":"once"}'],
  ] as const)(
    'follows HTTP %i as %s, replaying the body only where the status keeps it',
    async (status, method, body) => {
      const server = await startServer((_request, response, recorded) => {
        if (recorded.url === '/api/v1/mutate') {
          response.statusCode = status;
          response.setHeader('location', '/api/v1/target');
          response.end();
          return;
        }
        return json(response, 200, { ok: true });
      });
      servers.push(server);
      const config = await resolveConnection({ baseUrl: server.baseUrl }, {});
      const response = await new ForgejoHttpClient(config).api<{
        ok: boolean;
      }>({ method: 'POST', path: 'mutate', body: { value: 'once' } });
      expect(response.data.ok).toBe(true);
      expect(
        server.requests.map((request) => [
          request.method,
          request.url,
          request.body,
        ]),
      ).toEqual([
        ['POST', '/api/v1/mutate', '{"value":"once"}'],
        [method, '/api/v1/target', body],
      ]);
    },
  );

  it.each([301, 302])(
    'rejects ambiguous HTTP %i mutation redirects without replaying the body',
    async (status) => {
      const server = await startServer((_request, response, recorded) => {
        if (recorded.url === '/api/v1/mutate') {
          response.statusCode = status;
          response.setHeader('location', '/api/v1/target');
          response.end();
          return;
        }
        return json(response, 200, {});
      });
      servers.push(server);
      const config = await resolveConnection({ baseUrl: server.baseUrl }, {});
      await expect(
        new ForgejoHttpClient(config).api({
          method: 'POST',
          path: 'mutate',
          body: { value: 'once' },
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_REDIRECT',
        details: { status, method: 'POST' },
      });
      expect(server.requests).toHaveLength(1);
    },
  );

  it('stops at the redirect ceiling instead of following a loop', async () => {
    const server = await startServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', '/api/v1/loop');
      response.end();
    });
    servers.push(server);
    const config = await resolveConnection({ baseUrl: server.baseUrl }, {});
    await expect(
      new ForgejoHttpClient(config).api({ path: 'version' }),
    ).rejects.toMatchObject({
      code: 'INVALID_REDIRECT',
      // The shared code also covers a missing Location and a credentialed
      // target, so the message is what pins this to the ceiling.
      message: 'Too many redirects',
    });
    // The first request plus MAX_REDIRECTS hops; the redirect answering the
    // last of those is refused rather than followed.
    expect(server.requests).toHaveLength(6);
  });

  it('rejects cross-origin redirects before credentials reach the target', async () => {
    const target = await startServer((_request, response) =>
      json(response, 200, {}),
    );
    servers.push(target);
    const origin = await startServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', `${target.baseUrl}/stolen`);
      response.end();
    });
    servers.push(origin);
    const config = await resolveConnection(
      { baseUrl: origin.baseUrl, tokenEnv: 'TOKEN' },
      { TOKEN: 'must-not-leak' },
    );
    await expect(
      new ForgejoHttpClient(config).api({ path: 'version' }),
    ).rejects.toMatchObject({ code: 'CROSS_ORIGIN_REDIRECT' });
    expect(target.requests).toHaveLength(0);
  });

  it('rejects credentialed redirect locations', async () => {
    let redirectUrl = '';
    const server = await startServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', redirectUrl);
      response.end();
    });
    servers.push(server);
    redirectUrl = server.baseUrl.replace('http://', 'http://user:pass@');
    const config = await resolveConnection(
      { baseUrl: server.baseUrl, tokenEnv: 'TOKEN' },
      { TOKEN: 'redirect-secret' },
    );
    await expect(
      new ForgejoHttpClient(config).api({ path: 'version' }),
    ).rejects.toMatchObject({ code: 'INVALID_REDIRECT' });
    expect(server.requests).toHaveLength(1);
  });

  it('redacts tokens echoed by successful API responses', async () => {
    const token = 'success-"secret\\value';
    const server = await startServer((_request, response) =>
      json(response, 200, { value: `token ${token} must be hidden` }),
    );
    servers.push(server);
    const config = await resolveConnection(
      { baseUrl: server.baseUrl, tokenEnv: 'TOKEN' },
      { TOKEN: token },
    );
    const response = await new ForgejoHttpClient(config).api<{
      value: string;
    }>({ path: 'echo' });
    expect(response.data.value).toBe('token [REDACTED] must be hidden');
  });

  it('redacts tokens echoed by API errors', async () => {
    const server = await startServer((_request, response) =>
      json(response, 422, { message: 'bad token redaction-secret' }),
    );
    servers.push(server);
    const config = await resolveConnection(
      { baseUrl: server.baseUrl, tokenEnv: 'TOKEN' },
      { TOKEN: 'redaction-secret' },
    );
    let caught: unknown;
    try {
      await new ForgejoHttpClient(config).api({ path: 'echo' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForgejoAxiError);
    expect(JSON.stringify(caught)).not.toContain('redaction-secret');
    expect((caught as Error).message).toContain('[REDACTED]');
  });

  it('redacts tokens echoed inside JSON object keys', async () => {
    const token = 'key-"secret\\value';
    const server = await startServer((_request, response) =>
      json(response, 200, {
        [`leaked ${token} key`]: { [token]: 'nested' },
        list: [{ [`${token}-item`]: 'entry' }],
      }),
    );
    servers.push(server);
    const config = await resolveConnection(
      { baseUrl: server.baseUrl, tokenEnv: 'TOKEN' },
      { TOKEN: token },
    );
    const response = await new ForgejoHttpClient(config).api<
      Record<string, unknown>
    >({ path: 'echo' });
    expect(response.data).toEqual({
      'leaked [REDACTED] key': { '[REDACTED]': 'nested' },
      list: [{ '[REDACTED]-item': 'entry' }],
    });
  });

  it('redacts percent-encoded and base64 reflections of the token', async () => {
    const token = 'reflect-"secret\\value';
    // Both reflections are spelled out rather than re-derived from `token`, so
    // a change in how the client encodes cannot move the fixture along with it.
    const server = await startServer((_request, response) =>
      json(response, 200, {
        value:
          'query=reflect-%22secret%5Cvalue log=cmVmbGVjdC0ic2VjcmV0XHZhbHVl',
      }),
    );
    servers.push(server);
    const config = await resolveConnection(
      { baseUrl: server.baseUrl, tokenEnv: 'TOKEN' },
      { TOKEN: token },
    );
    const response = await new ForgejoHttpClient(config).api<{
      value: string;
    }>({ path: 'echo' });
    expect(response.data.value).toBe('query=[REDACTED] log=[REDACTED]');
  });

  it('refuses a body past the transport size ceiling', async () => {
    const server = await startServer((_request, response) => {
      // The client destroys the socket mid-body, so the writes it abandons
      // must not fail the server.
      response.on('error', () => {});
      response.writeHead(200, { 'content-type': 'application/json' });
      const megabyte = Buffer.alloc(1024 * 1024, 0x61);
      for (let written = 0; written < 17; written += 1)
        response.write(megabyte);
      response.end();
    });
    servers.push(server);
    const config = await resolveConnection({ baseUrl: server.baseUrl }, {});
    await expect(
      new ForgejoHttpClient(config).api({ path: 'huge' }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('streams a body to a file and never leaves a partial one behind', async () => {
    const server = await startServer((_request, response, recorded) => {
      if (recorded.url.endsWith('good')) {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
        });
        response.end('artifact-bytes');
        return;
      }
      if (recorded.url.endsWith('moved')) {
        response.writeHead(302, {
          location: recorded.url.replace('moved', 'good'),
        });
        response.end();
        return;
      }
      if (recorded.url.endsWith('cut')) {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': '100',
        });
        response.write('half-an-artifact');
        response.destroy();
        return;
      }
      json(response, 500, { message: 'boom' });
    });
    servers.push(server);
    const dir = await mkdtemp(join(tmpdir(), 'forgejo-axi-test-download-'));
    const config = await resolveConnection({ baseUrl: server.baseUrl }, {});
    const client = new ForgejoHttpClient(config);
    try {
      const good = join(dir, 'good.bin');
      const response = await client.api<number>({
        path: 'good',
        raw: true,
        file: good,
      });
      expect(response.data).toBe(14);
      expect(await readFile(good, 'utf8')).toBe('artifact-bytes');

      const failed = join(dir, 'failed.bin');
      await expect(
        client.api({ path: 'bad', raw: true, file: failed }),
      ).rejects.toMatchObject({ code: 'API_ERROR' });
      await expect(readFile(failed)).rejects.toMatchObject({ code: 'ENOENT' });

      // A body that dies partway is the way a real download fails, and the
      // file it was writing must not survive as a truncated artifact.
      const cut = join(dir, 'cut.bin');
      await expect(
        client.api({ path: 'cut', raw: true, file: cut }),
      ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      await expect(readFile(cut)).rejects.toMatchObject({ code: 'ENOENT' });

      // The sink outlives a redirect, so the body lands once, at the target.
      const moved = join(dir, 'moved.bin');
      const followed = await client.api<number>({
        path: 'moved',
        raw: true,
        file: moved,
      });
      expect(followed.data).toBe(14);
      expect(await readFile(moved, 'utf8')).toBe('artifact-bytes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces the configured request timeout', async () => {
    const server = await startServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      json(response, 200, { version: 'too late' });
    });
    servers.push(server);
    const config = await resolveConnection(
      { baseUrl: server.baseUrl, timeoutMs: '5' },
      {},
    );
    await expect(
      new ForgejoHttpClient(config).api({ path: 'version' }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('uses a custom CA for self-signed HTTPS', async () => {
    const certDir = await mkdtemp(join(tmpdir(), 'forgejo-axi-test-ca-'));
    const keyPath = join(certDir, 'localhost-key.pem');
    const certPath = join(certDir, 'localhost-cert.pem');
    await promisify(execFile)(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { env: testSubprocessEnv() },
    );
    const [key, cert] = await Promise.all([
      readFile(keyPath),
      readFile(certPath),
    ]);
    const server = createHttpsServer({ key, cert }, (_request, response) =>
      json(response, 200, { version: '15.0.5' }),
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing HTTPS address');
    const baseUrl = `https://127.0.0.1:${address.port}`;
    try {
      const withoutCa = await resolveConnection({ baseUrl }, {});
      await expect(
        new ForgejoHttpClient(withoutCa).api({ path: 'version' }),
      ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      const withCa = await resolveConnection(
        {
          baseUrl,
          caFile: certPath,
        },
        {},
      );
      const response = await new ForgejoHttpClient(withCa).api<{
        version: string;
      }>({
        path: 'version',
      });
      expect(response.data.version).toBe('15.0.5');
    } finally {
      server.close();
      await once(server, 'close');
      await rm(certDir, { recursive: true, force: true });
    }
  });
});
