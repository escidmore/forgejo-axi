import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendPath,
  canonicalizeBaseUrl,
  hostKey,
  resolveConnection,
} from '../src/config.js';
import { ForgejoAxiError } from '../src/errors.js';
import { ForgejoHttpClient } from '../src/http.js';
import { json, startServer, type FakeServer } from './server.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

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
    expect(hostKey(base)).toBe('FORGEJO_EXAMPLE_8443');
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
        FORGEJO_TOKEN_FORGEJO_EXAMPLE_8443: 'scoped',
        FORGEJO_TOKEN: 'generic',
      },
    );
    expect(scoped.token).toBe('scoped');
    expect(scoped.tokenSource).toBe('FORGEJO_TOKEN_FORGEJO_EXAMPLE_8443');

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
    const [key, cert] = await Promise.all([
      readFile(new URL('./fixtures/localhost-key.pem', import.meta.url)),
      readFile(new URL('./fixtures/localhost-cert.pem', import.meta.url)),
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
          caFile: new URL('./fixtures/localhost-cert.pem', import.meta.url)
            .pathname,
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
    }
  });
});
