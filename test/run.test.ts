import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

interface RunWorld {
  swagger: Record<string, unknown>;
  run: Record<string, unknown>;
  jobs: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  list?: Array<Record<string, unknown>>;
}

const DONE_STATUSES = new Set(['success', 'failure', 'cancelled', 'skipped']);

const tempDirs: string[] = [];

afterEach(async () => {
  await closeServers();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forgejo-axi-run-'));
  tempDirs.push(dir);
  return dir;
}

/** A non-UTF-8 byte proves the zip arrived as bytes rather than decoded text. */
function artifactZip(id: number): Buffer {
  return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, id]);
}

/** Carries a secret so redaction is provable when a token is configured. */
function jobLog(id: number): string {
  return `job ${id} log token=super-secret-token`;
}

async function runServer(world: RunWorld): Promise<FakeServer> {
  const state: RunWorld = { ...world };
  const server = await startServer((_request, response, recorded) => {
    const url = new URL(recorded.url, 'http://fake');
    if (url.pathname === '/swagger.v1.json')
      return json(response, 200, state.swagger);
    const path = url.pathname.replace('/api/v1/repos/acme/widgets', '');
    const page = Number(url.searchParams.get('page') ?? '1');
    const id = Number(state.run['id']);

    if (path === '/actions/runs' && recorded.method === 'GET') {
      const status = url.searchParams.get('status');
      const ref = url.searchParams.get('ref');
      const rows = (state.list ?? [state.run]).filter(
        (row) =>
          (status === null || row['status'] === status) &&
          (ref === null || ref === `refs/heads/${String(row['prettyref'])}`),
      );
      return json(response, 200, {
        workflow_runs: page === 1 ? rows : [],
        total_count: rows.length,
      });
    }
    if (path === `/actions/runs/${id}/jobs`) {
      return json(response, 200, state.jobs);
    }
    if (path === `/actions/runs/${id}/cancel` && recorded.method === 'POST') {
      if (!DONE_STATUSES.has(String(state.run['status']))) {
        state.run = {
          ...state.run,
          status: 'cancelled',
          stopped: '2026-01-03T00:06:00Z',
        };
      }
      response.statusCode = 204;
      response.end();
      return;
    }
    if (path === `/actions/runs/${id}/artifacts`) {
      const name = url.searchParams.get('name');
      const rows = state.artifacts.filter(
        (artifact) => name === null || artifact['name'] === name,
      );
      return json(response, 200, page === 1 ? rows : []);
    }
    if (path === `/actions/runs/${id}`) return json(response, 200, state.run);

    const log = /^\/actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (log?.[1]) {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain');
      response.end(jobLog(Number(log[1])));
      return;
    }
    const zip = /^\/actions\/artifacts\/(\d+)\/zip$/.exec(path);
    if (zip?.[1]) {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/octet-stream');
      response.end(artifactZip(Number(zip[1])));
      return;
    }
    return json(response, 404, { message: 'not found' });
  });
  servers.push(server);
  return server;
}

/** Answers the capability probe only; every Actions request is a test failure. */
async function unsupportedServer(): Promise<FakeServer> {
  const fixture = await load<{
    swagger: { paths: Record<string, unknown> };
  }>(15);
  // Real 15.0.5 advertises the runs routes, so a host without any Actions API
  // has to be constructed by stripping them.
  const paths = Object.fromEntries(
    Object.entries(fixture.swagger.paths).filter(
      ([path]) => !path.includes('/actions/'),
    ),
  );
  const swagger = { ...fixture.swagger, paths };
  const server = await startServer((_request, response, recorded) => {
    if (recorded.url === '/swagger.v1.json')
      return json(response, 200, swagger);
    return json(response, 500, {
      message: 'the run family must not reach an unsupported host',
    });
  });
  servers.push(server);
  return server;
}

