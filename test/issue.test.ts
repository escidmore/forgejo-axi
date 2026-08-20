import { afterEach, describe, expect, it } from 'vitest';
import {
  closeServers,
  connection,
  invoke,
  json,
  loadFixture,
  parseJson,
  servers,
  startServer,
  type FakeServer,
} from './server.js';

interface Fixture {
  labels: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  issue: Record<string, unknown>;
  comments: Array<Record<string, unknown>>;
}

interface IssueWorld {
  issue: Record<string, unknown>;
  comments: Array<Record<string, unknown>>;
  labels: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  list?: Array<Record<string, unknown>>;
}

afterEach(closeServers);

async function worldFor(version: 15 | 16): Promise<IssueWorld> {
  const fixture = await loadFixture<Fixture>(version);
  return {
    issue: fixture.issue,
    comments: fixture.comments,
    labels: fixture.labels,
    milestones: fixture.milestones,
  };
}

/** Apply a Forgejo request body the way Forgejo would: ids become objects. */
function applyIssuePatch(
  world: IssueWorld,
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'labels') {
      const ids = value as number[];
      next['labels'] = world.labels.filter((label) =>
        ids.includes(label['id'] as number),
      );
    } else if (key === 'assignees') {
      next['assignees'] = (value as string[]).map((login) => ({ login }));
    } else if (key === 'milestone') {
      next['milestone'] =
        world.milestones.find((item) => item['id'] === value) ?? null;
    } else if (key === 'state') {
      next['state'] = value;
      next['closed_at'] = value === 'closed' ? '2026-02-01T00:00:00Z' : null;
    } else {
      next[key] = value;
    }
  }
  return next;
}

async function issueServer(world: IssueWorld): Promise<FakeServer> {
  const state: IssueWorld = { ...world };
  let nextCommentId = 500;
  const server = await startServer((_request, response, recorded) => {
    const url = new URL(recorded.url, 'http://fake');
    const path = url.pathname.replace('/api/v1/repos/acme/widgets', '');
    const page = Number(url.searchParams.get('page') ?? '1');
    const body =
      recorded.body === ''
        ? {}
        : parseJson<Record<string, unknown>>(recorded.body);
    const number = Number(state.issue['number']);

    if (path === '/labels') {
      return json(response, 200, page === 1 ? state.labels : []);
    }
    if (path === '/milestones') {
      return json(response, 200, page === 1 ? state.milestones : []);
    }
    if (path === '/issues' && recorded.method === 'GET') {
      const rows = state.list ?? [state.issue];
      response.setHeader('x-total-count', String(rows.length));
      return json(response, 200, page === 1 ? rows : []);
    }
    if (path === '/issues' && recorded.method === 'POST') {
      state.issue = applyIssuePatch(
        state,
        { number: 7, state: 'open', comments: 0 },
        body,
      );
      return json(response, 201, state.issue);
    }
    if (path === `/issues/${number}/comments`) {
      if (recorded.method === 'GET') return json(response, 200, state.comments);
      nextCommentId += 1;
      const comment = {
        id: nextCommentId,
        body: body['body'],
        user: { login: 'robot' },
        created_at: '2026-02-01T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z',
      };
      state.comments = [...state.comments, comment];
      return json(response, 201, comment);
    }
    if (path === `/issues/${number}/labels` && recorded.method === 'PUT') {
      state.issue = applyIssuePatch(state, state.issue, body);
      return json(response, 200, state.issue['labels']);
    }
    if (path === `/issues/${number}`) {
      if (recorded.method === 'PATCH') {
        state.issue = applyIssuePatch(state, state.issue, body);
      }
      return json(response, 200, state.issue);
    }
    return json(response, 404, { message: 'not found' });
  });
  servers.push(server);
  return server;
}

