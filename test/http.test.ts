import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

  it('rejects authenticated non-loopback HTTP', async () => {
    await expect(
      resolveConnection(
        { baseUrl: 'http://forgejo.example', tokenEnv: 'TOKEN' },
        { TOKEN: 'secret' },
      ),
    ).rejects.toMatchObject({ code: 'INSECURE_AUTH' });
  });

  it('accepts authenticated IPv4 and IPv6 loopback HTTP', async () => {
    for (const baseUrl of ['http://127.0.0.2:3000', 'http://[::1]:3000']) {
      await expect(
        resolveConnection({ baseUrl, tokenEnv: 'TOKEN' }, { TOKEN: 'secret' }),
      ).resolves.toMatchObject({ token: 'secret' });
    }
  });
});

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
