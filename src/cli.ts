import { encode } from '@toon-format/toon';
import {
  boolFlag,
  parseArgs,
  rejectPositionals,
  requireFlag,
  requireOnePositional,
  stringFlag,
  type FlagSpec,
  type ParsedArgs,
} from './args.js';
import { resolveConnection, type ConnectionInput } from './config.js';
import { asForgejoError, usageError } from './errors.js';
import {
  ForgejoService,
  pageInfo,
  parsePullNumber,
  parseRepository,
  type PullRequestIdentity,
  type RepositoryRef,
} from './forgejo.js';

export interface MainOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
}

const VERSION = '0.1.0';
const DESCRIPTION = 'Inspect and manage Forgejo pull request lifecycles';
const CONNECTION_FLAGS: FlagSpec = {
  '--base-url': 'value',
  '--token-env': 'value',
  '--timeout-ms': 'value',
  '--ca-file': 'value',
  '--json': 'boolean',
  '--help': 'boolean',
};

const TOP_HELP = `forgejo-axi — ${DESCRIPTION}

Usage:
  forgejo-axi status [connection flags]
  forgejo-axi repo view --repo OWNER/REPO [connection flags]
  forgejo-axi api METHOD PATH [--data JSON] [--paginate [--limit N|--full]] [connection flags]
  forgejo-axi pr <find|list|view|create|update|checks|mergeability|merge|merged> ...

Connection flags:
  --base-url URL     Forgejo root URL; defaults to FORGEJO_BASE_URL
  --token-env NAME   Read the token from this environment variable
  --timeout-ms N     Request timeout; default 15000
  --ca-file PATH     Replacement CA trust bundle file
  --json             Emit JSON instead of TOON

Examples:
  forgejo-axi status --base-url https://forgejo.example
  forgejo-axi pr checks --repo owner/repo 42
  forgejo-axi api GET repos/owner/repo
`;

const PR_HELP = `forgejo-axi pr — pull request lifecycle commands

Commands:
  find          Find a pull request by head branch
  list          List pull requests
  view          View canonical pull request identity
  create        Idempotently create or reconcile an open pull request
  update        Idempotently update a pull request
  checks        Normalize commit statuses and required contexts
  mergeability  Evaluate Forgejo mergeability and required checks
  merge         Merge only the expected head and return merged proof
  merged        Return merged-state proof

Run \`forgejo-axi pr <command> --help\` for flags and examples.
`;

