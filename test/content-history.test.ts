import { afterEach, describe, expect, it } from 'vitest';
import {
  closeServers,
  invoke,
  json,
  servers,
  startServer,
  parseJson,
} from './server.js';

afterEach(closeServers);

const diffHtml =
  '<pre>caf&eacute; &amp; &lt;b&gt;\n<span class="gd">old &amp;</span><span class="gi">new &#x1f600;</span> tail</pre>';

async function historyServer(
  options: {
    status?: number;
    canSoftDelete?: boolean;
    deleteResponse?: Record<string, unknown> | null;
    deleteStatus?: number;
    historyCounts?: Record<string, number>;
    previousHistoryId?: number | null;
    diff?: string;
    repoPageVisible?: boolean;
  } = {},
) {
  const server = await startServer((_request, response, recorded) => {
    const url = new URL(recorded.url, 'http://fake');
    const path = url.pathname;
    if (path === '/api/v1/repos/acme/widgets/issues/7') {
      return json(response, 200, {
        number: 7,
        title: 'Issue with history',
        body: 'body',
        comments: 0,
      });
    }
    if (path === '/api/v1/repos/acme/widgets/issues/7/comments') {
      return json(response, 200, []);
    }
    if (path === '/api/v1/repos/acme/widgets/pulls/86') {
      return json(response, 200, {
        number: 86,
        title: 'Pull request with history',
        body: 'body',
      });
    }
    if (
      path.endsWith('/content-history/soft-delete') &&
      recorded.method === 'POST'
    ) {
      if (options.deleteStatus !== undefined)
        return json(response, options.deleteStatus, { message: 'not found' });
      return json(
        response,
        200,
        options.deleteResponse === undefined
          ? { ok: true, message: 'deleted' }
          : options.deleteResponse,
      );
    }
    // The repository's own web page: what separates a host without the
    // content-history routes from a repository the web root cannot read.
    if (!path.includes('/api/v1/') && path.endsWith('/acme/widgets')) {
      if (options.repoPageVisible === false)
        return json(response, 404, { message: 'Not found.' });
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html');
      response.end('<html lang="en"></html>');
      return;
    }
    if (options.status !== undefined)
      return json(response, options.status, { message: 'history unavailable' });
    if (path.endsWith('/content-history/overview')) {
      return json(response, 200, {
        editedHistoryCountMap: options.historyCounts ?? { '17': 2, '0': 5 },
        i18n: {},
      });
    }
    if (path.endsWith('/content-history/list')) {
      return json(response, 200, {
        results: [
          { name: '<span>Older &amp; edit</span>', value: 248 },
          { name: '<span>Newest &lt;b&gt; edit</span>', value: 249 },
        ],
      });
    }
    if (path.endsWith('/content-history/detail')) {
      return json(response, 200, {
        canSoftDelete: options.canSoftDelete ?? true,
        diffHtml: options.diff ?? diffHtml,
        historyId: Number(url.searchParams.get('history_id')),
        prevHistoryId: options.previousHistoryId ?? 248,
      });
    }
    return json(response, 404, { message: 'not found' });
  });
  servers.push(server);
  return server;
}

function historyArgs(
  server: { baseUrl: string },
  operation: string,
  number = '7',
  extra: string[] = [],
  family: 'issue' | 'pr' = 'issue',
): string[] {
  return [
    family,
    'history',
    operation,
    '--repo',
    'acme/widgets',
    '--base-url',
    server.baseUrl,
    '--token-env',
    'HISTORY_TOKEN',
    '--json',
    ...extra,
    number,
  ];
}

function viewArgs(
  server: { baseUrl: string },
  family: 'issue' | 'pr',
  number: string,
): string[] {
  return [
    family,
    'view',
    '--repo',
    'acme/widgets',
    '--base-url',
    server.baseUrl,
    '--token-env',
    'HISTORY_TOKEN',
    '--json',
    number,
  ];
}

