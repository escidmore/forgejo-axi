import { afterEach, describe, expect, it } from 'vitest';
import { resolveConnection } from '../src/config.js';
import { ForgejoService, parseRepository } from '../src/forgejo.js';
import {
  closeServers,
  invoke,
  json,
  loadFixture,
  parseJson,
  servers,
  startServer,
  type FakeServer,
  type RecordedRequest,
} from './server.js';

interface Fixture {
  version: Record<string, unknown>;
  swagger: { paths: Record<string, unknown> };
  repository: Record<string, unknown>;
}

afterEach(closeServers);

const repo = parseRepository('acme/widgets');

async function serviceFor(server: FakeServer): Promise<ForgejoService> {
  return new ForgejoService(
    await resolveConnection({ baseUrl: server.baseUrl }, {}),
  );
}

interface World {
  /** Who the token authenticates as. */
  login: string;
  /** Repositories the host already serves, keyed by full name. */
  existing: Record<string, Record<string, unknown>>;
  /** Status the create route answers with when the name is free. */
  createStatus?: number;
  /** Message the create route answers with when it refuses. */
  createMessage?: string;
  /** Drop the creation routes from the advertised API. */
  withoutCreateRoutes?: boolean;
  /** A create that succeeds on the host but is answered as a 409. */
  raceOnCreate?: boolean;
  /** Old addresses the host answers with a redirect to the renamed one. */
  renamed?: Record<string, string>;
}

/**
 * A fake host that serves the version and Swagger probes, `GET /user`, the
 * repository read route, and both creation routes. Created repositories are
 * remembered so a later read finds them, which is what the reconcile paths
 * depend on.
 */
async function hostFor(version: 15 | 16, world: World): Promise<FakeServer> {
  const fixture = await loadFixture<Fixture>(version);
  const paths = { ...fixture.swagger.paths };
  if (world.withoutCreateRoutes) {
    delete paths['/user/repos'];
    delete paths['/orgs/{org}/repos'];
  }
  const server = await startServer((_request, response, recorded) => {
    if (recorded.url === '/api/v1/version')
      return json(response, 200, fixture.version);
    if (recorded.url === '/swagger.v1.json')
      return json(response, 200, { ...fixture.swagger, paths });
    if (recorded.url === '/api/v1/user')
      return json(response, 200, { login: world.login });
    const read = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)$/.exec(recorded.url);
    if (read && recorded.method === 'GET') {
      const moved = world.renamed?.[`${read[1]}/${read[2]}`];
      if (moved) {
        response.statusCode = 307;
        response.setHeader('location', `/api/v1/repos/${moved}`);
        response.end();
        return;
      }
      const found = world.existing[`${read[1]}/${read[2]}`];
      return found
        ? json(response, 200, found)
        : json(response, 404, { message: "The target couldn't be found." });
    }
    const create =
      recorded.method === 'POST' &&
      (recorded.url === '/api/v1/user/repos' ||
        /^\/api\/v1\/orgs\/[^/]+\/repos$/.test(recorded.url));
    if (create) {
      if (world.createStatus !== undefined) {
        return json(response, world.createStatus, {
          message: world.createMessage ?? 'refused',
        });
      }
      const body = parseJson<{ name: string; private: boolean }>(recorded.body);
      const owner =
        recorded.url === '/api/v1/user/repos'
          ? world.login
          : recorded.url.split('/')[4];
      const made = {
        ...fixture.repository,
        name: body.name,
        full_name: `${owner}/${body.name}`,
        private: body.private,
        owner: { ...(fixture.repository['owner'] as object), login: owner },
        empty: true,
        ssh_url: `ssh://git@forgejo.example/${owner}/${body.name}.git`,
      };
      world.existing[made.full_name] = made;
      if (world.raceOnCreate)
        return json(response, 409, {
          message: 'The repository already exists.',
        });
      return json(response, 201, made);
    }
    return json(response, 404, { message: 'not found' });
  });
  servers.push(server);
  return server;
}

