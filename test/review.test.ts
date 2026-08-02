import { afterEach, describe, expect, it } from 'vitest';
import {
  closeServers,
  connection,
  invoke,
  json,
  loadFixture as load,
  parseJson,
  servers,
  startServer,
  type FakeServer,
} from './server.js';

interface ReviewWorld {
  reviews: Array<Record<string, unknown>>;
  reviewComments: Array<Record<string, unknown>>;
  diff: string;
}

interface ReviewComment {
  id: number;
  api_url: string;
  path: string | null;
  position: number | null;
  original_position: number | null;
  commit_id: string | null;
  original_commit_id: string | null;
  diff_hunk: string;
  diff_hunk_length: number;
  diff_hunk_truncated: boolean;
  user: string | null;
  resolved_by: string | null;
  body: string;
  body_truncated: boolean;
}

interface Review {
  id: number;
  api_url: string;
  user: string | null;
  team: string | null;
  state: string | null;
  stale: boolean;
  official: boolean;
  dismissed: boolean;
  submitted_at: string | null;
  updated_at: string | null;
  comments: ReviewComment[];
  body: string;
  body_length: number;
  body_truncated: boolean;
}

interface ReviewsOutput {
  reviews: Review[];
  page_info: { fetched: number; displayed: number; truncated: boolean };
  next?: string[];
}

interface DiffOutput {
  diff: string;
  diff_info: { lines: number; displayed: number; truncated: boolean };
  next?: string[];
}

/** Only review 502 carries inline comments, matching both fixtures. */
const COMMENTED_REVIEW = 502;

afterEach(closeServers);

async function reviewServer(world: ReviewWorld): Promise<FakeServer> {
  // No swagger route: neither subcommand probes capabilities, so a host that
  // answered one would be answering a request these commands never make.
  const server = await startServer((_request, response, recorded) => {
    const url = new URL(recorded.url, 'http://fake');
    const path = url.pathname.replace('/api/v1/repos/acme/widgets', '');
    const page = Number(url.searchParams.get('page') ?? '1');

    if (path === '/pulls/42/reviews' && recorded.method === 'GET') {
      return json(response, 200, page === 1 ? world.reviews : []);
    }
    const comments = /^\/pulls\/42\/reviews\/(\d+)\/comments$/.exec(path);
    if (comments?.[1] && recorded.method === 'GET') {
      const review = Number(comments[1]);
      return json(
        response,
        200,
        review === COMMENTED_REVIEW ? world.reviewComments : [],
      );
    }
    if (path === '/pulls/42.diff' && recorded.method === 'GET') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain');
      response.end(world.diff);
      return;
    }
    return json(response, 404, { message: 'not found' });
  });
  servers.push(server);
  return server;
}

/** Reviews without inline comments, so the row count is the only variable. */
function manyReviews(count: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 1; index <= count; index += 1) {
    rows.push({
      id: 700 + index,
      state: 'COMMENT',
      body: `Note ${index}`,
      commit_id: 'abc123',
      stale: false,
      official: false,
      dismissed: false,
      comments_count: 0,
      submitted_at: '2026-01-06T00:00:00Z',
      user: { login: `reviewer-${index}` },
    });
  }
  return rows;
}

function longDiff(bodyLines: number): string {
  let text = 'diff --git a/src/big.ts b/src/big.ts\n';
  for (let index = 1; index <= bodyLines; index += 1) {
    text += `+ line ${index}\n`;
  }
  return text;
}

