import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeServers,
  invoke,
  json,
  loadFixture as load,
  parseJson,
  servers,
  startServer,
  type FakeServer,
} from './server.js';

interface Fixture {
  version: Record<string, unknown>;
  swagger: Record<string, unknown>;
  labels: Array<Record<string, unknown>>;
  pull: Record<string, unknown>;
}

afterEach(closeServers);

async function loadFixture(version: 15 | 16): Promise<Fixture> {
  return load<Fixture>(version);
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

  it('reports the package.json version for --version', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const result = await invoke(['--version']);
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toBe(`${packageJson.version}\n`);
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

  it('previews pull request bodies without splitting Unicode characters', async () => {
    const fixture = await loadFixture(15);
    const body = `${'x'.repeat(496)}😀${'y'.repeat(103)}`;
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
    expect([...preview.pull_request.body]).toHaveLength(500);
    expect(preview.pull_request.body).toBe(`${'x'.repeat(496)}😀...`);
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

  it('wires lifecycle mutations, checks, and mergeability through the CLI', async () => {
    const fixture = await loadFixture(16);
    let pull = { ...fixture.pull };
    let merged = false;
    const server = await startServer((_request, response, recorded) => {
      const path = new URL(recorded.url, 'http://fake').pathname;
      if (path.endsWith('/pulls') && recorded.method === 'GET') {
        return json(response, 200, []);
      }
      if (path.endsWith('/pulls') && recorded.method === 'POST') {
        const posted = parseJson<Record<string, unknown>>(recorded.body);
        expect(posted).toEqual({
          title: 'Created title',
          head: 'fix/race',
          base: 'main',
          body: 'Created body',
        });
        pull = {
          ...pull,
          title: posted['title'],
          body: posted['body'],
        };
        return json(response, 201, pull);
      }
      if (path.endsWith('/pulls/42/merge') && recorded.method === 'POST') {
        expect(parseJson(recorded.body)).toEqual({
          Do: 'squash',
          head_commit_id: 'abc123',
        });
        merged = true;
        response.statusCode = 200;
        response.end();
        return;
      }
      if (path.endsWith('/pulls/42') && recorded.method === 'GET') {
        return json(response, 200, {
          ...pull,
          merged,
          state: merged ? 'closed' : 'open',
          merge_commit_sha: merged ? 'merge456' : null,
          merged_at: merged ? '2026-01-03T00:00:00Z' : null,
          merged_by: merged ? { login: 'robot' } : null,
        });
      }
      if (path.endsWith('/pulls/42') && recorded.method === 'PATCH') {
        const patch = parseJson<Record<string, unknown>>(recorded.body);
        expect(patch).toEqual({ title: 'Updated title' });
        pull = { ...pull, ...patch };
        return json(response, 200, pull);
      }
      if (path.endsWith('/statuses/abc123')) {
        return json(response, 200, [
          {
            context: 'ci',
            status: 'success',
            description: 'green',
            target_url: 'https://ci.example/run',
            updated_at: '2026-01-02T00:00:00Z',
          },
        ]);
      }
      if (path.endsWith('/branches/main')) {
        return json(response, 200, {
          protected: true,
          effective_branch_protection_name: 'main',
          enable_status_check: true,
          status_check_contexts: ['ci'],
        });
      }
      return json(response, 404, { message: 'not found' });
    });
    servers.push(server);
    const connection = [
      '--repo',
      'acme/widgets',
      '--base-url',
      server.baseUrl,
      '--json',
    ];

    const created = parseJson<{ created: boolean }>(
      (
        await invoke([
          'pr',
          'create',
          ...connection,
          '--title',
          'Created title',
          '--head',
          'fix/race',
          '--base',
          'main',
          '--body',
          'Created body',
        ])
      ).output,
    );
    expect(created.created).toBe(true);

    const updated = parseJson<{
      updated: boolean;
      pull_request: { title: string };
    }>(
      (
        await invoke([
          'pr',
          'update',
          ...connection,
          '42',
          '--title',
          'Updated title',
        ])
      ).output,
    );
    expect(updated).toMatchObject({
      updated: true,
      pull_request: { title: 'Updated title' },
    });

    const checks = parseJson<{ checks: Record<string, unknown> }>(
      (await invoke(['pr', 'checks', ...connection, '42'])).output,
    );
    expect(checks.checks).toMatchObject({
      statuses: [
        {
          context: 'ci',
          state: 'success',
          description: 'green',
          target_url: 'https://ci.example/run',
          updated_at: '2026-01-02T00:00:00Z',
        },
      ],
      required: [{ context: 'ci', state: 'success', matched: ['ci'] }],
      protection: {
        protected: true,
        rule: 'main',
        status_checks_enabled: true,
      },
      passes: true,
    });

    const mergeability = parseJson<{
      mergeability: { mergeable: boolean; checks_pass: boolean };
    }>((await invoke(['pr', 'mergeability', ...connection, '42'])).output);
    expect(mergeability.mergeability).toMatchObject({
      mergeable: true,
      checks_pass: true,
    });

    const merge = parseJson<{
      proof: { merged: boolean; merge_commit_sha: string };
    }>(
      (
        await invoke([
          'pr',
          'merge',
          ...connection,
          '42',
          '--expected-head',
          'abc123',
          '--method',
          'squash',
        ])
      ).output,
    );
    expect(merge.proof).toMatchObject({
      merged: true,
      merge_commit_sha: 'merge456',
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

  it.each([429, 500])(
    'degrades capability probes when Swagger responds with HTTP %i',
    async (status) => {
      const fixture = await loadFixture(16);
      const server = await startServer((_request, response, recorded) => {
        if (recorded.url.endsWith('/api/v1/version')) {
          return json(response, 200, fixture.version);
        }
        if (recorded.url.endsWith('/swagger.v1.json')) {
          return json(response, status, { message: 'temporarily unavailable' });
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
      expect(parseJson(result.output)).toMatchObject({
        capabilities: {
          pull_requests: false,
          probe: { source: 'swagger_unavailable', complete: false },
        },
      });
    },
  );

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

describe('label command family', () => {
  async function labelServer(
    labels: Array<Record<string, unknown>>,
  ): Promise<FakeServer> {
    const server = await startServer((_request, response, recorded) => {
      const url = new URL(recorded.url, 'http://fake');
      if (!url.pathname.startsWith('/api/v1/repos/acme/widgets/labels'))
        return json(response, 404, { message: 'not found' });
      if (recorded.method === 'GET' && url.pathname.endsWith('/labels')) {
        const page = Number(url.searchParams.get('page') ?? '1');
        return json(response, 200, page === 1 ? labels : []);
      }
      if (recorded.method === 'DELETE') {
        response.statusCode = 204;
        response.end();
        return;
      }
      const body = parseJson<Record<string, unknown>>(recorded.body);
      const existing = labels.find((label) =>
        url.pathname.endsWith(`/${String(label['id'])}`),
      );
      return json(response, recorded.method === 'POST' ? 201 : 200, {
        id: existing?.['id'] ?? 21,
        name: 'new',
        color: 'ededed',
        description: '',
        ...existing,
        ...body,
      });
    });
    servers.push(server);
    return server;
  }

  it.each([15, 16] as const)(
    'lists Forgejo %i labels as TOON and JSON',
    async (version) => {
      const fixture = await loadFixture(version);
      const server = await labelServer(fixture.labels);
      const toon = await invoke([
        'label',
        'list',
        '--repo',
        'acme/widgets',
        '--base-url',
        server.baseUrl,
      ]);
      expect(toon.exitCode).toBeUndefined();
      expect(toon.output).toContain('labels[3]');
      expect(toon.output).toContain('bug');
      expect(toon.output).toContain('fetched: 3');

      const result = await invoke([
        'label',
        'list',
        '--repo',
        'acme/widgets',
        '--base-url',
        server.baseUrl,
        '--json',
      ]);
      const output = parseJson<{
        labels: Array<{ id: number; name: string; color: string }>;
        page_info: { complete: boolean };
      }>(result.output);
      expect(output.labels).toHaveLength(3);
      expect(output.labels[0]).toMatchObject({
        id: 7,
        name: 'bug',
        color: '#d73a4a',
      });
      expect(output.page_info.complete).toBe(true);
    },
  );

  it('reports an empty label taxonomy without an error', async () => {
    const server = await labelServer([]);
    const result = await invoke([
      'label',
      'list',
      '--repo',
      'acme/widgets',
      '--base-url',
      server.baseUrl,
      '--json',
    ]);
    expect(result.exitCode).toBeUndefined();
    expect(parseJson(result.output)).toMatchObject({
      labels: [],
      page_info: { fetched: 0, complete: true },
    });
  });

  it.each([15, 16] as const)(
    'creates, edits, and deletes a Forgejo %i label by name',
    async (version) => {
      const fixture = await loadFixture(version);
      const server = await labelServer(fixture.labels);
      const created = await invoke([
        'label',
        'create',
        '--repo',
        'acme/widgets',
        'triage',
        '--color',
        'FCA13A',
        '--base-url',
        server.baseUrl,
        '--json',
      ]);
      expect(created.exitCode).toBeUndefined();
      expect(parseJson(created.output)).toMatchObject({
        created: true,
        updated: false,
        label: { name: 'triage', color: '#fca13a' },
      });

      const edited = await invoke([
        'label',
        'edit',
        '--repo',
        'acme/widgets',
        'bug',
        '--description',
        'Broken behaviour',
        '--base-url',
        server.baseUrl,
      ]);
      expect(edited.exitCode).toBeUndefined();
      expect(edited.output).toContain('updated: true');
      expect(edited.output).toContain('Broken behaviour');

      const deleted = await invoke([
        'label',
        'delete',
        '--repo',
        'acme/widgets',
        'wontfix',
        '--base-url',
        server.baseUrl,
        '--json',
      ]);
      expect(deleted.exitCode).toBeUndefined();
      expect(parseJson(deleted.output)).toMatchObject({
        deleted: true,
        label: { id: 9, name: 'wontfix' },
      });
      expect(
        server.requests.find((request) => request.method === 'DELETE')?.url,
      ).toContain('/labels/9');
    },
  );

  it('rejects an unknown label name with the documented exit code', async () => {
    const server = await labelServer([
      { id: 7, name: 'bug', color: 'd73a4a', description: '' },
    ]);
    const result = await invoke([
      'label',
      'edit',
      '--repo',
      'acme/widgets',
      'missing',
      '--color',
      '#ffffff',
      '--base-url',
      server.baseUrl,
      '--json',
    ]);
    expect(result.exitCode).toBe(2);
    expect(parseJson(result.output)).toMatchObject({
      code: 'LABEL_NOT_FOUND',
      details: { name: 'missing' },
      help: ['Run `forgejo-axi label list --repo acme/widgets`'],
    });
  });

  it('rejects an ambiguous label name with a usage hint', async () => {
    const server = await labelServer([
      { id: 7, name: 'bug', color: 'd73a4a', description: '' },
      { id: 11, name: 'bug', color: 'ffffff', description: '' },
    ]);
    const result = await invoke([
      'label',
      'delete',
      '--repo',
      'acme/widgets',
      'bug',
      '--base-url',
      server.baseUrl,
      '--json',
    ]);
    expect(result.exitCode).toBe(2);
    expect(parseJson(result.output)).toMatchObject({
      code: 'LABEL_AMBIGUOUS',
      details: { name: 'bug', ids: [7, 11] },
    });
    expect(server.requests.some((request) => request.method === 'DELETE')).toBe(
      false,
    );
  });

  it('addresses a dash-prefixed label name after a -- terminator', async () => {
    const server = await labelServer([
      { id: 7, name: '-blocked', color: 'd73a4a', description: '' },
    ]);
    const result = await invoke([
      'label',
      'delete',
      '--repo',
      'acme/widgets',
      '--base-url',
      server.baseUrl,
      '--json',
      '--',
      '-blocked',
    ]);
    expect(result.exitCode).toBeUndefined();
    expect(parseJson(result.output)).toMatchObject({
      deleted: true,
      label: { id: 7, name: '-blocked' },
    });
  });

  it('rejects a malformed color before contacting the server', async () => {
    const result = await invoke([
      'label',
      'create',
      '--repo',
      'acme/widgets',
      'bug',
      '--color',
      'reddish',
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('code: VALIDATION_ERROR');
    expect(result.output).toContain('six-digit hex color');
  });

  it('builds canonical label API URLs and redacts the token on failure', async () => {
    const server = await startServer((_request, response, recorded) => {
      if (recorded.method === 'GET') {
        return json(response, 200, [
          {
            id: 7,
            name: 'bug',
            color: 'd73a4a',
            description: '',
            url: 'https://evil.example/api/stolen',
          },
        ]);
      }
      return json(response, 500, {
        message: `upstream rejected token ${recorded.headers['authorization'] ?? ''}`,
      });
    });
    servers.push(server);
    const listed = await invoke(
      [
        'label',
        'list',
        '--repo',
        'acme/widgets',
        '--base-url',
        server.baseUrl,
        '--token-env',
        'TOKEN',
        '--json',
      ],
      { TOKEN: 'super-secret-token' },
    );
    expect(
      parseJson<{ labels: Array<{ api_url: string }> }>(listed.output).labels[0]
        ?.api_url,
    ).toBe(`${server.baseUrl}/api/v1/repos/acme/widgets/labels/7`);
    expect(listed.output).not.toContain('evil.example');

    const failed = await invoke(
      [
        'label',
        'delete',
        '--repo',
        'acme/widgets',
        'bug',
        '--base-url',
        server.baseUrl,
        '--token-env',
        'TOKEN',
        '--json',
      ],
      { TOKEN: 'super-secret-token' },
    );
    expect(failed.exitCode).toBe(1);
    expect(failed.output).not.toContain('super-secret-token');
  });
});