describe('content history', () => {
  it('uses the web-root routes, defaults to the body, and normalizes newest first', async () => {
    const server = await historyServer();
    const result = await invoke(historyArgs(server, 'list'), {
      HISTORY_TOKEN: 'secret-token',
    });
    expect(result.exitCode).toBeUndefined();
    const output = parseJson<{
      comment_id: number;
      revisions: Array<Record<string, unknown>>;
    }>(result.output);
    expect(output).toEqual({
      comment_id: 0,
      revisions: [
        { history_id: 249, summary: 'Newest <b> edit' },
        { history_id: 248, summary: 'Older & edit' },
      ],
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe(
      '/acme/widgets/issues/7/content-history/list?comment_id=0',
    );
    expect(server.requests[0]?.headers.authorization).toBe(
      'token secret-token',
    );
  });

  it('uses the shared issue route for pull request comment history', async () => {
    const server = await historyServer();
    const result = await invoke(
      historyArgs(server, 'list', '86', ['--comment-id', '17'], 'pr'),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(result.exitCode).toBeUndefined();
    expect(parseJson(result.output)).toMatchObject({ comment_id: 17 });
    expect(server.requests[0]?.url).toBe(
      '/acme/widgets/issues/86/content-history/list?comment_id=17',
    );
  });

  it('adds a count and runnable hint to issue and pull request views', async () => {
    const issueServerInstance = await historyServer();
    const issueResult = await invoke(
      viewArgs(issueServerInstance, 'issue', '7'),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(parseJson(issueResult.output)).toMatchObject({
      issue: { edit_history_count: 7 },
      next: ['forgejo-axi issue history list --repo acme/widgets 7'],
    });

    const pullServer = await historyServer();
    const pullResult = await invoke(viewArgs(pullServer, 'pr', '86'), {
      HISTORY_TOKEN: 'secret-token',
    });
    expect(parseJson(pullResult.output)).toMatchObject({
      pull_request: { edit_history_count: 7 },
      next: ['forgejo-axi pr history list --repo acme/widgets 86'],
    });
  });

  it('keeps a view working when history enrichment is refused', async () => {
    const server = await historyServer({ status: 403 });
    const result = await invoke(viewArgs(server, 'issue', '7'), {
      HISTORY_TOKEN: 'secret-token',
    });
    expect(result.exitCode).toBeUndefined();
    const output = parseJson<{ issue: Record<string, unknown> }>(result.output);
    expect(output.issue).toMatchObject({ number: 7 });
    expect(output.issue).not.toHaveProperty('edit_history_count');
    expect(output).not.toHaveProperty('next');

    const asked = await invoke(historyArgs(server, 'overview'), {
      HISTORY_TOKEN: 'secret-token',
    });
    expect(asked.exitCode).not.toBeUndefined();
    expect(parseJson(asked.output)).toMatchObject({
      code: 'CONTENT_HISTORY_AUTHORIZATION',
    });
  });

  it('reports transport failures as themselves', async () => {
    const server = await historyServer({ status: 429 });
    const result = await invoke(historyArgs(server, 'list'), {
      HISTORY_TOKEN: 'secret-token',
    });
    expect(result.exitCode).not.toBeUndefined();
    expect(parseJson(result.output)).toMatchObject({ code: 'RATE_LIMITED' });

    const view = await invoke(viewArgs(server, 'pr', '86'), {
      HISTORY_TOKEN: 'secret-token',
    });
    expect(view.exitCode).toBeUndefined();
    expect(
      parseJson<{ pull_request: Record<string, unknown> }>(view.output)
        .pull_request,
    ).not.toHaveProperty('edit_history_count');
  });

  it('omits view history enrichment when the overview is empty', async () => {
    const server = await historyServer({ historyCounts: {} });
    const result = await invoke(viewArgs(server, 'issue', '7'), {
      HISTORY_TOKEN: 'secret-token',
    });
    const output = parseJson<{ issue: Record<string, unknown> }>(result.output);
    expect(output.issue).not.toHaveProperty('edit_history_count');
    expect(parseJson(result.output)).not.toHaveProperty('next');
  });

  it('preserves comment ids and reconstructs both sides exactly once', async () => {
    const server = await historyServer();
    const result = await invoke(
      historyArgs(server, 'detail', '7', [
        '--comment-id',
        '17',
        '--history-id',
        '249',
      ]),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(result.exitCode).toBeUndefined();
    const output = parseJson<{
      revision: Record<string, unknown>;
    }>(result.output);
    expect(output.revision).toEqual({
      history_id: 249,
      previous_history_id: 248,
      can_soft_delete: true,
      before: 'café & <b>\nold & tail',
      after: 'café & <b>\nnew 😀 tail',
    });
    expect(server.requests[0]?.url).toBe(
      '/acme/widgets/issues/7/content-history/detail?comment_id=17&history_id=249',
    );
  });

  // Markup as Forgejo 16.0.2 actually emits it: single-quoted class attributes,
  // a `chroma` class on the wrapper, and an edit that only inserts — the case
  // above quotes its attributes the other way and always carries both sides.
  it("reconstructs a real host's insertion-only diff", async () => {
    const server = await historyServer({
      diff:
        "<pre class='chroma'>native issue dependencies" +
        "<span class='gi'> (ticket bodies also note their blockers)</span>" +
        '; Forgejo&#39;s own wording</pre>',
    });
    const result = await invoke(
      historyArgs(server, 'detail', '7', ['--history-id', '249']),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(parseJson(result.output)).toMatchObject({
      revision: {
        before: "native issue dependencies; Forgejo's own wording",
        after:
          'native issue dependencies (ticket bodies also note their blockers)' +
          "; Forgejo's own wording",
      },
    });
  });

  it("normalizes Forgejo's zero previous-history sentinel to null", async () => {
    const server = await historyServer({ previousHistoryId: 0 });
    const result = await invoke(
      historyArgs(server, 'detail', '7', ['--history-id', '249']),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(parseJson(result.output)).toMatchObject({
      revision: { previous_history_id: null },
    });
  });

  it('includes raw HTML only when explicitly requested', async () => {
    const server = await historyServer();
    const result = await invoke(
      historyArgs(server, 'detail', '7', ['--history-id', '249', '--raw']),
      { HISTORY_TOKEN: 'secret-token' },
    );
    const output = parseJson<{ revision: Record<string, unknown> }>(
      result.output,
    );
    expect(output.revision['diff_html']).toBe(diffHtml);
  });

  it('requires explicit destructive intent before checking the server', async () => {
    const server = await historyServer();
    const result = await invoke(
      historyArgs(server, 'soft-delete', '7', ['--history-id', '249']),
    );
    expect(result.exitCode).toBe(2);
    expect(parseJson(result.output)).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: 'soft-delete requires --yes; no prompt is shown',
    });
    expect(server.requests).toHaveLength(0);
  });

  it('rejects a history id on list before contacting Forgejo', async () => {
    const server = await historyServer();
    const result = await invoke(
      historyArgs(server, 'list', '7', ['--history-id', '249']),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(result.exitCode).toBe(2);
    expect(parseJson(result.output)).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: 'list does not accept --history-id',
    });
    expect(server.requests).toHaveLength(0);
  });

  it('validates deletion permission and treats an already deleted revision as a no-op', async () => {
    const refusedServer = await historyServer({ canSoftDelete: false });
    const refused = await invoke(
      historyArgs(refusedServer, 'soft-delete', '7', [
        '--history-id',
        '249',
        '--yes',
      ]),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(refused.exitCode).not.toBeUndefined();
    expect(parseJson(refused.output)).toMatchObject({
      code: 'CONTENT_HISTORY_DELETE_REFUSED',
    });
    expect(refusedServer.requests).toHaveLength(1);

    const deletedServer = await historyServer({
      deleteResponse: { ok: false, message: 'revision already deleted' },
    });
    const deleted = await invoke(
      historyArgs(deletedServer, 'soft-delete', '7', [
        '--history-id',
        '249',
        '--yes',
      ]),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(deleted.exitCode).toBeUndefined();
    expect(parseJson(deleted.output)).toMatchObject({
      deleted: false,
      already_deleted: true,
      history_id: 249,
    });
    expect(deletedServer.requests.map((request) => request.method)).toEqual([
      'GET',
      'POST',
    ]);

    const failedServer = await historyServer({
      deleteResponse: { ok: false, message: 'revision could not be deleted' },
    });
    const failed = await invoke(
      historyArgs(failedServer, 'soft-delete', '7', [
        '--history-id',
        '249',
        '--yes',
      ]),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(parseJson(failed.output)).toMatchObject({
      code: 'CONTENT_HISTORY_DELETE_FAILED',
    });

    const emptyServer = await historyServer({ deleteResponse: null });
    const empty = await invoke(
      historyArgs(emptyServer, 'soft-delete', '7', [
        '--history-id',
        '249',
        '--yes',
      ]),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(parseJson(empty.output)).toMatchObject({
      code: 'CONTENT_HISTORY_DELETE_FAILED',
    });

    const racedServer = await historyServer({ deleteStatus: 404 });
    const raced = await invoke(
      historyArgs(racedServer, 'soft-delete', '7', [
        '--history-id',
        '249',
        '--yes',
      ]),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(parseJson(raced.output)).toMatchObject({
      deleted: false,
      already_deleted: true,
    });
  });

  it('translates unsupported routes and malformed diffs into stable errors', async () => {
    const unsupportedServer = await historyServer({ status: 404 });
    const unsupported = await invoke(
      historyArgs(unsupportedServer, 'overview'),
      {
        HISTORY_TOKEN: 'secret-token',
      },
    );
    expect(unsupported.exitCode).not.toBeUndefined();
    expect(parseJson(unsupported.output)).toMatchObject({
      code: 'CONTENT_HISTORY_UNSUPPORTED',
    });

    // Same 404s, but the web root cannot read the repository either: an
    // authorization failure, not a host without the feature.
    const invisibleServer = await historyServer({
      status: 404,
      repoPageVisible: false,
    });
    const invisible = await invoke(historyArgs(invisibleServer, 'overview'), {
      HISTORY_TOKEN: 'secret-token',
    });
    expect(parseJson(invisible.output)).toMatchObject({
      code: 'CONTENT_HISTORY_AUTHORIZATION',
    });
    const invisibleList = await invoke(historyArgs(invisibleServer, 'list'), {
      HISTORY_TOKEN: 'secret-token',
    });
    expect(parseJson(invisibleList.output)).toMatchObject({
      code: 'CONTENT_HISTORY_AUTHORIZATION',
    });

    const missingServer = await startServer((_request, response, recorded) => {
      const path = new URL(recorded.url, 'http://fake').pathname;
      if (path.endsWith('/content-history/overview'))
        return json(response, 200, { editedHistoryCountMap: {} });
      return json(response, 404, { message: 'history not found' });
    });
    servers.push(missingServer);
    const missing = await invoke(
      historyArgs(missingServer, 'detail', '7', ['--history-id', '249']),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(parseJson(missing.output)).toMatchObject({
      code: 'CONTENT_HISTORY_NOT_FOUND',
    });

    const malformedServer = await historyServer({
      diff: '<pre><span class="gd">broken</pre>',
    });
    const malformed = await invoke(
      historyArgs(malformedServer, 'detail', '7', ['--history-id', '249']),
      { HISTORY_TOKEN: 'secret-token' },
    );
    expect(malformed.exitCode).not.toBeUndefined();
    expect(parseJson(malformed.output)).toMatchObject({
      code: 'CONTENT_HISTORY_MALFORMED_DIFF',
    });
  });
});