describe('pr reviews', () => {
  for (const version of [15, 16] as const) {
    it(`renders reviewer, verdict, body and inline comments on Forgejo ${version}`, async () => {
      const server = await reviewServer(await load<ReviewWorld>(version));
      const result = await invoke([
        'pr',
        'reviews',
        ...connection(server),
        '42',
      ]);
      expect(result.exitCode).toBeUndefined();
      const output = parseJson<ReviewsOutput>(result.output);
      expect(output.reviews).toHaveLength(3);
      const [approved, changes, requested] = output.reviews as [
        Review,
        Review,
        Review,
      ];

      expect(approved.user).toBe('reviewer-one');
      expect(approved.state).toBe('APPROVED');
      expect(approved.body).toBe('Looks good.');
      expect(approved.official).toBe(true);
      expect(approved.stale).toBe(false);
      expect(approved.comments).toEqual([]);
      expect(approved.api_url).toBe(
        `${server.baseUrl}/api/v1/repos/acme/widgets/pulls/42/reviews/501`,
      );

      expect(changes.state).toBe('REQUEST_CHANGES');
      expect(changes.stale).toBe(true);
      expect(changes.comments).toHaveLength(2);
      const [first, second] = changes.comments as [
        ReviewComment,
        ReviewComment,
      ];
      expect(first.path).toBe('src/worker.ts');
      expect(first.position).toBe(12);
      expect(first.commit_id).toBe('abc123');
      expect(first.diff_hunk).toContain('@@ -8,6 +8,9 @@');
      expect(first.user).toBe('reviewer-two');
      expect(first.resolved_by).toBeNull();
      expect(first.api_url).toBe(
        `${server.baseUrl}/api/v1/repos/acme/widgets/pulls/42/reviews/502/comments/601`,
      );
      expect(second.path).toBe('src/queue.ts');
      expect(second.position).toBe(40);
      expect(second.resolved_by).toBe('reviewer-one');

      expect(requested.state).toBe('REQUEST_REVIEW');
      // Forgejo serialises an unsubmitted review's time as Go's zero value.
      expect(requested.submitted_at).toBeNull();
      expect(requested.comments).toEqual([]);
    });
  }

  it('requests inline comments only for reviews that report them', async () => {
    const server = await reviewServer(await load<ReviewWorld>(16));
    await invoke(['pr', 'reviews', ...connection(server), '42']);
    const commentRequests = server.requests
      .map((request) => request.url)
      .filter((url) => url.includes('/comments'));
    expect(commentRequests).toEqual([
      '/api/v1/repos/acme/widgets/pulls/42/reviews/502/comments',
    ]);
  });

  it('issues no write request against the review API', async () => {
    const server = await reviewServer(await load<ReviewWorld>(16));
    await invoke(['pr', 'reviews', ...connection(server), '42']);
    await invoke(['pr', 'diff', ...connection(server), '42']);
    expect(server.requests.length).toBeGreaterThan(0);
    expect([
      ...new Set(server.requests.map((request) => request.method)),
    ]).toEqual(['GET']);
  });

  it('renders TOON with the verdict and the anchored comment', async () => {
    const server = await reviewServer(await load<ReviewWorld>(15));
    const result = await invoke([
      'pr',
      'reviews',
      ...connection(server, false),
      '42',
    ]);
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain('REQUEST_CHANGES');
    expect(result.output).toContain('src/worker.ts');
    expect(result.output).toContain('fetched: 3');
  });

  it('caps the TOON list at thirty reviews and points at --full', async () => {
    const fixture = await load<ReviewWorld>(16);
    const server = await reviewServer({ ...fixture, reviews: manyReviews(31) });
    const capped = await invoke([
      'pr',
      'reviews',
      ...connection(server, false),
      '42',
    ]);
    expect(capped.output).toContain('displayed: 30');
    expect(capped.output).toContain('--full');

    const full = await invoke([
      'pr',
      'reviews',
      ...connection(server, false),
      '42',
      '--full',
    ]);
    expect(full.output).toContain('displayed: 31');
  });

  it('honours --limit when displaying reviews', async () => {
    const fixture = await load<ReviewWorld>(16);
    const server = await reviewServer({ ...fixture, reviews: manyReviews(31) });
    const limited = await invoke([
      'pr',
      'reviews',
      ...connection(server, false),
      '42',
      '--limit',
      '5',
    ]);
    expect(limited.exitCode).toBeUndefined();
    expect(limited.output).toContain('fetched: 31');
    expect(limited.output).toContain('displayed: 5');
    expect(limited.output).toContain('truncated: true');
  });

  it('names the team when a review is requested from one', async () => {
    const fixture = await load<ReviewWorld>(16);
    const server = await reviewServer({
      ...fixture,
      reviews: [
        {
          id: 504,
          state: 'REQUEST_REVIEW',
          body: '',
          comments_count: 0,
          submitted_at: '0001-01-01T00:00:00Z',
          updated_at: '2026-01-06T00:00:00Z',
          team: { name: 'platform' },
        },
      ],
    });
    const output = parseJson<ReviewsOutput>(
      (await invoke(['pr', 'reviews', ...connection(server), '42'])).output,
    );
    const review = output.reviews[0];
    expect(review?.user).toBeNull();
    expect(review?.team).toBe('platform');
    expect(review?.submitted_at).toBeNull();
    expect(review?.updated_at).toBe('2026-01-06T00:00:00Z');
  });

  it('caps a long diff hunk until --full', async () => {
    const fixture = await load<ReviewWorld>(16);
    // The hunk carries an astral character so these assertions discriminate
    // code points from UTF-16 units. An ASCII-only hunk makes the two agree,
    // which would let a UTF-16 implementation pass unnoticed.
    const hunk = `@@ -1,1 +1,1 @@\n${'+ context 🌈 line\n'.repeat(80)}`;
    const hunkPoints = [...hunk].length;
    const server = await reviewServer({
      ...fixture,
      reviews: [
        {
          id: COMMENTED_REVIEW,
          state: 'COMMENT',
          body: 'See inline.',
          comments_count: 1,
          submitted_at: '2026-01-06T00:00:00Z',
          user: { login: 'reviewer-two' },
        },
      ],
      reviewComments: [
        {
          id: 999,
          body: 'note',
          path: 'src/big.ts',
          position: 3,
          commit_id: 'abc123',
          diff_hunk: hunk,
          user: { login: 'reviewer-two' },
          created_at: '2026-01-06T00:00:00Z',
          updated_at: '2026-01-06T00:00:00Z',
        },
      ],
    });
    expect(hunkPoints).toBeGreaterThan(500);
    expect(hunk.length).toBeGreaterThan(hunkPoints);
    const capped = parseJson<ReviewsOutput>(
      (await invoke(['pr', 'reviews', ...connection(server), '42'])).output,
    );
    expect([...(capped.reviews[0]?.comments[0]?.diff_hunk ?? '')]).toHaveLength(
      500,
    );
    expect(capped.reviews[0]?.comments[0]?.diff_hunk_truncated).toBe(true);
    expect(capped.reviews[0]?.comments[0]?.diff_hunk_length).toBe(hunkPoints);

    const full = parseJson<ReviewsOutput>(
      (await invoke(['pr', 'reviews', ...connection(server), '42', '--full']))
        .output,
    );
    expect(full.reviews[0]?.comments[0]?.diff_hunk).toBe(hunk);
    expect(full.reviews[0]?.comments[0]?.diff_hunk_truncated).toBe(false);
    expect(full.reviews[0]?.comments[0]?.diff_hunk_length).toBe(hunkPoints);
  });

  it('renders an empty review list per the contract', async () => {
    const fixture = await load<ReviewWorld>(15);
    const server = await reviewServer({ ...fixture, reviews: [] });
    const result = await invoke(['pr', 'reviews', ...connection(server), '42']);
    expect(result.exitCode).toBeUndefined();
    const output = parseJson<ReviewsOutput>(result.output);
    expect(output.reviews).toEqual([]);
    expect(output.page_info.fetched).toBe(0);
    expect(output.next).toBeUndefined();
  });

  it('previews a long review body until --full', async () => {
    const fixture = await load<ReviewWorld>(16);
    const body = 'x'.repeat(600);
    const server = await reviewServer({
      ...fixture,
      reviews: [
        {
          id: 900,
          state: 'COMMENT',
          body,
          comments_count: 0,
          submitted_at: '2026-01-06T00:00:00Z',
          user: { login: 'reviewer-one' },
        },
      ],
    });
    const preview = parseJson<ReviewsOutput>(
      (await invoke(['pr', 'reviews', ...connection(server), '42'])).output,
    );
    expect(preview.reviews[0]?.body_truncated).toBe(true);
    expect(preview.reviews[0]?.body_length).toBe(600);
    expect(preview.reviews[0]?.body).toHaveLength(500);

    const full = parseJson<ReviewsOutput>(
      (await invoke(['pr', 'reviews', ...connection(server), '42', '--full']))
        .output,
    );
    expect(full.reviews[0]?.body).toBe(body);
    expect(full.reviews[0]?.body_truncated).toBe(false);
  });
});