const HELP: Record<string, string> = {
  status: `forgejo-axi status — probe host, authentication, version, and capabilities\n\nUsage:\n  forgejo-axi status [connection flags]\n\nExample:\n  forgejo-axi status --base-url https://forgejo.example\n`,
  'repo view': `forgejo-axi repo view — show repository identity and lifecycle features\n\nUsage:\n  forgejo-axi repo view --repo OWNER/REPO [connection flags]\n\nExample:\n  forgejo-axi repo view --repo owner/repo\n`,
  api: `forgejo-axi api — call a Forgejo API v1 path\n\nUsage:\n  forgejo-axi api METHOD PATH [--data JSON] [--paginate [--limit N|--full]] [connection flags]\n\nFlags:\n  --data JSON    JSON request body\n  --paginate     Fetch every array page (GET only)\n  --limit N      Display at most N fetched rows in TOON mode\n  --full         Display every fetched row in TOON mode\n\nExamples:\n  forgejo-axi api GET repos/owner/repo\n  forgejo-axi api GET repos/owner/repo/pulls --paginate --full\n  forgejo-axi api PATCH repos/owner/repo/pulls/4 --data '{"title":"New title"}'\n`,
  'pr find': `forgejo-axi pr find — find by head branch\n\nUsage:\n  forgejo-axi pr find --repo OWNER/REPO --head BRANCH [--base BRANCH] [--state open|closed|all] [connection flags]\n\nExample:\n  forgejo-axi pr find --repo owner/repo --head feature --base main\n`,
  'pr list': `forgejo-axi pr list — list pull requests\n\nUsage:\n  forgejo-axi pr list --repo OWNER/REPO [--state open|closed|all] [--limit N|--full] [--fields LIST|all] [connection flags]\n\nFlags:\n  --fields LIST  Comma-separated identity fields; defaults to number,title,state,head\n\nExamples:\n  forgejo-axi pr list --repo owner/repo\n  forgejo-axi pr list --repo owner/repo --state all --full --fields all\n`,
  'pr view': `forgejo-axi pr view — show canonical pull request identity and body\n\nUsage:\n  forgejo-axi pr view --repo OWNER/REPO NUMBER [--full] [connection flags]\n\nFlags:\n  --full  Display the complete pull request body instead of its preview\n\nExample:\n  forgejo-axi pr view --repo owner/repo 42 --full\n`,
  'pr create': `forgejo-axi pr create — idempotently create or reconcile an open pull request\n\nUsage:\n  forgejo-axi pr create --repo OWNER/REPO --title TITLE --head BRANCH --base BRANCH [--body BODY] [--draft] [connection flags]\n\nExample:\n  forgejo-axi pr create --repo owner/repo --title "Fix race" --head fix/race --base main\n`,
  'pr update': `forgejo-axi pr update — idempotently update a pull request\n\nUsage:\n  forgejo-axi pr update --repo OWNER/REPO NUMBER [--title TITLE] [--body BODY] [--base BRANCH] [--state open|closed] [connection flags]\n\nExample:\n  forgejo-axi pr update --repo owner/repo 42 --state closed\n`,
  'pr checks': `forgejo-axi pr checks — normalize statuses and required contexts\n\nUsage:\n  forgejo-axi pr checks --repo OWNER/REPO NUMBER [connection flags]\n\nExample:\n  forgejo-axi pr checks --repo owner/repo 42 --json\n`,
  'pr mergeability': `forgejo-axi pr mergeability — evaluate mergeability and required checks\n\nUsage:\n  forgejo-axi pr mergeability --repo OWNER/REPO NUMBER [connection flags]\n\nExample:\n  forgejo-axi pr mergeability --repo owner/repo 42\n`,
  'pr merge': `forgejo-axi pr merge — expected-head merge with merged-state proof\n\nUsage:\n  forgejo-axi pr merge --repo OWNER/REPO NUMBER --expected-head SHA [--method merge|squash|rebase] [connection flags]\n\nExample:\n  forgejo-axi pr merge --repo owner/repo 42 --expected-head abc123 --method squash\n`,
  'pr merged': `forgejo-axi pr merged — return merged-state proof\n\nUsage:\n  forgejo-axi pr merged --repo OWNER/REPO NUMBER [connection flags]\n\nExample:\n  forgejo-axi pr merged --repo owner/repo 42\n`,
};

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const json = argv.includes('--json');
  try {
    if (argv.length === 1 && argv[0] === '--help') {
      stdout.write(TOP_HELP);
      return;
    }
    if (
      argv.length === 1 &&
      ['--version', '-v', '-V'].includes(argv[0] ?? '')
    ) {
      stdout.write(`${VERSION}\n`);
      return;
    }
    const output = await dispatch(argv, env);
    stdout.write(`${render(output, json)}\n`);
  } catch (error) {
    if (error instanceof HelpSignal) {
      stdout.write(error.output);
      return;
    }
    const normalized = asForgejoError(error);
    const output: Record<string, unknown> = {
      error: normalized.message,
      code: normalized.code,
      details: normalized.details,
      help: normalized.suggestions,
    };
    stdout.write(`${render(output, json)}\n`);
    process.exitCode = normalized.usage ? 2 : 1;
  }
}

async function dispatch(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  if (argv.length === 0) {
    const home = {
      bin: collapsedExecutable(),
      description: DESCRIPTION,
    };
    if (!env['FORGEJO_BASE_URL']) {
      return {
        ...home,
        configured: false,
        next: [
          'Set FORGEJO_BASE_URL and a host-scoped FORGEJO_TOKEN_<HOST_KEY>',
          'forgejo-axi status --base-url https://forgejo.example',
          'forgejo-axi --help',
        ],
      };
    }
    const service = new ForgejoService(await resolveConnection({}, env));
    return {
      ...home,
      configured: true,
      ...(await service.status()),
      next: [
        'forgejo-axi repo view --repo OWNER/REPO',
        'forgejo-axi pr list --repo OWNER/REPO',
      ],
    };
  }
  const command = argv[0];
  const rest = argv.slice(1);
  if (!command || command.startsWith('-')) {
    throw usageError('Flags must come after a command', [
      'Run `forgejo-axi --help`',
    ]);
  }
  if (command === 'status') return runStatus(rest, env);
  if (command === 'repo') return runRepo(rest, env);
  if (command === 'api') return runApi(rest, env);
  if (command === 'pr') return runPull(rest, env);
  throw usageError(`Unknown command: ${command}`, ['Run `forgejo-axi --help`']);
}