describe('run command family', () => {
  it('reports every subcommand unsupported when the host lacks the runs route', async () => {
    const server = await unsupportedServer();
    const invocations: string[][] = [
      ['run', 'list'],
      ['run', 'view', '9'],
      ['run', 'cancel', '9'],
      ['run', 'download', '9', '--dir', join(tmpdir(), 'forgejo-axi-unused')],
    ];

    for (const argv of invocations) {
      const result = await invoke([...argv, ...connection(server)]);
      expect(result.exitCode, argv.join(' ')).toBeUndefined();
      expect(parseJson(result.output), argv.join(' ')).toMatchObject({
        supported: false,
        capability: 'runs',
      });
    }

    expect(
      server.requests.map((request) => request.url),
      'only the capability probe should have been requested',
    ).toEqual(invocations.map(() => '/swagger.v1.json'));
  });

  it('follows the per-route capabilities Forgejo 15 really advertises', async () => {
    // Real 15.0.5 lists /actions/runs and /actions/runs/{run_id} but not the
    // jobs, cancel, or artifacts subroutes — proven by the live lane.
    const fifteen = await load<RunWorld>(15);
    const world = { ...(await load<RunWorld>(16)), swagger: fifteen.swagger };
    const server = await runServer(world);

    const listed = await invoke(['run', 'list', ...connection(server)]);
    expect(listed.exitCode).toBeUndefined();
    expect(parseJson<{ runs: unknown[] }>(listed.output).runs).toHaveLength(1);

    const viewed = await invoke(['run', 'view', ...connection(server), '9']);
    expect(viewed.exitCode).toBeUndefined();
    expect(parseJson(viewed.output)).toMatchObject({
      run: { id: 9 },
      jobs: [],
      next: ['Run jobs are unsupported on this Forgejo host'],
    });

    const cancelled = await invoke([
      'run',
      'cancel',
      ...connection(server),
      '9',
    ]);
    expect(cancelled.exitCode).toBeUndefined();
    expect(parseJson(cancelled.output)).toMatchObject({
      supported: false,
      capability: 'run_cancel',
    });

    const downloaded = await invoke([
      'run',
      'download',
      ...connection(server),
      '9',
      '--dir',
      join(tmpdir(), 'forgejo-axi-unused'),
    ]);
    expect(downloaded.exitCode).toBeUndefined();
    expect(parseJson(downloaded.output)).toMatchObject({
      supported: false,
      capability: 'run_artifacts',
    });

    const touched = server.requests.map((request) => request.url);
    expect(touched.some((url) => url.includes('/jobs'))).toBe(false);
    expect(touched.some((url) => url.includes('/cancel'))).toBe(false);
    expect(touched.some((url) => url.includes('/artifacts'))).toBe(false);
  });

  it('lists Forgejo 16 runs in TOON and JSON and honours --fields', async () => {
    const server = await runServer(await load<RunWorld>(16));

    const toon = await invoke(['run', 'list', ...connection(server, false)]);
    expect(toon.exitCode).toBeUndefined();
    expect(toon.output).toContain('CI');
    expect(toon.output).toContain('fetched: 1');

    const listed = parseJson<{
      runs: Array<Record<string, unknown>>;
      page_info: Record<string, unknown>;
    }>((await invoke(['run', 'list', ...connection(server)])).output);
    expect(listed.runs).toEqual([
      { id: 9, title: 'CI', status: 'success', branch: 'main' },
    ]);
    expect(listed.page_info).toMatchObject({ complete: true, fetched: 1 });

    const selected = parseJson<{ runs: Array<Record<string, unknown>> }>(
      (
        await invoke([
          'run',
          'list',
          ...connection(server),
          '--fields',
          'id,run_number,head_sha',
        ])
      ).output,
    );
    expect(selected.runs).toEqual([
      { id: 9, run_number: 3, head_sha: 'def456' },
    ]);
  });

  it('sends the status and branch filters Forgejo understands', async () => {
    const server = await runServer(await load<RunWorld>(16));
    const result = await invoke([
      'run',
      'list',
      ...connection(server),
      '--status',
      'success',
      '--branch',
      'main',
    ]);
    expect(result.exitCode).toBeUndefined();
    const query = new URL(
      server.requests.find((request) => request.url.includes('/actions/runs?'))!
        .url,
      'http://fake',
    ).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      status: 'success',
      ref: 'refs/heads/main',
    });
  });

  it('reports an empty run list without an error', async () => {
    const server = await runServer({ ...(await load<RunWorld>(16)), list: [] });
    const result = await invoke(['run', 'list', ...connection(server)]);
    expect(result.exitCode).toBeUndefined();
    expect(parseJson(result.output)).toMatchObject({
      runs: [],
      page_info: { fetched: 0, complete: true },
    });
  });

  it('views a run with its jobs and canonical URLs', async () => {
    const server = await runServer(await load<RunWorld>(16));
    const viewed = parseJson<{
      run: Record<string, unknown>;
      jobs: Array<Record<string, unknown>>;
    }>((await invoke(['run', 'view', ...connection(server), '9'])).output);

    expect(viewed.run).toEqual({
      id: 9,
      url: `${server.baseUrl}/acme/widgets/actions/runs/9`,
      api_url: `${server.baseUrl}/api/v1/repos/acme/widgets/actions/runs/9`,
      title: 'CI',
      event: 'push',
      branch: 'main',
      head_sha: 'def456',
      run_number: 3,
      status: 'success',
      started_at: '2026-01-03T00:00:00Z',
      completed_at: '2026-01-03T00:05:00Z',
    });
    expect(viewed.jobs).toEqual([
      { id: 21, run_id: 9, name: 'build', status: 'success' },
      { id: 22, run_id: 9, name: 'test', status: 'failure' },
    ]);
  });

  it('folds every job log with --log and only failed logs with --log-failed', async () => {
    const server = await runServer(await load<RunWorld>(16));

    const all = parseJson<{ jobs: Array<{ log?: string }> }>(
      (await invoke(['run', 'view', ...connection(server), '9', '--log']))
        .output,
    );
    expect(all.jobs.map((job) => job.log)).toEqual([jobLog(21), jobLog(22)]);

    const failed = parseJson<{ jobs: Array<Record<string, unknown>> }>(
      (
        await invoke([
          'run',
          'view',
          ...connection(server),
          '9',
          '--log-failed',
        ])
      ).output,
    );
    expect(failed.jobs[0]).not.toHaveProperty('log');
    expect(failed.jobs[1]).toMatchObject({ id: 22, log: jobLog(22) });
  });

  it('redacts a configured token from decoded job logs', async () => {
    const server = await runServer(await load<RunWorld>(16));
    const result = await invoke(
      [
        'run',
        'view',
        ...connection(server),
        '9',
        '--log',
        '--token-env',
        'TOKEN',
      ],
      { TOKEN: 'super-secret-token' },
    );
    expect(result.exitCode).toBeUndefined();
    const viewed = parseJson<{ jobs: Array<{ log?: string }> }>(result.output);
    expect(viewed.jobs.map((job) => job.log)).toEqual([
      'job 21 log token=[REDACTED]',
      'job 22 log token=[REDACTED]',
    ]);
    expect(result.output).not.toContain('super-secret-token');
  });

  it('surfaces the server message when a raw log fetch fails', async () => {
    const world = await load<RunWorld>(16);
    const server = await startServer((_request, response, recorded) => {
      const url = new URL(recorded.url, 'http://fake');
      if (url.pathname === '/swagger.v1.json')
        return json(response, 200, world.swagger);
      const path = url.pathname.replace('/api/v1/repos/acme/widgets', '');
      if (path === '/actions/runs/9') return json(response, 200, world.run);
      if (path === '/actions/runs/9/jobs')
        return json(response, 200, world.jobs);
      return json(response, 404, { message: 'job log vanished' });
    });
    servers.push(server);

    const result = await invoke([
      'run',
      'view',
      ...connection(server),
      '9',
      '--log',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('job log vanished');
  });

  it('omits requested job logs instead of failing when the host lacks the route', async () => {
    const world = await load<RunWorld>(16);
    const paths = { ...(world.swagger['paths'] as Record<string, unknown>) };
    delete paths['/repos/{owner}/{repo}/actions/jobs/{job_id}/logs'];
    const server = await runServer({
      ...world,
      swagger: { ...world.swagger, paths },
    });

    const result = await invoke([
      'run',
      'view',
      ...connection(server),
      '9',
      '--log',
    ]);
    expect(result.exitCode).toBeUndefined();
    const viewed = parseJson<{
      jobs: Array<Record<string, unknown>>;
      next: string[];
    }>(result.output);
    expect(viewed.jobs.every((job) => !('log' in job))).toBe(true);
    expect(viewed.next).toEqual([
      'Job logs are unsupported on this Forgejo host',
    ]);
    expect(
      server.requests.some((request) => request.url.includes('/logs')),
    ).toBe(false);
  });

  it('cancels a running run and reports the repeat as a no-op', async () => {
    const world = await load<RunWorld>(16);
    const server = await runServer({
      ...world,
      run: { ...world.run, status: 'running', stopped: '0001-01-01T00:00:00Z' },
    });
    const args = ['run', 'cancel', ...connection(server), '9'];

    expect(parseJson((await invoke(args)).output)).toMatchObject({
      cancelled: true,
      run: { id: 9, status: 'cancelled' },
    });
    expect(parseJson((await invoke(args)).output)).toMatchObject({
      cancelled: false,
      run: { id: 9, status: 'cancelled' },
    });
  });

  it('downloads artifacts into a created directory and never overwrites one', async () => {
    const server = await runServer(await load<RunWorld>(16));
    const dir = join(await tempDir(), 'nested', 'artifacts');
    const args = ['run', 'download', ...connection(server), '9', '--dir', dir];

    const first = parseJson<{
      run_id: number;
      dir: string;
      downloaded: Array<Record<string, unknown>>;
    }>((await invoke(args)).output);
    expect(first).toMatchObject({ run_id: 9, dir });
    expect(first.downloaded).toEqual([
      {
        name: 'coverage',
        size_in_bytes: 1024,
        path: join(dir, 'coverage.zip'),
      },
      { name: 'bundle', size_in_bytes: 2048, path: join(dir, 'bundle.zip') },
    ]);
    expect(await readFile(join(dir, 'coverage.zip'))).toEqual(artifactZip(31));
    expect(await readFile(join(dir, 'bundle.zip'))).toEqual(artifactZip(32));

    const repeat = await invoke(args);
    expect(repeat.exitCode).toBe(1);
    expect(parseJson(repeat.output)).toMatchObject({
      code: 'ARTIFACT_EXISTS',
      details: { path: join(dir, 'coverage.zip') },
    });
    expect(await readFile(join(dir, 'coverage.zip'))).toEqual(artifactZip(31));
  });

  it('narrows the download to a single artifact name', async () => {
    const server = await runServer(await load<RunWorld>(16));
    const dir = await tempDir();

    const result = parseJson<{ downloaded: Array<Record<string, unknown>> }>(
      (
        await invoke([
          'run',
          'download',
          ...connection(server),
          '9',
          '--dir',
          dir,
          '--name',
          'bundle',
        ])
      ).output,
    );
    expect(result.downloaded).toEqual([
      { name: 'bundle', size_in_bytes: 2048, path: join(dir, 'bundle.zip') },
    ]);
    await expect(readFile(join(dir, 'coverage.zip'))).rejects.toThrow();
  });

  it('rejects invalid invocations with exit code 2 and a usage hint', async () => {
    const cases: Array<[string[], string]> = [
      [['run', 'list'], '--repo is required'],
      [['run', 'view', '--repo', 'acme/widgets'], 'run id is required'],
      [
        ['run', 'view', '--repo', 'acme/widgets', '9', '10'],
        'Unexpected arguments',
      ],
      [['run', 'view', '--repo', 'acme/widgets', 'zero'], 'Run id'],
      [
        ['run', 'view', '--repo', 'acme/widgets', '9', '--log', '--log-failed'],
        '--log and --log-failed cannot be combined',
      ],
      [['run', 'download', '--repo', 'acme/widgets', '9'], '--dir is required'],
      [
        ['run', 'list', '--repo', 'acme/widgets', '--status', 'nope'],
        '--status must be one of',
      ],
      [['run', 'nope', '--repo', 'acme/widgets'], 'Unknown run command'],
    ];
    for (const [argv, expected] of cases) {
      const result = await invoke([...argv, '--json']);
      expect(result.exitCode, argv.join(' ')).toBe(2);
      expect(result.output, argv.join(' ')).toContain(expected);
    }
  });

  it('shows run help without requiring configuration', async () => {
    const family = await invoke(['run', '--help']);
    expect(family.exitCode).toBeUndefined();
    expect(family.output).toContain('forgejo-axi run <command> --help');

    const view = await invoke(['run', 'view', '--help']);
    expect(view.output).toContain('--log-failed');
  });
});