describe('pr diff', () => {
  for (const version of [15, 16] as const) {
    it(`returns the unified diff on Forgejo ${version}`, async () => {
      const server = await reviewServer(await load<ReviewWorld>(version));
      const result = await invoke(['pr', 'diff', ...connection(server), '42']);
      expect(result.exitCode).toBeUndefined();
      const output = parseJson<DiffOutput>(result.output);
      expect(output.diff).toContain('diff --git a/src/worker.ts');
      expect(output.diff).toContain('+  await lock.acquire();');
      expect(output.diff_info.truncated).toBe(false);
      expect(output.diff_info.lines).toBe(7);
      expect(server.requests.at(-1)?.url).toBe(
        '/api/v1/repos/acme/widgets/pulls/42.diff',
      );
    });
  }

  it('caps the TOON diff at thirty lines and documents the path to the rest', async () => {
    const fixture = await load<ReviewWorld>(16);
    const sent = longDiff(60);
    const server = await reviewServer({ ...fixture, diff: sent });
    const capped = await invoke([
      'pr',
      'diff',
      ...connection(server, false),
      '42',
    ]);
    expect(capped.exitCode).toBeUndefined();
    expect(capped.output).toContain('lines: 61');
    expect(capped.output).toContain('displayed: 30');
    expect(capped.output).toContain('truncated: true');
    expect(capped.output).toContain(
      'Rerun with --full to print the complete diff',
    );

    const full = await invoke([
      'pr',
      'diff',
      ...connection(server, false),
      '42',
      '--full',
    ]);
    expect(full.output).toContain('displayed: 61');
    expect(full.output).toContain('truncated: false');

    // --json is the other complete path, and it returns the forge's bytes
    // unchanged — trailing newline included — so a saved patch still applies.
    const asJson = parseJson<DiffOutput>(
      (await invoke(['pr', 'diff', ...connection(server), '42'])).output,
    );
    expect(asJson.diff_info).toEqual({
      lines: 61,
      displayed: 61,
      truncated: false,
    });
    expect(asJson.diff).toBe(sent);
    expect(asJson.next).toBeUndefined();
  });

  it('renders an empty diff without truncation', async () => {
    const fixture = await load<ReviewWorld>(15);
    const server = await reviewServer({ ...fixture, diff: '' });
    const result = await invoke(['pr', 'diff', ...connection(server), '42']);
    expect(result.exitCode).toBeUndefined();
    const output = parseJson<DiffOutput>(result.output);
    expect(output.diff).toBe('');
    expect(output.diff_info).toEqual({
      lines: 0,
      displayed: 0,
      truncated: false,
    });
    expect(output.next).toBeUndefined();
  });

  it('redacts a token that appears in the diff text', async () => {
    const fixture = await load<ReviewWorld>(16);
    const server = await reviewServer({
      ...fixture,
      diff: '+const token = "super-secret-token";\n',
    });
    const result = await invoke(
      ['pr', 'diff', ...connection(server), '42', '--token-env', 'TOKEN'],
      { TOKEN: 'super-secret-token' },
    );
    expect(result.exitCode).toBeUndefined();
    expect(result.output).not.toContain('super-secret-token');
    expect(result.output).toContain('[REDACTED]');
  });
});