async function runStatus(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  if (args.includes('--help')) return helpResult('status');
  const parsed = parseArgs(args, CONNECTION_FLAGS, 'status');
  rejectPositionals(parsed);
  return serviceFor(parsed, env).then((service) => service.status());
}

async function runRepo(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const subcommand = args[0];
  if (subcommand !== 'view') {
    if (subcommand === '--help') return helpResult('repo view');
    throw usageError(`Unknown repo command: ${subcommand ?? '(missing)'}`, [
      'Run `forgejo-axi repo view --help`',
    ]);
  }
  const rest = args.slice(1);
  if (rest.includes('--help')) return helpResult('repo view');
  const parsed = parseArgs(rest, withFlags({ '--repo': 'value' }), 'repo view');
  rejectPositionals(parsed);
  const repo = resolveRepo(parsed, env);
  const service = await serviceFor(parsed, env);
  return { repository: await service.repoView(repo) };
}

async function runApi(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  if (args.includes('--help')) return helpResult('api');
  const parsed = parseArgs(
    args,
    withFlags({
      '--data': 'value',
      '--paginate': 'boolean',
      '--limit': 'value',
      '--full': 'boolean',
    }),
    'api',
  );
  if (parsed.positionals.length !== 2) {
    throw usageError('api requires METHOD and PATH');
  }
  const [rawMethod, path] = parsed.positionals;
  if (!rawMethod || !path) throw usageError('api requires METHOD and PATH');
  const method = rawMethod.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
    throw usageError(`Unsupported API method: ${rawMethod}`);
  }
  const paginate = boolFlag(parsed, '--paginate');
  const full = boolFlag(parsed, '--full');
  const json = boolFlag(parsed, '--json');
  const requestedLimit = stringFlag(parsed, '--limit');
  const rawData = stringFlag(parsed, '--data');
  if (paginate && method !== 'GET') throw usageError('--paginate requires GET');
  if (paginate && rawData !== undefined)
    throw usageError('--paginate cannot be combined with --data');
  if (!paginate && (full || requestedLimit !== undefined)) {
    throw usageError('--limit and --full require --paginate');
  }
  rejectDisplayFlagConflicts(full, requestedLimit, json);
  const body = rawData === undefined ? undefined : parseJson(rawData);
  const service = await serviceFor(parsed, env);
  if (paginate) {
    const page = await service.rawPaginate(path);
    const limit = displayLimit(requestedLimit);
    const displayed = full || json ? page.items : page.items.slice(0, limit);
    return listOutput('data', displayed, page, full || json);
  }
  const response = await service.rawApi(method, path, body);
  return { status: response.status, data: response.data };
}

async function runPull(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const subcommand = args[0];
  if (!subcommand || subcommand === '--help') return helpResult('pr');
  const key = `pr ${subcommand}`;
  if (!Object.hasOwn(HELP, key)) {
    throw usageError(`Unknown pr command: ${subcommand}`, [
      'Run `forgejo-axi pr --help`',
    ]);
  }
  const rest = args.slice(1);
  if (rest.includes('--help')) return helpResult(key);
  switch (subcommand) {
    case 'find':
      return pullFind(rest, env);
    case 'list':
      return pullList(rest, env);
    case 'view':
    case 'checks':
    case 'mergeability':
    case 'merged':
      return pullRead(subcommand, rest, env);
    case 'create':
      return pullCreate(rest, env);
    case 'update':
      return pullUpdate(rest, env);
    case 'merge':
      return pullMerge(rest, env);
    default:
      throw usageError(`Unknown pr command: ${subcommand}`);
  }
}

async function pullFind(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--head': 'value',
      '--base': 'value',
      '--state': 'value',
    }),
    'pr find',
  );
  rejectPositionals(parsed);
  const repo = resolveRepo(parsed, env);
  const head = requireFlag(parsed, '--head');
  const base = stringFlag(parsed, '--base');
  const state = pullState(stringFlag(parsed, '--state') ?? 'open', true);
  const service = await serviceFor(parsed, env);
  const result = await service.findPull(repo, head, base, state);
  return {
    found: result.pull_request !== null,
    pull_request: result.pull_request,
    search_info: result.search_info,
  };
}

