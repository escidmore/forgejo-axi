import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { json, startServer, type FakeServer } from './server.js';

interface Fixture {
  version: Record<string, unknown>;
  swagger: Record<string, unknown>;
  pull: Record<string, unknown>;
}

const servers: FakeServer[] = [];
afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function loadFixture(version: 15 | 16): Promise<Fixture> {
  return parseJson<Fixture>(
    await readFile(
      new URL(`./fixtures/forgejo-${version}.json`, import.meta.url),
      'utf8',
    ),
  );
}

async function invoke(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ output: string; exitCode: number | undefined }> {
  let output = '';
  process.exitCode = undefined;
  await main({
    argv,
    env,
    stdout: {
      write: (chunk) => {
        output += String(chunk);
        return true;
      },
    },
  });
  return { output, exitCode: process.exitCode };
}

describe('CLI contract', () => {
  it('shows a useful configuration-free home view', async () => {
    const result = await invoke([]);
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain('description: Inspect and manage Forgejo');
    expect(result.output).toContain('configured: false');
    expect(result.output).toContain('FORGEJO_BASE_URL');
    expect(result.output).not.toContain('error:');
  });

  it('rejects unknown input with a structured usage error', async () => {
    const result = await invoke([
      'pr',
      'list',
      '--repo',
      'acme/widgets',
      '--stat',
      'open',
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('error: Unknown flag --stat');
    expect(result.output).toContain('code: VALIDATION_ERROR');
    expect(result.output).toContain('--state');
  });

  it('emits the stable JSON error shape', async () => {
    const result = await invoke([
      'pr',
      'view',
      '--json',
      '--repo',
      'acme/widgets',
      'zero',
    ]);
    expect(result.exitCode).toBe(2);
    expect(parseJson(result.output)).toEqual({
      error: 'Pull request number must be a positive integer',
      code: 'VALIDATION_ERROR',
      details: {},
      help: [],
    });
  });

  it('shows concise per-command help without requiring configuration', async () => {
    const result = await invoke(['pr', 'merge', '--help']);
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain('--expected-head SHA');
    expect(result.output).not.toContain('repo view');
  });

  it.each([15, 16] as const)(
    'probes Forgejo %i capabilities from its runtime Swagger document',
    async (version) => {
      const fixture = await loadFixture(version);
      const server = await startServer((_request, response, recorded) => {
        if (recorded.url === '/forge/api/v1/version')
          return json(response, 200, fixture.version);
        if (recorded.url === '/forge/api/v1/user')
          return json(response, 200, { login: 'robot' });
        if (recorded.url === '/forge/swagger.v1.json')
          return json(response, 200, fixture.swagger);
        return json(response, 404, { message: 'not found' });
      }, '/forge');
      servers.push(server);
      const result = await invoke(
        [
          'status',
          '--base-url',
          server.baseUrl,
          '--token-env',
          'TOKEN',
          '--json',
        ],
        { TOKEN: 'runtime-probe' },
      );
      expect(result.exitCode).toBeUndefined();
      const output = parseJson<{
        server: { version: string };
        auth: { authenticated: boolean };
        capabilities: { actions_job_logs: boolean; probe: { source: string } };
      }>(result.output);
      expect(output.server.version).toContain(`${version}.0.`);
      expect(output.auth.authenticated).toBe(true);
      expect(output.capabilities.actions_job_logs).toBe(version === 16);
      expect(output.capabilities.probe.source).toBe('swagger');
      expect(
        server.requests.every((request) => request.url.startsWith('/forge/')),
      ).toBe(true);
    },
  );

  it('builds canonical pull request URLs from the configured base, not response links', async () => {
    const fixture = await loadFixture(15);
    const server = await startServer((_request, response, recorded) => {
      if (recorded.url === '/forge/api/v1/repos/acme/widgets/pulls/42') {
        return json(response, 200, {
          ...fixture.pull,
          html_url: 'https://evil.example/stolen',
          url: 'https://evil.example/api/stolen',
        });
      }
      return json(response, 404, { message: 'not found' });
    }, '/forge');
    servers.push(server);
    const result = await invoke([
      'pr',
      'view',
      '--repo',
      'acme/widgets',
      '42',
      '--base-url',
      server.baseUrl,
      '--json',
    ]);
    const output = parseJson<{
      pull_request: { url: string; api_url: string };
    }>(result.output);
    expect(output.pull_request.url).toBe(
      `${server.baseUrl}/acme/widgets/pulls/42`,
    );
    expect(output.pull_request.api_url).toBe(
      `${server.baseUrl}/api/v1/repos/acme/widgets/pulls/42`,
    );
    expect(result.output).not.toContain('evil.example');
  });

  it('fetches every page and reports TOON display truncation explicitly', async () => {
    const pulls = Array.from({ length: 55 }, (_, index) => ({
      number: index + 1,
      state: 'open',
      title: `PR ${index + 1}`,
      head: { ref: `branch-${index + 1}`, sha: `sha-${index + 1}` },
      base: { ref: 'main' },
      mergeable: true,
      merged: false,
    }));
    const server = await startServer((_request, response, recorded) => {
      const url = new URL(recorded.url, 'http://fake');
      const page = Number(url.searchParams.get('page'));
      response.setHeader('x-total-count', '55');
      return json(
        response,
        200,
        page === 1 ? pulls.slice(0, 50) : pulls.slice(50),
      );
    });
    servers.push(server);
    const result = await invoke([
      'pr',
      'list',
      '--repo',
      'acme/widgets',
      '--base-url',
      server.baseUrl,
    ]);
    expect(result.output).toContain('pull_requests[30]');
    expect(result.output).toContain('fetched: 55');
    expect(result.output).toContain('displayed: 30');
    expect(result.output).toContain('truncated: true');
    expect(server.requests).toHaveLength(2);
  });

  it('JSON lists expose every fetched item with complete page metadata', async () => {
    const server = await startServer((_request, response) => {
      response.setHeader('x-total-count', '1');
      json(response, 200, [
        {
          number: 1,
          state: 'open',
          title: 'One',
          head: { ref: 'one', sha: 'sha-one' },
          base: { ref: 'main' },
          merged: false,
        },
      ]);
    });
    servers.push(server);
    const result = await invoke([
      'pr',
      'list',
      '--repo',
      'acme/widgets',
      '--base-url',
      server.baseUrl,
      '--json',
    ]);
    const output = parseJson<{
      pull_requests: unknown[];
      page_info: Record<string, unknown>;
    }>(result.output);
    expect(output.pull_requests).toHaveLength(1);
    expect(output.page_info).toEqual({
      complete: true,
      pages: 1,
      fetched: 1,
      total: 1,
      displayed: 1,
      truncated: false,
    });
  });
});

function parseJson<T = unknown>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Expected valid JSON: ${String(error)}`, { cause: error });
  }
}