describe('review surface invocation', () => {
  it('offers no write subcommand for reviews', async () => {
    for (const subcommand of ['review', 'submit', 'dismiss', 'approve']) {
      const result = await invoke(['pr', subcommand, '--repo', 'acme/widgets']);
      expect(result.exitCode, subcommand).toBe(2);
      expect(result.output, subcommand).toContain(
        `Unknown pr command: ${subcommand}`,
      );
    }
  });

  it('rejects invalid invocations', async () => {
    const cases: Array<[string[], string]> = [
      [['pr', 'reviews', '42'], '--repo is required'],
      [['pr', 'diff', '42'], '--repo is required'],
      [['pr', 'reviews', '--repo', 'acme/widgets'], 'pull request number'],
      [['pr', 'diff', '--repo', 'acme/widgets'], 'pull request number'],
      [
        ['pr', 'reviews', '--repo', 'acme/widgets', '42', '7'],
        'Unexpected arguments',
      ],
      [
        [
          'pr',
          'reviews',
          '--repo',
          'acme/widgets',
          '42',
          '--full',
          '--limit',
          '5',
        ],
        '--full and --limit cannot be combined',
      ],
      [
        [
          'pr',
          'reviews',
          '--repo',
          'acme/widgets',
          '42',
          '--json',
          '--limit',
          '5',
        ],
        '--limit cannot be combined with --json',
      ],
    ];
    for (const [argv, expected] of cases) {
      const result = await invoke(argv);
      expect(result.exitCode, argv.join(' ')).toBe(2);
      expect(result.output, argv.join(' ')).toContain(expected);
    }
  });

  it('documents both subcommands without configuration', async () => {
    const family = await invoke(['pr', '--help']);
    expect(family.output).toContain('reviews');
    expect(family.output).toContain('diff');

    const reviews = await invoke(['pr', 'reviews', '--help']);
    expect(reviews.output).toContain('forgejo-axi pr reviews --repo');
    expect(reviews.output).toContain('--full');

    const diff = await invoke(['pr', 'diff', '--help']);
    expect(diff.output).toContain('forgejo-axi pr diff --repo');
    expect(diff.output).toContain('--full');
  });
});