async function pullList(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--state': 'value',
      '--limit': 'value',
      '--full': 'boolean',
      '--fields': 'value',
    }),
    'pr list',
  );
  rejectPositionals(parsed);
  const full = boolFlag(parsed, '--full');
  const json = boolFlag(parsed, '--json');
  const requestedLimit = stringFlag(parsed, '--limit');
  rejectDisplayFlagConflicts(full, requestedLimit, json);
  const repo = resolveRepo(parsed, env);
  const state = pullState(stringFlag(parsed, '--state') ?? 'open', true);
  const service = await serviceFor(parsed, env);
  const page = await service.listPulls(repo, state);
  const limit = displayLimit(requestedLimit);
  const showAll = full || json;
  const fields = pullListFields(stringFlag(parsed, '--fields'));
  const displayed = (showAll ? page.items : page.items.slice(0, limit)).map(
    (pull) => selectPullFields(pull, fields),
  );
  return listOutput('pull_requests', displayed, page, showAll);
}

async function pullRead(
  command: 'view' | 'checks' | 'mergeability' | 'merged',
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      ...(command === 'view' ? { '--full': 'boolean' as const } : {}),
    }),
    `pr ${command}`,
  );
  const number = parsePullNumber(
    requireOnePositional(parsed, 'pull request number'),
  );
  const repo = resolveRepo(parsed, env);
  const service = await serviceFor(parsed, env);
  if (command === 'view') {
    return {
      pull_request: await service.viewPull(
        repo,
        number,
        boolFlag(parsed, '--full'),
      ),
    };
  }
  if (command === 'checks')
    return { checks: await service.checks(repo, number) };
  if (command === 'mergeability')
    return { mergeability: await service.mergeability(repo, number) };
  return { proof: await service.merged(repo, number) };
}

async function pullCreate(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--title': 'value',
      '--head': 'value',
      '--base': 'value',
      '--body': 'value',
      '--draft': 'boolean',
    }),
    'pr create',
  );
  rejectPositionals(parsed);
  const repo = resolveRepo(parsed, env);
  const title = requireFlag(parsed, '--title');
  const head = requireFlag(parsed, '--head');
  const base = requireFlag(parsed, '--base');
  const body = stringFlag(parsed, '--body');
  const service = await serviceFor(parsed, env);
  return service.createPull(repo, {
    title,
    head,
    base,
    ...(body === undefined ? {} : { body }),
    draft: boolFlag(parsed, '--draft'),
  });
}

async function pullUpdate(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--title': 'value',
      '--body': 'value',
      '--base': 'value',
      '--state': 'value',
    }),
    'pr update',
  );
  const number = parsePullNumber(
    requireOnePositional(parsed, 'pull request number'),
  );
  const repo = resolveRepo(parsed, env);
  const state = stringFlag(parsed, '--state');
  if (state !== undefined) pullState(state, false);
  const service = await serviceFor(parsed, env);
  const title = stringFlag(parsed, '--title');
  const body = stringFlag(parsed, '--body');
  const base = stringFlag(parsed, '--base');
  return service.updatePull(repo, number, {
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body }),
    ...(base === undefined ? {} : { base }),
    ...(state === undefined ? {} : { state }),
  });
}

async function pullMerge(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--expected-head': 'value',
      '--method': 'value',
    }),
    'pr merge',
  );
  const number = parsePullNumber(
    requireOnePositional(parsed, 'pull request number'),
  );
  const repo = resolveRepo(parsed, env);
  const expectedHead = requireFlag(parsed, '--expected-head');
  const rawMethod = stringFlag(parsed, '--method') ?? 'merge';
  if (!['merge', 'squash', 'rebase'].includes(rawMethod)) {
    throw usageError('--method must be merge, squash, or rebase');
  }
  const method = rawMethod as 'merge' | 'squash' | 'rebase';
  const service = await serviceFor(parsed, env);
  return { proof: await service.merge(repo, number, expectedHead, method) };
}

async function serviceFor(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
): Promise<ForgejoService> {
  const input: ConnectionInput = {};
  const baseUrl = stringFlag(parsed, '--base-url');
  const tokenEnv = stringFlag(parsed, '--token-env');
  const timeoutMs = stringFlag(parsed, '--timeout-ms');
  const caFile = stringFlag(parsed, '--ca-file');
  if (baseUrl !== undefined) input.baseUrl = baseUrl;
  if (tokenEnv !== undefined) input.tokenEnv = tokenEnv;
  if (timeoutMs !== undefined) input.timeoutMs = timeoutMs;
  if (caFile !== undefined) input.caFile = caFile;
  return new ForgejoService(await resolveConnection(input, env));
}

