import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConnection } from '../src/config.js';
import {
  ForgejoService,
  parseRepository,
  type ChecksResult,
} from '../src/forgejo.js';
import { json, startServer, type FakeServer } from './server.js';

interface Fixture {
  pull: Record<string, unknown>;
}

const servers: FakeServer[] = [];
const repo = parseRepository('acme/widgets');

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fixture(): Promise<Fixture> {
  return parseJson<Fixture>(
    await readFile(
      new URL('./fixtures/forgejo-15.json', import.meta.url),
      'utf8',
    ),
  );
}

async function serviceFor(server: FakeServer): Promise<ForgejoService> {
  return new ForgejoService(
    await resolveConnection({ baseUrl: server.baseUrl }, {}),
  );
}

describe('normalized checks', () => {
  const cases: Array<{
    name: string;
    statuses: Array<Record<string, unknown>>;
    required: string[];
    state: ChecksResult['state'];
    requiredState: ChecksResult['required_state'];
    passes: boolean;
  }> = [
    {
      name: 'empty reports with no requirements',
      statuses: [],
      required: [],
      state: 'none',
      requiredState: 'not_required',
      passes: false,
    },
    {
      name: 'missing required context',
      statuses: [{ context: 'other', status: 'success' }],
      required: ['ci'],
      state: 'success',
      requiredState: 'missing',
      passes: false,
    },
    {
      name: 'empty reports with a requirement',
      statuses: [],
      required: ['ci'],
      state: 'none',
      requiredState: 'missing',
      passes: false,
    },
    {
      name: 'failed required context',
      statuses: [{ context: 'ci', status: 'failure' }],
      required: ['ci'],
      state: 'failure',
      requiredState: 'failure',
      passes: false,
    },
    {
      name: 'pending required context',
      statuses: [{ context: 'ci', status: 'pending' }],
      required: ['ci'],
      state: 'pending',
      requiredState: 'pending',
      passes: false,
    },
    {
      name: 'successful required glob',
      statuses: [
        { context: 'ci/unit', status: 'success' },
        { context: 'ci/lint', status: 'success' },
      ],
      required: ['ci/*'],
      state: 'success',
      requiredState: 'success',
      passes: true,
    },
    {
      name: 'treats leading bang as a literal, not minimatch negation',
      statuses: [{ context: 'other', status: 'success' }],
      required: ['!ci'],
      state: 'success',
      requiredState: 'missing',
      passes: false,
    },
  ];

  it.each(cases)(
    '$name',
    async ({ statuses, required, state, requiredState, passes }) => {
      const data = await fixture();
      const server = await startServer((_request, response, recorded) => {
        const path = new URL(recorded.url, 'http://fake').pathname;
        if (path.endsWith('/pulls/42')) return json(response, 200, data.pull);
        if (path.endsWith('/statuses/abc123'))
          return json(response, 200, statuses);
        if (path.endsWith('/branches/main')) {
          return json(response, 200, {
            name: 'main',
            protected: required.length > 0,
            effective_branch_protection_name: required.length > 0 ? 'main' : '',
            enable_status_check: required.length > 0,
            status_check_contexts: required,
          });
        }
        return json(response, 404, { message: 'not found' });
      });
      servers.push(server);
      const service = await serviceFor(server);
      const checks = await service.checks(repo, 42);
      expect(checks.reported).toBe(statuses.length);
      expect(checks.state).toBe(state);
      expect(checks.required_state).toBe(requiredState);
      expect(checks.passes).toBe(passes);
    },
  );

  it('uses only the newest status for a repeated context', async () => {
    const data = await fixture();
    const server = await startServer((_request, response, recorded) => {
      const path = new URL(recorded.url, 'http://fake').pathname;
      if (path.endsWith('/pulls/42')) return json(response, 200, data.pull);
      if (path.endsWith('/statuses/abc123')) {
        return json(response, 200, [
          {
            context: 'ci',
            status: 'success',
            updated_at: '2026-01-02T00:00:00Z',
          },
          {
            context: 'ci',
            status: 'failure',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ]);
      }
      if (path.endsWith('/branches/main')) {
        return json(response, 200, {
          name: 'main',
          protected: true,
          enable_status_check: true,
          status_check_contexts: ['ci'],
        });
      }
      return json(response, 404, { message: 'not found' });
    });
    servers.push(server);
    const service = await serviceFor(server);
    const checks = await service.checks(repo, 42);
    expect(checks.reported).toBe(1);
    expect(checks.state).toBe('success');
    expect(checks.passes).toBe(true);
  });
});

describe('idempotent pull request mutations', () => {
  it('reuses an existing open head/base pull request without POST', async () => {
    const data = await fixture();
    const server = await startServer((_request, response, recorded) => {
      const path = new URL(recorded.url, 'http://fake').pathname;
      if (path.endsWith('/pulls') && recorded.method === 'GET') {
        response.setHeader('x-total-count', '1');
        return json(response, 200, [data.pull]);
      }
      if (path.endsWith('/pulls/42') && recorded.method === 'GET') {
        return json(response, 200, data.pull);
      }
      return json(response, 500, { message: 'unexpected mutation' });
    });
    servers.push(server);
    const result = await (
      await serviceFor(server)
    ).createPull(repo, {
      title: 'Fix race',
      body: 'Details',
      head: 'fix/race',
      base: 'main',
      draft: false,
    });
    expect(result).toMatchObject({ created: false, updated: false });
    expect(server.requests.some((request) => request.method === 'POST')).toBe(
      false,
    );
    expect(server.requests.some((request) => request.method === 'PATCH')).toBe(
      false,
    );
  });

  it('creates a draft through Forgejo 15 title semantics', async () => {
    const data = await fixture();
    let posted: Record<string, unknown> | undefined;
    const server = await startServer((_request, response, recorded) => {
      const path = new URL(recorded.url, 'http://fake').pathname;
      if (path.endsWith('/pulls') && recorded.method === 'GET') {
        response.setHeader('x-total-count', '0');
        return json(response, 200, []);
      }
      if (path.endsWith('/pulls') && recorded.method === 'POST') {
        posted = parseJson<Record<string, unknown>>(recorded.body);
        return json(response, 201, {
          ...data.pull,
          title: posted['title'],
          body: posted['body'],
          draft: true,
        });
      }
      return json(response, 404, { message: 'not found' });
    });
    servers.push(server);
    const result = await (
      await serviceFor(server)
    ).createPull(repo, {
      title: 'Fix race',
      body: 'Draft details',
      head: 'fix/race',
      base: 'main',
      draft: true,
    });
    expect(posted).toEqual({
      title: 'WIP: Fix race',
      body: 'Draft details',
      head: 'fix/race',
      base: 'main',
    });
    expect(result).toMatchObject({
      created: true,
      updated: false,
      pull_request: { draft: true, title: 'WIP: Fix race' },
    });
  });

  it('recovers idempotently when concurrent creation wins the race', async () => {
    const data = await fixture();
    let listCalls = 0;
    const server = await startServer((_request, response, recorded) => {
      const path = new URL(recorded.url, 'http://fake').pathname;
      if (path.endsWith('/pulls') && recorded.method === 'GET') {
        listCalls += 1;
        const pulls = listCalls === 1 ? [] : [data.pull];
        response.setHeader('x-total-count', String(pulls.length));
        return json(response, 200, pulls);
      }
      if (path.endsWith('/pulls') && recorded.method === 'POST') {
        return json(response, 409, {
          message: 'pull request already exists for head_repo_id 7',
        });
      }
      if (path.endsWith('/pulls/42') && recorded.method === 'GET') {
        return json(response, 200, data.pull);
      }
      return json(response, 404, { message: 'not found' });
    });
    servers.push(server);
    const result = await (
      await serviceFor(server)
    ).createPull(repo, {
      title: 'Fix race',
      body: 'Details',
      head: 'fix/race',
      base: 'main',
      draft: false,
    });
    expect(result).toMatchObject({ created: false, updated: false });
    expect(
      server.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
    expect(server.requests.some((request) => request.method === 'PATCH')).toBe(
      false,
    );
  });

  it('patches only changed fields and makes a repeated update a no-op', async () => {
    const data = await fixture();
    let pull = { ...data.pull };
    let patches = 0;
    const server = await startServer((_request, response, recorded) => {
      const path = new URL(recorded.url, 'http://fake').pathname;
      if (path.endsWith('/pulls/42') && recorded.method === 'GET') {
        return json(response, 200, pull);
      }
      if (path.endsWith('/pulls/42') && recorded.method === 'PATCH') {
        patches += 1;
        pull = {
          ...pull,
          ...parseJson<Record<string, unknown>>(recorded.body),
        };
        return json(response, 200, pull);
      }
      return json(response, 404, { message: 'not found' });
    });
    servers.push(server);
    const service = await serviceFor(server);
    const changed = await service.updatePull(repo, 42, { title: 'Fixed race' });
    const repeated = await service.updatePull(repo, 42, {
      title: 'Fixed race',
    });
    expect(changed).toMatchObject({ updated: true });
    expect(repeated).toMatchObject({ updated: false });
    expect(patches).toBe(1);
  });
});

describe('expected-head merge', () => {
  it('rejects a stale expected head without posting a merge', async () => {
    const data = await fixture();
    const server = await startServer((_request, response) =>
      json(response, 200, data.pull),
    );
    servers.push(server);
    const service = await serviceFor(server);
    await expect(
      service.merge(repo, 42, 'stale-sha', 'merge'),
    ).rejects.toMatchObject({ code: 'HEAD_CHANGED' });
    expect(server.requests.some((request) => request.method === 'POST')).toBe(
      false,
    );
  });

  it('passes the atomic head_commit_id and reports a server-side race', async () => {
    const data = await fixture();
    const server = await startServer((_request, response, recorded) => {
      if (recorded.method === 'POST') {
        expect(parseJson(recorded.body)).toEqual({
          Do: 'squash',
          head_commit_id: 'abc123',
        });
        return json(response, 409, { message: 'head out of date' });
      }
      return json(response, 200, data.pull);
    });
    servers.push(server);
    const service = await serviceFor(server);
    await expect(
      service.merge(repo, 42, 'abc123', 'squash'),
    ).rejects.toMatchObject({ code: 'HEAD_CHANGED' });
    expect(
      server.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
  });

  it('returns merged proof after success and makes repeats mutation-free', async () => {
    const data = await fixture();
    let merged = false;
    let posts = 0;
    const server = await startServer((_request, response, recorded) => {
      if (recorded.method === 'POST') {
        posts += 1;
        merged = true;
        response.statusCode = 200;
        response.end();
        return;
      }
      return json(response, 200, {
        ...data.pull,
        merged,
        state: merged ? 'closed' : 'open',
        merge_commit_sha: merged ? 'merge456' : null,
        merged_at: merged ? '2026-01-03T00:00:00Z' : null,
        merged_by: merged ? { login: 'robot' } : null,
      });
    });
    servers.push(server);
    const service = await serviceFor(server);
    const first = await service.merge(repo, 42, 'abc123', 'merge');
    const repeated = await service.merge(repo, 42, 'abc123', 'merge');
    expect(first).toEqual({
      merged: true,
      number: 42,
      url: `${server.baseUrl}/acme/widgets/pulls/42`,
      head_sha: 'abc123',
      merge_commit_sha: 'merge456',
      merged_at: '2026-01-03T00:00:00Z',
      merged_by: 'robot',
    });
    expect(repeated).toEqual(first);
    expect(posts).toBe(1);
  });
});

function parseJson<T = unknown>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Expected valid JSON: ${String(error)}`, { cause: error });
  }
}