describe('issue command family', () => {
  it.each([15, 16] as const)(
    'lists and views Forgejo %i issues in TOON and JSON',
    async (version) => {
      const server = await issueServer(await worldFor(version));

      const toon = await invoke([
        'issue',
        'list',
        ...connection(server, false),
      ]);
      expect(toon.exitCode).toBeUndefined();
      expect(toon.output).toContain('Race in scheduler');
      expect(toon.output).toContain('fetched: 1');

      const listed = await invoke(['issue', 'list', ...connection(server)]);
      const list = parseJson<{
        issues: Array<Record<string, unknown>>;
        page_info: Record<string, unknown>;
      }>(listed.output);
      expect(list.issues).toEqual([
        {
          number: 7,
          title: 'Race in scheduler',
          state: 'open',
          labels: ['bug'],
        },
      ]);
      expect(list.page_info).toMatchObject({ complete: true, fetched: 1 });

      const viewedToon = await invoke([
        'issue',
        'view',
        ...connection(server, false),
        '7',
      ]);
      expect(viewedToon.output).toContain('Reproduced on this host');

      const viewed = await invoke([
        'issue',
        'view',
        ...connection(server),
        '7',
      ]);
      const view = parseJson<{
        issue: Record<string, unknown>;
        comments: Array<Record<string, unknown>>;
        comment_info: Record<string, unknown>;
      }>(viewed.output);
      expect(view.issue).toMatchObject({
        number: 7,
        state: 'open',
        title: 'Race in scheduler',
        labels: ['bug'],
        assignees: ['robot'],
        milestone: 'v1.0',
        is_pull_request: false,
        user: 'reporter',
        body: 'Steps to reproduce',
        body_truncated: false,
        url: `${server.baseUrl}/acme/widgets/issues/7`,
        api_url: `${server.baseUrl}/api/v1/repos/acme/widgets/issues/7`,
      });
      expect(view.comments).toEqual([
        {
          id: 101,
          api_url: `${server.baseUrl}/api/v1/repos/acme/widgets/issues/comments/101`,
          user: 'robot',
          created_at: '2026-01-02T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          body: 'Reproduced on this host',
          body_length: 23,
          body_truncated: false,
        },
      ]);
      expect(view.comment_info).toEqual({
        fetched: 1,
        displayed: 1,
        truncated: false,
      });
    },
  );

  it('sends every list filter Forgejo understands', async () => {
    const server = await issueServer(await worldFor(16));
    const result = await invoke([
      'issue',
      'list',
      ...connection(server),
      '--state',
      'all',
      '--label',
      'bug,wontfix',
      '--assignee',
      'robot',
      '--milestone',
      'v1.0',
    ]);
    expect(result.exitCode).toBeUndefined();
    const query = new URL(
      server.requests.find((request) => request.url.includes('/issues?'))!.url,
      'http://fake',
    ).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      state: 'all',
      type: 'issues',
      labels: 'bug,wontfix',
      milestones: '3',
      assigned_by: 'robot',
    });
  });

  it('ignores empty entries in a comma-separated value', async () => {
    const server = await issueServer(await worldFor(16));
    const result = await invoke([
      'issue',
      'list',
      ...connection(server),
      '--label',
      'bug, ',
    ]);
    expect(result.exitCode).toBeUndefined();
    const query = new URL(
      server.requests.find((request) => request.url.includes('/issues?'))!.url,
      'http://fake',
    ).searchParams;
    expect(query.get('labels')).toBe('bug');
  });

  it('refuses empty values that have no Forgejo state to reach', async () => {
    const server = await issueServer(await worldFor(16));
    const title = await invoke([
      'issue',
      'edit',
      ...connection(server),
      '7',
      '--title',
      '',
    ]);
    expect(title.exitCode).toBe(2);
    expect(parseJson(title.output)).toMatchObject({
      error: '--title cannot be empty',
    });

    const comment = await invoke([
      'issue',
      'close',
      ...connection(server),
      '7',
      '--comment',
      '',
    ]);
    expect(comment.exitCode).toBe(2);
    expect(parseJson(comment.output)).toMatchObject({
      error: '--comment cannot be empty',
    });

    expect(server.requests.some((request) => request.method !== 'GET')).toBe(
      false,
    );
  });

  it('refuses filter names Forgejo would silently discard', async () => {
    const server = await issueServer(await worldFor(16));
    const label = await invoke([
      'issue',
      'list',
      ...connection(server),
      '--label',
      'ghost',
    ]);
    expect(label.exitCode).toBe(2);
    expect(parseJson(label.output)).toMatchObject({
      code: 'LABEL_NOT_FOUND',
      details: { name: 'ghost' },
      help: ['Run `forgejo-axi label list --repo acme/widgets`'],
    });

    const milestone = await invoke([
      'issue',
      'list',
      ...connection(server),
      '--milestone',
      'v9.9',
    ]);
    expect(milestone.exitCode).toBe(2);
    expect(parseJson(milestone.output)).toMatchObject({
      code: 'MILESTONE_NOT_FOUND',
      details: { name: 'v9.9' },
    });

    expect(
      server.requests.some((request) => request.url.includes('/issues?')),
    ).toBe(false);
  });

  it('narrows issue view to the requested fields and leaves the thread alone', async () => {
    const world = await worldFor(16);
    const server = await issueServer(world);
    const args = ['issue', 'view', ...connection(server), '7'];

    const wide = parseJson<{
      issue: Record<string, unknown>;
      comments: unknown[];
    }>((await invoke(args)).output);
    const narrow = parseJson<{
      issue: Record<string, unknown>;
      comments: unknown[];
    }>((await invoke([...args, '--fields', 'number,state,labels'])).output);

    expect(Object.keys(narrow.issue)).toEqual(['number', 'state', 'labels']);
    expect(narrow.issue['state']).toBe(wide.issue['state']);
    // --fields is scoped to the issue object; the comment thread is untouched.
    expect(narrow.comments).toEqual(wide.comments);

    const all = parseJson<{ issue: Record<string, unknown> }>(
      (await invoke([...args, '--fields', 'all'])).output,
    );
    expect(all.issue).toEqual(wide.issue);
  });

  it('previews long issue and comment bodies until --full', async () => {
    const world = await worldFor(16);
    const long = 'x'.repeat(600);
    const server = await issueServer({
      ...world,
      issue: { ...world.issue, body: long },
      comments: [{ ...world.comments[0], body: long }],
    });
    const args = ['issue', 'view', ...connection(server), '7'];

    const preview = parseJson<{
      issue: { body: string; body_length: number; body_truncated: boolean };
      comments: Array<{ body: string; body_truncated: boolean }>;
    }>((await invoke(args)).output);
    expect(preview.issue).toMatchObject({
      body: `${'x'.repeat(497)}...`,
      body_length: 600,
      body_truncated: true,
    });
    expect(preview.comments[0]).toMatchObject({ body_truncated: true });

    const full = parseJson<{
      issue: { body: string; body_truncated: boolean };
      comments: Array<{ body: string; body_truncated: boolean }>;
    }>((await invoke([...args, '--full'])).output);
    expect(full.issue).toMatchObject({ body: long, body_truncated: false });
    expect(full.comments[0]).toMatchObject({
      body: long,
      body_truncated: false,
    });
  });

  it('caps the displayed comment thread until --full', async () => {
    const world = await worldFor(16);
    const server = await issueServer({
      ...world,
      comments: Array.from({ length: 35 }, (_, index) => ({
        id: index + 1,
        body: `comment ${index + 1}`,
        user: { login: 'robot' },
        created_at: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      })),
    });
    const capped = await invoke([
      'issue',
      'view',
      ...connection(server, false),
      '7',
    ]);
    expect(capped.output).toContain('displayed: 30');
    expect(capped.output).toContain('Rerun with --full');

    const full = parseJson<{ comment_info: Record<string, unknown> }>(
      (await invoke(['issue', 'view', ...connection(server), '7', '--full']))
        .output,
    );
    expect(full.comment_info).toEqual({
      fetched: 35,
      displayed: 35,
      truncated: false,
    });
  });

  it.each([15, 16] as const)(
    'creates a Forgejo %i issue from resolved label and milestone ids',
    async (version) => {
      const server = await issueServer(await worldFor(version));
      const result = await invoke([
        'issue',
        'create',
        ...connection(server),
        '--title',
        'Scheduler stalls',
        '--body',
        'Observed twice',
        '--label',
        'bug',
        '--assignee',
        'robot',
        '--milestone',
        'v1.0',
      ]);
      expect(result.exitCode).toBeUndefined();
      const posted = server.requests.find(
        (request) => request.method === 'POST',
      )!;
      expect(parseJson(posted.body)).toEqual({
        title: 'Scheduler stalls',
        body: 'Observed twice',
        labels: [7],
        assignees: ['robot'],
        milestone: 3,
      });
      expect(parseJson(result.output)).toMatchObject({
        issue: {
          number: 7,
          title: 'Scheduler stalls',
          labels: ['bug'],
          assignees: ['robot'],
          milestone: 'v1.0',
        },
      });
    },
  );

  it('edits an issue once and treats the repeat as a mutation-free no-op', async () => {
    const server = await issueServer(await worldFor(16));
    const args = [
      'issue',
      'edit',
      ...connection(server),
      '7',
      '--title',
      'Race in the scheduler',
      '--label',
      'bug,enhancement',
    ];

    const first = parseJson<{ updated: boolean; issue: { labels: string[] } }>(
      (await invoke(args)).output,
    );
    expect(first.updated).toBe(true);
    expect(first.issue.labels).toEqual(['bug', 'enhancement']);
    expect(
      parseJson(server.requests.find((r) => r.method === 'PATCH')!.body),
    ).toEqual({ title: 'Race in the scheduler' });
    // Forgejo keeps issue labels off the issue patch body.
    expect(
      parseJson(server.requests.find((r) => r.method === 'PUT')!.body),
    ).toEqual({ labels: [7, 8] });

    const before = server.requests.length;
    const second = parseJson<{ updated: boolean }>((await invoke(args)).output);
    expect(second.updated).toBe(false);
    expect(
      server.requests
        .slice(before)
        .every((request) => request.method === 'GET'),
    ).toBe(true);
  });

  it('clears labels, assignees, and the milestone from empty values', async () => {
    const server = await issueServer(await worldFor(16));
    const result = parseJson<{
      updated: boolean;
      issue: { labels: string[]; assignees: string[]; milestone: null };
    }>(
      (
        await invoke([
          'issue',
          'edit',
          ...connection(server),
          '7',
          '--label',
          '',
          '--assignee',
          '',
          '--milestone',
          '',
        ])
      ).output,
    );
    expect(result.updated).toBe(true);
    expect(result.issue).toMatchObject({
      labels: [],
      assignees: [],
      milestone: null,
    });
    expect(
      parseJson(server.requests.find((r) => r.method === 'PATCH')!.body),
    ).toEqual({ assignees: [], milestone: 0 });
  });

  it('posts the closing comment before the state change', async () => {
    const server = await issueServer(await worldFor(16));
    const result = parseJson<{
      updated: boolean;
      issue: { state: string };
      comment: { body: string };
    }>(
      (
        await invoke([
          'issue',
          'close',
          ...connection(server),
          '7',
          '--comment',
          'Fixed in #42',
        ])
      ).output,
    );
    expect(result).toMatchObject({
      updated: true,
      issue: { state: 'closed' },
      comment: { body: 'Fixed in #42' },
    });
    const commentIndex = server.requests.findIndex(
      (request) =>
        request.method === 'POST' && request.url.includes('/comments'),
    );
    const patchIndex = server.requests.findIndex(
      (request) => request.method === 'PATCH',
    );
    expect(commentIndex).toBeGreaterThanOrEqual(0);
    expect(commentIndex).toBeLessThan(patchIndex);
  });

  it('reopens a closed issue and repeats as a no-op', async () => {
    const world = await worldFor(16);
    const server = await issueServer({
      ...world,
      issue: { ...world.issue, state: 'closed' },
    });
    const args = ['issue', 'reopen', ...connection(server), '7'];
    expect(parseJson((await invoke(args)).output)).toMatchObject({
      updated: true,
      issue: { state: 'open' },
    });
    expect(parseJson((await invoke(args)).output)).toMatchObject({
      updated: false,
      issue: { state: 'open' },
    });
  });

  it('comments on a pull request number through the issue endpoint', async () => {
    const world = await worldFor(16);
    const server = await issueServer({
      ...world,
      issue: { ...world.issue, number: 42, pull_request: { merged: false } },
    });
    const result = await invoke([
      'issue',
      'comment',
      ...connection(server),
      '42',
      '--body',
      'Reproduced on 15.0.5',
    ]);
    expect(result.exitCode).toBeUndefined();
    expect(parseJson(result.output)).toMatchObject({
      comment: { user: 'robot', body: 'Reproduced on 15.0.5' },
    });
    expect(
      server.requests.find((request) => request.method === 'POST')?.url,
    ).toContain('/issues/42/comments');
  });

  it('reports an empty issue list without an error', async () => {
    const server = await issueServer({ ...(await worldFor(16)), list: [] });
    const result = await invoke(['issue', 'list', ...connection(server)]);
    expect(result.exitCode).toBeUndefined();
    expect(parseJson(result.output)).toMatchObject({
      issues: [],
      page_info: { fetched: 0, complete: true },
    });
  });

  it('caps TOON rows, exposes every JSON row, and honours --fields', async () => {
    const world = await worldFor(16);
    const server = await issueServer({
      ...world,
      list: Array.from({ length: 35 }, (_, index) => ({
        ...world.issue,
        number: index + 1,
        title: `Issue ${index + 1}`,
      })),
    });
    const capped = await invoke([
      'issue',
      'list',
      ...connection(server, false),
    ]);
    expect(capped.output).toContain('displayed: 30');
    expect(capped.output).toContain('truncated: true');

    const selected = parseJson<{ issues: Array<Record<string, unknown>> }>(
      (
        await invoke([
          'issue',
          'list',
          ...connection(server),
          '--fields',
          'number,milestone',
        ])
      ).output,
    );
    expect(selected.issues).toHaveLength(35);
    expect(selected.issues[0]).toEqual({ number: 1, milestone: 'v1.0' });
  });

  it('rejects invalid invocations with exit code 2 and a usage hint', async () => {
    const cases: Array<[string[], string]> = [
      [['issue', 'view', '--repo', 'acme/widgets', 'zero'], 'Issue number'],
      [
        ['issue', 'edit', '--repo', 'acme/widgets', '7'],
        'at least one field to change',
      ],
      [
        ['issue', 'list', '--repo', 'acme/widgets', '--limit', '1'],
        'cannot be combined with --json',
      ],
      [['issue', 'nope', '--repo', 'acme/widgets'], 'Unknown issue command'],
      [
        ['issue', 'comment', '--repo', 'acme/widgets', '7'],
        '--body is required',
      ],
    ];
    for (const [argv, expected] of cases) {
      const result = await invoke([...argv, '--json']);
      expect(result.exitCode, argv.join(' ')).toBe(2);
      expect(result.output, argv.join(' ')).toContain(expected);
    }
  });

  it('shows issue help without requiring configuration', async () => {
    const family = await invoke(['issue', '--help']);
    expect(family.exitCode).toBeUndefined();
    expect(family.output).toContain('forgejo-axi issue <command> --help');

    const close = await invoke(['issue', 'close', '--help']);
    expect(close.output).toContain('--comment TEXT');
  });

  it('builds canonical issue URLs and redacts the token on failure', async () => {
    const server = await startServer((_request, response, recorded) => {
      if (recorded.method === 'GET') {
        if (recorded.url.endsWith('/comments')) return json(response, 200, []);
        return json(response, 200, {
          number: 7,
          state: 'open',
          title: 'Race',
          html_url: 'https://evil.example/stolen',
          url: 'https://evil.example/api/stolen',
        });
      }
      return json(response, 500, {
        message: `upstream rejected token ${recorded.headers['authorization'] ?? ''}`,
      });
    });
    servers.push(server);
    const auth = ['--token-env', 'TOKEN'];
    const env = { TOKEN: 'super-secret-token' };

    const viewed = await invoke(
      ['issue', 'view', ...connection(server), '7', ...auth],
      env,
    );
    expect(parseJson<{ issue: { url: string } }>(viewed.output).issue.url).toBe(
      `${server.baseUrl}/acme/widgets/issues/7`,
    );
    expect(viewed.output).not.toContain('evil.example');

    const failed = await invoke(
      [
        'issue',
        'comment',
        ...connection(server),
        '7',
        '--body',
        'hello',
        ...auth,
      ],
      env,
    );
    expect(failed.exitCode).toBe(1);
    expect(failed.output).not.toContain('super-secret-token');
  });
});