describe('review anchors Forgejo reports as zero values', () => {
  it('anchors a comment on a removed line to the original side', async () => {
    const fixture = await load<ReviewWorld>(16);
    const server = await reviewServer({
      ...fixture,
      reviews: [
        {
          id: COMMENTED_REVIEW,
          state: 'COMMENT',
          body: '',
          comments_count: 1,
          user: { login: 'reviewer-two' },
        },
      ],
      reviewComments: [
        {
          id: 601,
          body: 'This line should not have gone.',
          path: 'src/worker.ts',
          position: 0,
          original_position: 47,
          commit_id: '',
          original_commit_id: 'old123',
          diff_hunk: '@@ -47 +0,0 @@',
          user: { login: 'reviewer-two' },
        },
      ],
    });
    const output = parseJson<ReviewsOutput>(
      (await invoke(['pr', 'reviews', ...connection(server), '42'])).output,
    );
    const comment = output.reviews[0]?.comments[0];
    expect(comment?.path).toBe('src/worker.ts');
    expect(comment?.position).toBeNull();
    expect(comment?.commit_id).toBeNull();
    expect(comment?.original_position).toBe(47);
    expect(comment?.original_commit_id).toBe('old123');
  });

  it('reports an unmapped verdict and an absent anchor as null', async () => {
    const fixture = await load<ReviewWorld>(15);
    const server = await reviewServer({
      ...fixture,
      reviews: [
        {
          id: COMMENTED_REVIEW,
          state: '',
          body: '',
          comments_count: 1,
          user: { login: 'reviewer-two' },
        },
      ],
      reviewComments: [
        {
          id: 601,
          body: 'Detached from the diff.',
          path: '',
          position: 0,
          commit_id: '',
          user: { login: 'reviewer-two' },
        },
      ],
    });
    const output = parseJson<ReviewsOutput>(
      (await invoke(['pr', 'reviews', ...connection(server), '42'])).output,
    );
    expect(output.reviews[0]?.state).toBeNull();
    const comment = output.reviews[0]?.comments[0];
    expect(comment?.path).toBeNull();
    expect(comment?.position).toBeNull();
    expect(comment?.original_position).toBeNull();
  });

  it('fetches comments for a review that reports no count at all', async () => {
    const fixture = await load<ReviewWorld>(16);
    const server = await reviewServer({
      ...fixture,
      reviews: [
        {
          id: COMMENTED_REVIEW,
          state: 'COMMENT',
          body: '',
          user: { login: 'reviewer-two' },
        },
      ],
    });
    const output = parseJson<ReviewsOutput>(
      (await invoke(['pr', 'reviews', ...connection(server), '42'])).output,
    );
    expect(output.reviews[0]?.comments).toHaveLength(2);
  });
});

describe('malformed review and diff responses', () => {
  it('rejects a review without a usable id', async () => {
    const server = await startServer((_request, response) =>
      json(response, 200, [{ state: 'COMMENT', comments_count: 0 }]),
    );
    servers.push(server);
    const result = await invoke(['pr', 'reviews', ...connection(server), '42']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('omitted a valid id');
  });

  it('rejects a non-array review comment response', async () => {
    const server = await startServer((_request, response, recorded) => {
      const url = new URL(recorded.url, 'http://fake');
      if (url.pathname.endsWith('/comments'))
        return json(response, 200, { comments: [] });
      return json(response, 200, [
        { id: COMMENTED_REVIEW, state: 'COMMENT', comments_count: 2 },
      ]);
    });
    servers.push(server);
    const result = await invoke(['pr', 'reviews', ...connection(server), '42']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('non-array review comment response');
  });

  it('rejects a review comment without a usable id', async () => {
    const server = await startServer((_request, response, recorded) => {
      const url = new URL(recorded.url, 'http://fake');
      if (url.pathname.endsWith('/comments'))
        return json(response, 200, [{ path: 'src/worker.ts', position: 1 }]);
      return json(response, 200, [
        { id: COMMENTED_REVIEW, state: 'COMMENT', comments_count: 1 },
      ]);
    });
    servers.push(server);
    const result = await invoke(['pr', 'reviews', ...connection(server), '42']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('omitted a valid id');
  });

  it('rejects a diff response that is not text', async () => {
    const server = await startServer((_request, response) =>
      json(response, 200, { diff: 'wrong shape' }),
    );
    servers.push(server);
    const result = await invoke(['pr', 'diff', ...connection(server), '42']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('non-text diff response');
  });
});
