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

  it('JSON lists expose every fetched row using the concise default schema', async () => {
    const pulls = Array.from({ length: 35 }, (_, index) => ({
      number: index + 1,
      state: 'open',
      title: `PR ${index + 1}`,
      head: { ref: `branch-${index + 1}`, sha: `sha-${index + 1}` },
      base: { ref: 'main' },
      merged: false,
    }));
    const server = await startServer((_request, response) => {
      response.setHeader('x-total-count', String(pulls.length));
      json(response, 200, pulls);
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
    expect(output.pull_requests).toHaveLength(35);
    expect(output.pull_requests[0]).toEqual({
      number: 1,
      title: 'PR 1',
      state: 'open',
      head: 'branch-1',
    });
    expect(output.page_info).toEqual({
      complete: true,
      pages: 1,
      fetched: 35,
      total: 35,
      displayed: 35,
      truncated: false,
    });
  });

  it('rejects --limit with --json instead of silently ignoring it', async () => {
    const result = await invoke([
      'pr',
      'list',
      '--repo',
      'acme/widgets',
      '--json',
      '--limit',
      '1',
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('--limit cannot be combined with --json');
  });

  it('includes actionable help for a missing required flag', async () => {
    const result = await invoke(['pr', 'find', '--repo', 'acme/widgets']);
    expect(result.exitCode).toBe(2);
    const output = parseJson<{
      help: string[];
    }>(
      (await invoke(['pr', 'find', '--repo', 'acme/widgets', '--json'])).output,
    );
    expect(output.help).toEqual(['Run `forgejo-axi pr find --help`']);
  });

  it('previews pull request bodies and exposes --full as an escape hatch', async () => {
    const fixture = await loadFixture(15);
    const body = 'x'.repeat(600);
    const server = await startServer((_request, response) =>
      json(response, 200, { ...fixture.pull, body }),
    );
    servers.push(server);
    const baseArgs = [
      'pr',
      'view',
      '--repo',
      'acme/widgets',
      '42',
      '--base-url',
      server.baseUrl,
      '--json',
    ];
    const preview = parseJson<{
      pull_request: {
        body: string;
        body_length: number;
        body_truncated: boolean;
      };
    }>((await invoke(baseArgs)).output);
    expect(preview.pull_request.body).toHaveLength(500);
    expect(preview.pull_request.body.endsWith('...')).toBe(true);
    expect(preview.pull_request).toMatchObject({
      body_length: 600,
      body_truncated: true,
    });
    const full = parseJson<{
      pull_request: { body: string; body_truncated: boolean };
    }>((await invoke([...baseArgs, '--full'])).output);
    expect(full.pull_request).toEqual({
      ...full.pull_request,
      body,
      body_truncated: false,
    });
  });

  it('caps raw paginated TOON output and supports --full', async () => {
    const rows = Array.from({ length: 35 }, (_, id) => ({ id }));
    const server = await startServer((_request, response) => {
      response.setHeader('x-total-count', String(rows.length));
      json(response, 200, rows);
    });
    servers.push(server);
    const args = [
      'api',
      'GET',
      'items',
      '--paginate',
      '--base-url',
      server.baseUrl,
    ];
    const concise = await invoke(args);
    expect(concise.output).toContain('data[30]');
    expect(concise.output).toContain('Rerun with --full');
    const full = await invoke([...args, '--full']);
    expect(full.output).toContain('data[35]');
  });

  it('covers repo view, raw API, find completeness, and unmerged proof shapes', async () => {
    const fixture = await loadFixture(16);
    const server = await startServer((_request, response, recorded) => {
      const url = new URL(recorded.url, 'http://fake');
      if (url.pathname.endsWith('/api/v1/version')) {
        return json(response, 200, fixture.version);
      }
      if (url.pathname.endsWith('/api/v1/repos/acme/widgets/pulls/42')) {
        return json(response, 200, fixture.pull);
      }
      if (url.pathname.endsWith('/api/v1/repos/acme/widgets/pulls')) {
        response.setHeader('x-total-count', '1');
        return json(response, 200, [fixture.pull]);
      }
      if (url.pathname.endsWith('/api/v1/repos/acme/widgets')) {
        return json(response, 200, {
          full_name: 'acme/widgets',
          default_branch: 'main',
          has_actions: true,
          has_pull_requests: true,
        });
      }
      return json(response, 404, { message: 'not found' });
    });
    servers.push(server);
    const connection = ['--base-url', server.baseUrl, '--json'];
    const repoView = parseJson<{ repository: { full_name: string } }>(
      (await invoke(['repo', 'view', '--repo', 'acme/widgets', ...connection]))
        .output,
    );
    expect(repoView.repository.full_name).toBe('acme/widgets');
    const raw = parseJson<{ status: number; data: { version: string } }>(
      (await invoke(['api', 'GET', 'version', ...connection])).output,
    );
    expect(raw).toMatchObject({ status: 200, data: fixture.version });
    const found = parseJson<{
      found: boolean;
      search_info: { complete: boolean; fetched: number };
    }>(
      (
        await invoke([
          'pr',
          'find',
          '--repo',
          'acme/widgets',
          '--head',
          'fix/race',
          ...connection,
        ])
      ).output,
    );
    expect(found).toMatchObject({
      found: true,
      search_info: { complete: true, fetched: 1 },
    });
    const merged = parseJson<{
      proof: Record<string, unknown>;
    }>(
      (
        await invoke([
          'pr',
          'merged',
          '--repo',
          'acme/widgets',
          '42',
          ...connection,
        ])
      ).output,
    );
    expect(merged.proof).toEqual({
      merged: false,
      number: 42,
      url: `${server.baseUrl}/acme/widgets/pulls/42`,
      head_sha: 'abc123',
      merge_commit_sha: null,
      merged_at: null,
      merged_by: null,
    });
  });

  it('degrades unavailable capability probes without failing status', async () => {
    const fixture = await loadFixture(16);
    const server = await startServer((_request, response, recorded) => {
      if (recorded.url.endsWith('/api/v1/version')) {
        return json(response, 200, fixture.version);
      }
      if (recorded.url.endsWith('/swagger.v1.json')) {
        return json(response, 403, { message: 'sign-in required' });
      }
      return json(response, 404, { message: 'not found' });
    });
    servers.push(server);
    const result = await invoke([
      'status',
      '--base-url',
      server.baseUrl,
      '--json',
    ]);
    expect(result.exitCode).toBeUndefined();
    const output = parseJson<{
      capabilities: {
        actions_job_logs: boolean;
        probe: Record<string, unknown>;
      };
    }>(result.output);
    expect(output.capabilities).toMatchObject({
      actions_job_logs: false,
      probe: { source: 'swagger_unavailable', complete: false },
    });
  });

  it('uses exit code 1 for runtime API failures', async () => {
    const server = await startServer((_request, response) =>
      json(response, 404, { message: 'repository not found' }),
    );
    servers.push(server);
    const result = await invoke([
      'repo',
      'view',
      '--repo',
      'acme/widgets',
      '--base-url',
      server.baseUrl,
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(parseJson(result.output)).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('loads and asserts the Forgejo 16 pull fixture', async () => {
    const fixture = await loadFixture(16);
    expect(fixture.pull).toMatchObject({
      number: 42,
      head: { ref: 'fix/race', sha: 'abc123' },
      base: { ref: 'main' },
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