function resolveRepo(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
): RepositoryRef {
  const raw = stringFlag(parsed, '--repo') ?? env['FORGEJO_REPOSITORY'];
  if (!raw)
    throw usageError('--repo is required when FORGEJO_REPOSITORY is not set');
  return parseRepository(raw);
}

function withFlags(flags: FlagSpec): FlagSpec {
  return { ...CONNECTION_FLAGS, ...flags };
}

function pullState(value: string, allowAll: boolean): string {
  const allowed = allowAll ? ['open', 'closed', 'all'] : ['open', 'closed'];
  if (!allowed.includes(value))
    throw usageError(`--state must be ${allowed.join(' or ')}`);
  return value;
}

function positiveInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value))
    throw usageError(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw usageError(`${label} is too large`);
  return parsed;
}

const PULL_IDENTITY_FIELDS: ReadonlyArray<keyof PullRequestIdentity> = [
  'number',
  'url',
  'api_url',
  'state',
  'draft',
  'title',
  'head',
  'base',
  'head_sha',
  'mergeable',
  'merged',
  'merge_commit_sha',
  'merged_at',
  'merged_by',
];
const DEFAULT_PULL_LIST_FIELDS: ReadonlyArray<keyof PullRequestIdentity> = [
  'number',
  'title',
  'state',
  'head',
];

function rejectDisplayFlagConflicts(
  full: boolean,
  requestedLimit: string | undefined,
  json: boolean,
): void {
  if (full && requestedLimit !== undefined) {
    throw usageError('--full and --limit cannot be combined');
  }
  if (json && requestedLimit !== undefined) {
    throw usageError('--limit cannot be combined with --json');
  }
}

function displayLimit(requestedLimit: string | undefined): number {
  return requestedLimit === undefined
    ? 30
    : positiveInteger(requestedLimit, '--limit');
}

function pullListFields(
  raw: string | undefined,
): ReadonlyArray<keyof PullRequestIdentity> {
  if (raw === undefined) return DEFAULT_PULL_LIST_FIELDS;
  if (raw === 'all') return PULL_IDENTITY_FIELDS;
  const fields = raw.split(',');
  if (
    fields.some(
      (field, index) =>
        !PULL_IDENTITY_FIELDS.includes(field as keyof PullRequestIdentity) ||
        fields.indexOf(field) !== index,
    )
  ) {
    throw usageError(`Invalid or duplicate --fields value: ${raw}`, [
      `Valid fields: ${PULL_IDENTITY_FIELDS.join(',')},all`,
    ]);
  }
  return fields as Array<keyof PullRequestIdentity>;
}

function selectPullFields(
  pull: PullRequestIdentity,
  fields: ReadonlyArray<keyof PullRequestIdentity>,
): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, pull[field]]));
}

function listOutput<T>(
  key: string,
  displayed: T[],
  page: {
    items: unknown[];
    complete: boolean;
    pages: number;
    total: number | null;
  },
  showAll: boolean,
): Record<string, unknown> {
  const info = pageInfo(page, displayed.length);
  const next: string[] = [];
  if (!showAll && displayed.length < page.items.length) {
    next.push('Rerun with --full to display every fetched entry');
  }
  if (!page.complete) {
    next.push('Narrow the query; the pagination safety ceiling was reached');
  }
  return {
    [key]: displayed,
    page_info: info,
    ...(next.length === 0 ? {} : { next }),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw usageError('--data must be valid JSON');
  }
}

function helpResult(key: string): never {
  const help = key === 'pr' ? PR_HELP : HELP[key];
  throw new HelpSignal(help ?? TOP_HELP);
}

class HelpSignal extends Error {
  constructor(readonly output: string) {
    super('help');
  }
}

function render(output: Record<string, unknown>, json: boolean): string {
  return json ? JSON.stringify(output) : encode(output);
}

function collapsedExecutable(): string {
  const executable = process.argv[1] ?? 'forgejo-axi';
  const home = process.env['HOME'];
  return home && executable.startsWith(home)
    ? `~${executable.slice(home.length)}`
    : executable;
}