const posts = (server: FakeServer): RecordedRequest[] =>
  server.requests.filter((request) => request.method === 'POST');

describe('repo create', () => {
  it.each([15, 16] as const)(
    'reports the repo_create capability from the Forgejo %i runtime document',
    async (version) => {
      const server = await hostFor(version, { login: 'robot', existing: {} });
      const service = await serviceFor(server);
      await expect(service.repoCreateSupported()).resolves.toBe(true);
    },
  );

  it('creates under the user route when the owner is the authenticated login', async () => {
    const server = await hostFor(15, { login: 'acme', existing: {} });
    const service = await serviceFor(server);
    const result = await service.createRepo(repo, {
      private: true,
      description: 'Widgets',
      defaultBranch: 'main',
    });
    expect(result).toMatchObject({
      created: true,
      differs: [],
      repository: {
        full_name: 'acme/widgets',
        private: true,
        url: `${server.baseUrl}/acme/widgets`,
        clone_url: `${server.baseUrl}/acme/widgets.git`,
        ssh_url: 'ssh://git@forgejo.example/acme/widgets.git',
      },
    });
    const [post] = posts(server);
    expect(post?.url).toBe('/api/v1/user/repos');
    expect(parseJson(post!.body)).toEqual({
      name: 'widgets',
      private: true,
      description: 'Widgets',
      default_branch: 'main',
    });
  });

  it('matches the owner to the login case-insensitively, as Forgejo does', async () => {
    const server = await hostFor(15, { login: 'Acme', existing: {} });
    const service = await serviceFor(server);
    const result = await service.createRepo(repo, { private: true });
    expect(result).toMatchObject({
      created: true,
      repository: { full_name: 'Acme/widgets', private: true },
    });
    const [post] = posts(server);
    expect(post?.url).toBe('/api/v1/user/repos');
  });

  it('creates under the organization route for any other owner, without guessing from the name', async () => {
    const server = await hostFor(15, { login: 'robot', existing: {} });
    const service = await serviceFor(server);
    const result = await service.createRepo(repo, { private: false });
    expect(result).toMatchObject({
      created: true,
      repository: { full_name: 'acme/widgets', private: false },
    });
    const [post] = posts(server);
    expect(post?.url).toBe('/api/v1/orgs/acme/repos');
    expect(parseJson(post!.body)).toEqual({ name: 'widgets', private: false });
    // The login was resolved from the host, not assumed.
    expect(
      server.requests.some((request) => request.url === '/api/v1/user'),
    ).toBe(true);
  });

  it('creates when the address only redirects to a renamed repository', async () => {
    const fixture = await loadFixture<Fixture>(16);
    const server = await hostFor(16, {
      login: 'robot',
      existing: {
        'acme/widgets-old': {
          ...fixture.repository,
          name: 'widgets-old',
          full_name: 'acme/widgets-old',
        },
      },
      renamed: { 'acme/widgets': 'acme/widgets-old' },
    });
    const service = await serviceFor(server);
    const result = await service.createRepo(repo, { private: true });
    expect(result).toMatchObject({
      created: true,
      differs: [],
      repository: { full_name: 'acme/widgets', private: true },
    });
    expect(
      server.requests.map((request) => `${request.method} ${request.url}`),
    ).toEqual(
      expect.arrayContaining([
        'GET /api/v1/repos/acme/widgets',
        'GET /api/v1/repos/acme/widgets-old',
        'POST /api/v1/orgs/acme/repos',
      ]),
    );
  });

  it('returns an existing repository without mutating it and lists what differs', async () => {
    const fixture = await loadFixture<Fixture>(15);
    const server = await hostFor(15, {
      login: 'robot',
      existing: {
        'acme/widgets': {
          ...fixture.repository,
          private: true,
          default_branch: 'main',
        },
      },
    });
    const service = await serviceFor(server);
    const result = await service.createRepo(repo, {
      private: false,
      defaultBranch: 'trunk',
    });
    expect(result).toMatchObject({
      created: false,
      repository: { full_name: 'acme/widgets', private: true },
      differs: [
        { field: 'private', requested: false, actual: true },
        { field: 'default_branch', requested: 'trunk', actual: 'main' },
      ],
    });
    expect(posts(server)).toHaveLength(0);
  });

  it('is a mutation-free no-op when the existing repository already matches', async () => {
    const fixture = await loadFixture<Fixture>(16);
    const server = await hostFor(16, {
      login: 'robot',
      existing: { 'acme/widgets': { ...fixture.repository, private: true } },
    });
    const service = await serviceFor(server);
    await expect(
      service.createRepo(repo, { private: true, description: 'Widgets' }),
    ).resolves.toMatchObject({ created: false, differs: [] });
    expect(server.requests.every((request) => request.method === 'GET')).toBe(
      true,
    );
  });

  it('lists a requested description the existing repository does not carry', async () => {
    const fixture = await loadFixture<Fixture>(15);
    const server = await hostFor(15, {
      login: 'robot',
      existing: { 'acme/widgets': { ...fixture.repository, private: true } },
    });
    const service = await serviceFor(server);
    await expect(
      service.createRepo(repo, { private: true, description: 'Docs' }),
    ).resolves.toMatchObject({
      created: false,
      differs: [{ field: 'description', requested: 'Docs', actual: 'Widgets' }],
    });
    expect(posts(server)).toHaveLength(0);
  });

  it('reconciles onto the repository behind a 409 instead of failing', async () => {
    const server = await hostFor(15, {
      login: 'robot',
      existing: {},
      raceOnCreate: true,
    });
    const service = await serviceFor(server);
    await expect(
      service.createRepo(repo, { private: true }),
    ).resolves.toMatchObject({
      created: false,
      differs: [],
      repository: { full_name: 'acme/widgets', private: true },
    });
  });

  it('keeps a 409 that has no repository behind it as the error it is', async () => {
    const server = await hostFor(15, {
      login: 'robot',
      existing: {},
      createStatus: 409,
      createMessage: 'The repository already exists.',
    });
    const service = await serviceFor(server);
    await expect(
      service.createRepo(repo, { private: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('names the route and the missing permission on 403', async () => {
    const server = await hostFor(15, {
      login: 'robot',
      existing: {},
      createStatus: 403,
      createMessage: 'user is not allowed to create repositories',
    });
    const service = await serviceFor(server);
    await expect(
      service.createRepo(repo, { private: true }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('acme/widgets'),
      details: { status: 403, route: 'orgs/acme/repos' },
      suggestions: expect.arrayContaining([
        expect.stringContaining('forgejo-axi status'),
      ]),
    });
  });

  it('surfaces a 422 through the validation-failed code', async () => {
    const server = await hostFor(15, {
      login: 'robot',
      existing: {},
      createStatus: 422,
      createMessage: 'name is reserved',
    });
    const service = await serviceFor(server);
    await expect(
      service.createRepo(repo, { private: true }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('name is reserved'),
    });
  });
});

describe('repo create through the CLI', () => {
  const connection = (server: FakeServer): string[] => [
    '--repo',
    'acme/widgets',
    '--base-url',
    server.baseUrl,
    '--token-env',
    'TOKEN',
  ];

  it('refuses when neither or both visibility flags are given, before any request', async () => {
    const server = await hostFor(15, { login: 'robot', existing: {} });
    for (const flags of [[], ['--private', '--public']]) {
      const result = await invoke(
        ['repo', 'create', ...connection(server), ...flags, '--json'],
        { TOKEN: 'fixture-token-7f3a' },
      );
      expect(result.exitCode).toBe(2);
      expect(parseJson(result.output)).toMatchObject({
        code: 'VALIDATION_ERROR',
        error: 'Exactly one of --private or --public is required',
      });
    }
    expect(server.requests).toHaveLength(0);
  });

  it('refuses an empty default branch and unknown flags by name before any request', async () => {
    const server = await hostFor(15, { login: 'robot', existing: {} });
    const bad = await invoke(
      [
        'repo',
        'create',
        ...connection(server),
        '--private',
        '--default-branch',
        '',
      ],
      { TOKEN: 'fixture-token-7f3a' },
    );
    expect(bad.exitCode).toBe(2);
    expect(bad.output).toContain('--default-branch may not be empty');
    const unknown = await invoke(
      ['repo', 'create', ...connection(server), '--private', '--visibility'],
      { TOKEN: 'fixture-token-7f3a' },
    );
    expect(unknown.exitCode).toBe(2);
    expect(unknown.output).toContain('Unknown flag --visibility');
    expect(server.requests).toHaveLength(0);
  });

  it('emits the documented shape in JSON and TOON', async () => {
    const server = await hostFor(16, { login: 'acme', existing: {} });
    const asJson = await invoke(
      ['repo', 'create', ...connection(server), '--private', '--json'],
      { TOKEN: 'fixture-token-7f3a' },
    );
    expect(asJson.exitCode).toBeUndefined();
    const output = parseJson<{
      created: boolean;
      differs: unknown[];
      repository: Record<string, unknown>;
    }>(asJson.output);
    expect(output.created).toBe(true);
    expect(output.differs).toEqual([]);
    expect(Object.keys(output.repository)).toEqual([
      'full_name',
      'url',
      'api_url',
      'clone_url',
      'ssh_url',
      'description',
      'private',
      'archived',
      'empty',
      'default_branch',
      'has_actions',
      'has_pull_requests',
      'open_pull_requests',
    ]);

    const asToon = await invoke(
      ['repo', 'create', ...connection(server), '--private'],
      { TOKEN: 'fixture-token-7f3a' },
    );
    expect(asToon.exitCode).toBeUndefined();
    expect(asToon.output).toContain('created: false');
    expect(asToon.output).toContain('differs: []');
    expect(asToon.output).toContain('full_name: acme/widgets');
  });

  it('reports unsupported without a request when the host lacks a creation route', async () => {
    const server = await hostFor(15, {
      login: 'robot',
      existing: {},
      withoutCreateRoutes: true,
    });
    const result = await invoke(
      ['repo', 'create', ...connection(server), '--private', '--json'],
      { TOKEN: 'fixture-token-7f3a' },
    );
    expect(result.exitCode).toBeUndefined();
    expect(parseJson(result.output)).toMatchObject({
      supported: false,
      capability: 'repo_create',
    });
    expect(posts(server)).toHaveLength(0);
  });

  it('serves family and per-command help without configuration', async () => {
    const family = await invoke(['repo', '--help']);
    expect(family.exitCode).toBeUndefined();
    expect(family.output).toContain('create  Create a repository');
    const create = await invoke(['repo', 'create', '--help']);
    expect(create.exitCode).toBeUndefined();
    expect(create.output).toContain('(--private|--public)');
    const view = await invoke(['repo', 'view', '--help']);
    expect(view.output).toContain('repo view --repo OWNER/REPO');
  });

  it('adds clone_url and ssh_url to repo view', async () => {
    const fixture = await loadFixture<Fixture>(15);
    const server = await hostFor(15, {
      login: 'robot',
      existing: { 'acme/widgets': fixture.repository },
    });
    const result = await invoke(
      ['repo', 'view', ...connection(server), '--json'],
      { TOKEN: 'fixture-token-7f3a' },
    );
    expect(result.exitCode).toBeUndefined();
    expect(parseJson(result.output)).toMatchObject({
      repository: {
        full_name: 'acme/widgets',
        clone_url: `${server.baseUrl}/acme/widgets.git`,
        ssh_url: 'ssh://git@forgejo.example/acme/widgets.git',
      },
    });
  });
});
