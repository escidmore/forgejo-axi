import { readFile } from 'node:fs/promises';
import { encode } from '@toon-format/toon';
import {
  exitCodeForError,
  installSessionStartHooks,
  runAxiCli,
  shouldInstallHooksForNodeAxiExecPath,
} from 'axi-sdk-js';
import {
  boolFlag,
  parseArgs,
  positiveInteger,
  rejectPositionals,
  requireFlag,
  requireOnePositional,
  stringFlag,
  type FlagSpec,
  type ParsedArgs,
} from './args.js';
import { resolveConnection } from './config.js';
import { asForgejoError, ForgejoAxiError, usageError } from './errors.js';
import {
  ForgejoService,
  normalizeLabelColor,
  pageInfo,
  parseIssueNumber,
  parsePullNumber,
  parseRepository,
  parseRunId,
  type IssueIdentity,
  type IssueInput,
  type LabelInput,
  type PullRequestIdentity,
  type RepositoryRef,
  type RunIdentity,
} from './forgejo.js';
import { DESCRIPTION, FAMILY_HELP, HELP, TOP_HELP } from './help.js';
import { VERSION } from './version.js';

export interface MainOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stdin?: Stdin;
  /** Entry point `setup hooks` wires a session hook to; defaults to argv[1]. */
  execPath?: string;
}

type Stdin = AsyncIterable<Uint8Array | string>;

const BODY_DECODER = new TextDecoder('utf8', {
  fatal: true,
  ignoreBOM: true,
});

const CONNECTION_FLAGS: FlagSpec = {
  '--base-url': 'value',
  '--token-env': 'value',
  '--timeout-ms': 'value',
  '--ca-file': 'value',
  '--json': 'boolean',
  '--help': 'boolean',
};

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stdin: Stdin = options.stdin ?? process.stdin;
  const execPath = options.execPath ?? process.argv[1] ?? '';
  const json = argv.includes('--json');

  const formatError = (
    error: unknown,
  ): { output: string; exitCode: number } => {
    const normalized = asForgejoError(error);
    const output: Record<string, unknown> = {
      error: normalized.message,
      code: normalized.code,
      details: normalized.details,
      help: normalized.suggestions,
    };
    return {
      output: `${render(output, json)}\n`,
      exitCode: normalized.usage ? 2 : exitCodeForError(normalized),
    };
  };

  // The SDK's own leading-flag rejection bypasses formatError, losing the
  // contract's error shape and --json rendering, so this check stays local.
  const first = argv[0];
  const soleVersionOrHelp =
    argv.length === 1 &&
    ['--help', '--version', '-v', '-V'].includes(first ?? '');
  if (first !== undefined && first.startsWith('-') && !soleVersionOrHelp) {
    const formatted = formatError(
      usageError('Flags must come after a command', [
        'Run `forgejo-axi --help`',
      ]),
    );
    stdout.write(formatted.output);
    process.exitCode = formatted.exitCode;
    return;
  }

  const command =
    (
      run: (
        args: string[],
        env: NodeJS.ProcessEnv,
        stdin: Stdin,
      ) => Promise<Record<string, unknown> | string>,
    ) =>
    async (args: string[]): Promise<string> => {
      const output = await run(args, env, stdin);
      return typeof output === 'string' ? output : render(output, json);
    };

  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    topLevelHelp: TOP_HELP,
    stdout,
    home: () => homeOutput(env),
    commands: {
      status: command(runStatus),
      repo: command(runRepo),
      api: command(runApi),
      pr: command(runPull),
      label: command(runLabel),
      issue: command(runIssue),
      run: command(runRun),
      setup: command(makeRunSetup(execPath)),
    },
    getCommandHelp: (name) => COMMAND_HELP[name],
    renderUnknownCommand: (name) =>
      formatError(
        usageError(`Unknown command: ${name}`, ['Run `forgejo-axi --help`']),
      ).output,
    formatError,
  });
}

/**
 * Commands whose full help the SDK serves on `--help`; the pr/label/issue
 * families resolve subcommand help inside their handlers instead.
 */
const COMMAND_HELP: Record<string, string | undefined> = {
  status: HELP['status'],
  api: HELP['api'],
  repo: HELP['repo view'],
};

async function homeOutput(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  let connection;
  try {
    connection = await resolveConnection({}, env);
  } catch (error) {
    if (!(
      error instanceof ForgejoAxiError &&
      error.code === 'VALIDATION_ERROR' &&
      error.message ===
        '--base-url is required when FORGEJO_BASE_URL is not set'
    )) {
      throw error;
    }
    return {
      configured: false,
      next: [
        'Configure ~/.config/forgejo-axi/hosts.json or set FORGEJO_BASE_URL and a host-scoped FORGEJO_TOKEN_<HOST_KEY>',
        'forgejo-axi status --base-url https://forgejo.example',
        'forgejo-axi --help',
      ],
    };
  }
  const service = new ForgejoService(connection);
  return {
    configured: true,
    ...(await service.status()),
    next: [
      'forgejo-axi repo view --repo OWNER/REPO',
      'forgejo-axi pr list --repo OWNER/REPO',
    ],
  };
}

async function runStatus(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
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
    throw usageError(`Unknown repo command: ${subcommand ?? '(missing)'}`, [
      'Run `forgejo-axi repo view --help`',
    ]);
  }
  const rest = args.slice(1);
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

type SubcommandHandler = (
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: Stdin,
) => Promise<Record<string, unknown>>;

/** The shared help/validate/dispatch preamble of the pr/label/issue/run families. */
function dispatch(
  family: string,
  handlers: Record<string, SubcommandHandler>,
): (
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: Stdin,
) => Promise<Record<string, unknown> | string> {
  return async (args, env, stdin) => {
    const subcommand = args[0];
    if (!subcommand || subcommand === '--help') return helpText(family);
    const handler = Object.hasOwn(handlers, subcommand)
      ? handlers[subcommand]
      : undefined;
    if (!handler) {
      throw usageError(`Unknown ${family} command: ${subcommand}`, [
        `Run \`forgejo-axi ${family} --help\``,
      ]);
    }
    const rest = args.slice(1);
    if (rest.includes('--help')) return helpText(`${family} ${subcommand}`);
    return handler(rest, env, stdin);
  };
}

/**
 * The entry points a session hook may be wired to. The SDK infers this from
 * argv when it is not told, but naming it here means the command reports its
 * own decision rather than discovering the SDK's after the fact.
 */
const HOOK_MARKER = 'forgejo-axi';
const HOOK_BINARY_NAMES = [HOOK_MARKER];
const HOOK_DIST_ENTRYPOINTS = [`dist/bin/${HOOK_MARKER}.js`];

function makeRunSetup(
  execPath: string,
): (
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: Stdin,
) => Promise<Record<string, unknown> | string> {
  return dispatch('setup', {
    hooks: (args, env) => setupHooks(args, env, execPath),
  });
}

/**
 * Install the agent SessionStart hooks that carry this tool's ambient context.
 *
 * Local only: it resolves no host and reads no credential, so it works before
 * the CLI is configured at all -- which is when a first-time user runs it.
 */
async function setupHooks(
  args: string[],
  env: NodeJS.ProcessEnv,
  execPath: string,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    { '--json': 'boolean', '--help': 'boolean' },
    'setup hooks',
  );
  rejectPositionals(parsed);
  await Promise.resolve();

  // The SDK declines silently when the entry point is not an installed
  // forgejo-axi binary -- a dev checkout, a bundler, some other runner -- which
  // is the right refusal but would otherwise be reported here as a successful
  // install. Asking its own predicate first is what lets this answer say which
  // of the two happened.
  const installable =
    execPath !== '' &&
    shouldInstallHooksForNodeAxiExecPath(execPath, {
      marker: HOOK_MARKER,
      binaryNames: HOOK_BINARY_NAMES,
      distEntrypoints: HOOK_DIST_ENTRYPOINTS,
    });
  if (!installable) {
    return {
      hooks: {
        installed: false,
        reason: 'entry_point_not_an_installed_binary',
        entry_point: execPath,
      },
      next: [
        'Install the CLI with `npm install -g forgejo-axi`, then rerun `forgejo-axi setup hooks`',
      ],
    };
  }

  const failures: string[] = [];
  // The SDK falls back to os.homedir(); passing the environment's own value
  // when it has one keeps the command testable against a scratch directory
  // instead of the real home, and resolves to the same place in production.
  const home = env['HOME'] ?? env['USERPROFILE'];
  installSessionStartHooks({
    marker: HOOK_MARKER,
    binaryNames: HOOK_BINARY_NAMES,
    distEntrypoints: HOOK_DIST_ENTRYPOINTS,
    execPath,
    ...(home === undefined || home === '' ? {} : { homeDir: home }),
    onError: (message) => failures.push(message),
  });
  if (failures.length > 0) {
    throw new ForgejoAxiError(
      'Some agent hook targets could not be written',
      'SETUP_FAILED',
      {
        details: { failures },
        suggestions: [
          'Fix the reported paths, then run `forgejo-axi setup hooks` again',
        ],
      },
    );
  }
  return {
    hooks: { installed: true, entry_point: execPath },
    next: [
      'Start a new agent session; the hook runs at session start',
      'forgejo-axi status --base-url https://forgejo.example',
    ],
  };
}

const runPull = dispatch('pr', {
  find: pullFind,
  list: pullList,
  history: (args, env) => contentHistoryRead('pr', args, env),
  reviews: pullReviews,
  diff: pullDiff,
  view: (args, env) => pullRead('view', args, env),
  checks: (args, env) => pullRead('checks', args, env),
  mergeability: (args, env) => pullRead('mergeability', args, env),
  merged: (args, env) => pullRead('merged', args, env),
  create: pullCreate,
  update: pullUpdate,
  merge: pullMerge,
});

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
  const state = stateFlag(stringFlag(parsed, '--state') ?? 'open', true);
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
  const state = stateFlag(stringFlag(parsed, '--state') ?? 'open', true);
  const service = await serviceFor(parsed, env);
  const page = await service.listPulls(repo, state);
  const limit = displayLimit(requestedLimit);
  const showAll = full || json;
  const fields = chooseFields<PullRequestIdentity>(
    stringFlag(parsed, '--fields'),
    PULL_IDENTITY_FIELDS,
    DEFAULT_PULL_LIST_FIELDS,
  );
  const displayed = (showAll ? page.items : page.items.slice(0, limit)).map(
    (pull) => selectFields(pull, fields),
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
    const pullRequest = await service.viewPull(
      repo,
      number,
      boolFlag(parsed, '--full'),
    );
    return {
      pull_request: pullRequest,
      ...(typeof pullRequest.edit_history_count === 'number' &&
      pullRequest.edit_history_count > 0
        ? { next: [historyHint('pr', repo, number)] }
        : {}),
    };
  }
  if (command === 'checks')
    return { checks: await service.checks(repo, number) };
  if (command === 'mergeability')
    return { mergeability: await service.mergeability(repo, number) };
  return { proof: await service.merged(repo, number) };
}

async function pullReviews(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--limit': 'value',
      '--full': 'boolean',
    }),
    'pr reviews',
  );
  const number = parsePullNumber(
    requireOnePositional(parsed, 'pull request number'),
  );
  const full = boolFlag(parsed, '--full');
  const requestedLimit = stringFlag(parsed, '--limit');
  const json = boolFlag(parsed, '--json');
  rejectDisplayFlagConflicts(full, requestedLimit, json);
  const repo = resolveRepo(parsed, env);
  const service = await serviceFor(parsed, env);
  const page = await service.listReviews(repo, number, full);
  const showAll = full || json;
  const displayed = showAll
    ? page.items
    : page.items.slice(0, displayLimit(requestedLimit));
  return listOutput('reviews', displayed, page, showAll);
}

async function pullDiff(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({ '--repo': 'value', '--full': 'boolean' }),
    'pr diff',
  );
  const number = parsePullNumber(
    requireOnePositional(parsed, 'pull request number'),
  );
  const repo = resolveRepo(parsed, env);
  const service = await serviceFor(parsed, env);
  const diff = await service.diffPull(repo, number);
  const showAll = boolFlag(parsed, '--full') || boolFlag(parsed, '--json');
  return diffOutput(diff, showAll);
}

/** Caps the diff at display time on the same terms as a TOON list view. */
function diffOutput(diff: string, showAll: boolean): Record<string, unknown> {
  const body = diff.endsWith('\n') ? diff.slice(0, -1) : diff;
  const lines = body === '' ? [] : body.split('\n');
  const displayed = showAll ? lines : lines.slice(0, displayLimit(undefined));
  const hidden = lines.length - displayed.length;
  return {
    // A complete diff is emitted as the forge sent it, trailing newline
    // included, so a saved patch still applies; render()'s control-character
    // strip is the only thing that alters it. An excerpt is an excerpt and
    // carries no such promise.
    diff: hidden === 0 ? diff : displayed.join('\n'),
    diff_info: {
      lines: lines.length,
      displayed: displayed.length,
      truncated: hidden > 0,
    },
    ...(hidden > 0
      ? { next: ['Rerun with --full to print the complete diff'] }
      : {}),
  };
}

async function pullCreate(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: Stdin,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--title': 'value',
      '--head': 'value',
      '--base': 'value',
      '--body': 'value',
      '--body-file': 'value',
      '--draft': 'boolean',
    }),
    'pr create',
  );
  rejectPositionals(parsed);
  const repo = resolveRepo(parsed, env);
  const title = requireFlag(parsed, '--title');
  const head = requireFlag(parsed, '--head');
  const base = requireFlag(parsed, '--base');
  const body = await pullBody(parsed, stdin);
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
  stdin: Stdin,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--title': 'value',
      '--body': 'value',
      '--body-file': 'value',
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
  if (state !== undefined) stateFlag(state, false);
  const title = stringFlag(parsed, '--title');
  const body = await pullBody(parsed, stdin);
  const base = stringFlag(parsed, '--base');
  const service = await serviceFor(parsed, env);
  return service.updatePull(repo, number, {
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body }),
    ...(base === undefined ? {} : { base }),
    ...(state === undefined ? {} : { state }),
  });
}

async function pullBody(
  parsed: ParsedArgs,
  stdin: Stdin,
): Promise<string | undefined> {
  const body = stringFlag(parsed, '--body');
  const bodyFile = stringFlag(parsed, '--body-file');
  if (body !== undefined && bodyFile !== undefined) {
    throw usageError('--body and --body-file cannot be combined', [
      `Choose one body source for \`${parsed.command}\``,
      `Run \`forgejo-axi ${parsed.command} --help\``,
    ]);
  }
  if (bodyFile === undefined) return body;

  const failure = (problem: string): ForgejoAxiError =>
    new ForgejoAxiError(
      bodyFile === '-'
        ? `${problem} pull request body from stdin`
        : `${problem} pull request body file: ${bodyFile}`,
      'BODY_FILE_ERROR',
      {
        usage: true,
        suggestions: [
          'Pass a readable UTF-8 file path or use --body-file - for stdin',
        ],
      },
    );

  let bytes: Uint8Array;
  try {
    bytes =
      bodyFile === '-' ? await readStdin(stdin) : await readFile(bodyFile);
  } catch {
    throw failure('Unable to read');
  }
  try {
    return BODY_DECODER.decode(bytes);
  } catch {
    throw failure('Unable to decode UTF-8 in');
  }
}

async function readStdin(stdin: Stdin): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
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

const runLabel = dispatch('label', {
  list: labelList,
  create: labelCreate,
  edit: labelEdit,
  delete: labelDelete,
});

async function labelList(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--limit': 'value',
      '--full': 'boolean',
    }),
    'label list',
  );
  rejectPositionals(parsed);
  const full = boolFlag(parsed, '--full');
  const json = boolFlag(parsed, '--json');
  const requestedLimit = stringFlag(parsed, '--limit');
  rejectDisplayFlagConflicts(full, requestedLimit, json);
  const repo = resolveRepo(parsed, env);
  const service = await serviceFor(parsed, env);
  const page = await service.listLabels(repo);
  const showAll = full || json;
  const displayed = showAll
    ? page.items
    : page.items.slice(0, displayLimit(requestedLimit));
  return listOutput('labels', displayed, page, showAll);
}

async function labelCreate(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--color': 'value',
      '--description': 'value',
    }),
    'label create',
  );
  const name = requireOnePositional(parsed, 'label name');
  const repo = resolveRepo(parsed, env);
  const input = labelInput(parsed);
  const service = await serviceFor(parsed, env);
  return service.createLabel(repo, name, input);
}

async function labelEdit(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--name': 'value',
      '--color': 'value',
      '--description': 'value',
    }),
    'label edit',
  );
  const name = requireOnePositional(parsed, 'label name');
  const repo = resolveRepo(parsed, env);
  const rename = stringFlag(parsed, '--name');
  if (rename !== undefined && rename.trim() === '')
    throw usageError('--name must not be empty');
  const input = {
    ...labelInput(parsed),
    ...(rename === undefined ? {} : { name: rename }),
  };
  const service = await serviceFor(parsed, env);
  return service.editLabel(repo, name, input);
}

async function labelDelete(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({ '--repo': 'value' }),
    'label delete',
  );
  const name = requireOnePositional(parsed, 'label name');
  const repo = resolveRepo(parsed, env);
  const service = await serviceFor(parsed, env);
  return service.deleteLabel(repo, name);
}

function labelInput(parsed: ParsedArgs): LabelInput {
  const color = stringFlag(parsed, '--color');
  const description = stringFlag(parsed, '--description');
  if (color !== undefined && !/^#?[0-9a-f]{6}$/i.test(color.trim()))
    throw usageError('--color must be a six-digit hex color such as #ededed');
  return {
    ...(color === undefined ? {} : { color: normalizeLabelColor(color) }),
    ...(description === undefined ? {} : { description }),
  };
}

const runIssue = dispatch('issue', {
  list: issueList,
  view: issueView,
  history: (args, env) => contentHistoryRead('issue', args, env),
  create: issueCreate,
  edit: issueEdit,
  close: (args, env) => issueSetState(args, env, 'closed'),
  reopen: (args, env) => issueSetState(args, env, 'open'),
  comment: issueComment,
});

async function issueList(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--state': 'value',
      '--label': 'value',
      '--assignee': 'value',
      '--milestone': 'value',
      '--limit': 'value',
      '--full': 'boolean',
      '--fields': 'value',
    }),
    'issue list',
  );
  rejectPositionals(parsed);
  const full = boolFlag(parsed, '--full');
  const json = boolFlag(parsed, '--json');
  const requestedLimit = stringFlag(parsed, '--limit');
  rejectDisplayFlagConflicts(full, requestedLimit, json);
  const repo = resolveRepo(parsed, env);
  const label = stringFlag(parsed, '--label');
  const assignee = stringFlag(parsed, '--assignee');
  const milestone = stringFlag(parsed, '--milestone');
  const service = await serviceFor(parsed, env);
  const page = await service.listIssues(repo, {
    state: stateFlag(stringFlag(parsed, '--state') ?? 'open', true),
    ...(label === undefined ? {} : { labels: commaList(label) }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(milestone === undefined ? {} : { milestone }),
  });
  const showAll = full || json;
  const fields = chooseFields<IssueIdentity>(
    stringFlag(parsed, '--fields'),
    ISSUE_IDENTITY_FIELDS,
    DEFAULT_ISSUE_LIST_FIELDS,
  );
  const displayed = (
    showAll ? page.items : page.items.slice(0, displayLimit(requestedLimit))
  ).map((issue) => selectFields(issue, fields));
  return listOutput('issues', displayed, page, showAll);
}

async function issueView(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({ '--repo': 'value', '--full': 'boolean' }),
    'issue view',
  );
  const number = parseIssueNumber(requireOnePositional(parsed, 'issue number'));
  const repo = resolveRepo(parsed, env);
  const full = boolFlag(parsed, '--full');
  const service = await serviceFor(parsed, env);
  const { issue, comments } = await service.viewIssue(repo, number, full);
  const showAll = full || boolFlag(parsed, '--json');
  const displayed = showAll
    ? comments
    : comments.slice(0, displayLimit(undefined));
  const hidden = comments.length - displayed.length;
  const issueHistoryCount = (issue as Record<string, unknown>)[
    'edit_history_count'
  ];
  const next: string[] = [];
  if (hidden > 0) next.push('Rerun with --full to display every comment');
  if (typeof issueHistoryCount === 'number' && issueHistoryCount > 0) {
    next.push(historyHint('issue', repo, number));
  }
  return {
    issue,
    comments: displayed,
    comment_info: {
      fetched: comments.length,
      displayed: displayed.length,
      truncated: hidden > 0,
    },
    ...(next.length > 0 ? { next } : {}),
  };
}

async function contentHistoryRead(
  family: 'issue' | 'pr',
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const operation = ['overview', 'list', 'detail', 'soft-delete'].includes(
    args[0] ?? '',
  )
    ? args[0]
    : 'list';
  const rest = operation === args[0] ? args.slice(1) : args;
  const command = `${family} history ${operation}`;
  const parsed = parseArgs(
    rest,
    withFlags({
      '--repo': 'value',
      '--comment-id': 'value',
      '--history-id': 'value',
      '--raw': 'boolean',
      '--yes': 'boolean',
    }),
    command,
  );
  const commentIdRaw = stringFlag(parsed, '--comment-id');
  const commentId =
    commentIdRaw === undefined
      ? 0
      : nonNegativeInteger(commentIdRaw, '--comment-id');
  const historyIdRaw = stringFlag(parsed, '--history-id');
  const historyId =
    historyIdRaw === undefined
      ? undefined
      : positiveInteger(historyIdRaw, '--history-id');
  const raw = boolFlag(parsed, '--raw');
  const yes = boolFlag(parsed, '--yes');
  if (operation === 'overview' && (commentIdRaw !== undefined || historyIdRaw))
    throw usageError('overview does not accept --comment-id or --history-id');
  if (operation === 'list' && historyIdRaw !== undefined)
    throw usageError('list does not accept --history-id');
  if (operation !== 'detail' && raw)
    throw usageError('--raw requires the detail operation');
  if (operation !== 'soft-delete' && yes)
    throw usageError('--yes requires the soft-delete operation');
  if (operation === 'soft-delete' && !yes)
    throw usageError('soft-delete requires --yes; no prompt is shown');
  if (operation === 'detail' && historyId === undefined)
    throw usageError('--history-id is required for detail');
  if (operation === 'soft-delete' && historyId === undefined)
    throw usageError('--history-id is required for soft-delete');

  const number =
    family === 'pr'
      ? parsePullNumber(requireOnePositional(parsed, 'pull request number'))
      : parseIssueNumber(requireOnePositional(parsed, 'issue number'));
  const repo = resolveRepo(parsed, env);
  const service = await serviceFor(parsed, env);
  if (operation === 'overview') {
    return { overview: await service.contentHistoryOverview(repo, number) };
  }
  if (operation === 'list') {
    return {
      comment_id: commentId,
      revisions: await service.listContentHistory(repo, number, commentId),
    };
  }
  if (operation === 'detail') {
    return {
      revision: await service.detailContentHistory(
        repo,
        number,
        commentId,
        historyId as number,
        raw,
      ),
    };
  }
  return service.softDeleteContentHistory(
    repo,
    number,
    commentId,
    historyId as number,
  );
}

function nonNegativeInteger(value: string, label: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw usageError(`${label} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw usageError(`${label} is too large`);
  return parsed;
}

function historyHint(
  family: 'issue' | 'pr',
  repo: RepositoryRef,
  number: number,
): string {
  return `forgejo-axi ${family} history list --repo ${repo.fullName} ${number}`;
}

async function issueCreate(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(args, withFlags(ISSUE_FIELD_FLAGS), 'issue create');
  rejectPositionals(parsed);
  const repo = resolveRepo(parsed, env);
  const title = requireFlag(parsed, '--title');
  const service = await serviceFor(parsed, env);
  return service.createIssue(repo, { ...issueInput(parsed), title });
}

async function issueEdit(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(args, withFlags(ISSUE_FIELD_FLAGS), 'issue edit');
  const number = parseIssueNumber(requireOnePositional(parsed, 'issue number'));
  const repo = resolveRepo(parsed, env);
  const title = stringFlag(parsed, '--title');
  // A title is the one field that cannot be cleared, so an empty one is a
  // mistake rather than an instruction.
  if (title === '') throw usageError('--title cannot be empty');
  const input: IssueInput = {
    ...issueInput(parsed),
    ...(title === undefined ? {} : { title }),
  };
  if (Object.keys(input).length === 0) {
    throw usageError('issue edit requires at least one field to change', [
      'Run `forgejo-axi issue edit --help`',
    ]);
  }
  const service = await serviceFor(parsed, env);
  return service.editIssue(repo, number, input);
}

async function issueSetState(
  args: string[],
  env: NodeJS.ProcessEnv,
  state: 'open' | 'closed',
): Promise<Record<string, unknown>> {
  const closing = state === 'closed';
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      ...(closing ? { '--comment': 'value' as const } : {}),
    }),
    closing ? 'issue close' : 'issue reopen',
  );
  const number = parseIssueNumber(requireOnePositional(parsed, 'issue number'));
  const repo = resolveRepo(parsed, env);
  const comment = stringFlag(parsed, '--comment');
  // Forgejo rejects an empty comment body, so catch it as usage rather than
  // letting an unset variable become a 422 mid-close.
  if (comment === '') throw usageError('--comment cannot be empty');
  const service = await serviceFor(parsed, env);
  return service.setIssueState(repo, number, state, comment);
}

async function issueComment(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({ '--repo': 'value', '--body': 'value' }),
    'issue comment',
  );
  const number = parseIssueNumber(requireOnePositional(parsed, 'issue number'));
  const repo = resolveRepo(parsed, env);
  const body = requireFlag(parsed, '--body');
  const service = await serviceFor(parsed, env);
  return service.commentIssue(repo, number, body);
}

const ISSUE_FIELD_FLAGS: FlagSpec = {
  '--repo': 'value',
  '--title': 'value',
  '--body': 'value',
  '--label': 'value',
  '--assignee': 'value',
  '--milestone': 'value',
};

function issueInput(parsed: ParsedArgs): IssueInput {
  const body = stringFlag(parsed, '--body');
  const label = stringFlag(parsed, '--label');
  const assignee = stringFlag(parsed, '--assignee');
  const milestone = stringFlag(parsed, '--milestone');
  return {
    ...(body === undefined ? {} : { body }),
    ...(label === undefined ? {} : { labels: commaList(label) }),
    ...(assignee === undefined ? {} : { assignees: commaList(assignee) }),
    ...(milestone === undefined ? {} : { milestone }),
  };
}

/** An empty value is an empty set, which is how these flags clear a field. */
function commaList(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

const runRun = dispatch('run', {
  list: runList,
  view: runView,
  cancel: runCancel,
  download: runDownload,
});

async function runList(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--status': 'value',
      '--branch': 'value',
      '--limit': 'value',
      '--full': 'boolean',
      '--fields': 'value',
    }),
    'run list',
  );
  rejectPositionals(parsed);
  const full = boolFlag(parsed, '--full');
  const json = boolFlag(parsed, '--json');
  const requestedLimit = stringFlag(parsed, '--limit');
  rejectDisplayFlagConflicts(full, requestedLimit, json);
  const repo = resolveRepo(parsed, env);
  const status = stringFlag(parsed, '--status');
  if (status !== undefined && !RUN_STATUSES.includes(status))
    throw usageError(`--status must be one of ${RUN_STATUSES.join(', ')}`);
  const branch = stringFlag(parsed, '--branch');
  const service = await serviceFor(parsed, env);
  if (!(await service.runCapabilities()).runs) return unsupportedResult('runs');
  const page = await service.listRuns(repo, {
    ...(status === undefined ? {} : { status }),
    ...(branch === undefined ? {} : { branch }),
  });
  const showAll = full || json;
  const fields = chooseFields<RunIdentity>(
    stringFlag(parsed, '--fields'),
    RUN_IDENTITY_FIELDS,
    DEFAULT_RUN_LIST_FIELDS,
  );
  const displayed = (
    showAll ? page.items : page.items.slice(0, displayLimit(requestedLimit))
  ).map((run) => selectFields(run, fields));
  return listOutput('runs', displayed, page, showAll);
}

async function runView(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({
      '--repo': 'value',
      '--log': 'boolean',
      '--log-failed': 'boolean',
    }),
    'run view',
  );
  const runId = parseRunId(requireOnePositional(parsed, 'run id'));
  const repo = resolveRepo(parsed, env);
  const wantLog = boolFlag(parsed, '--log');
  const wantLogFailed = boolFlag(parsed, '--log-failed');
  if (wantLog && wantLogFailed)
    throw usageError('--log and --log-failed cannot be combined');
  const service = await serviceFor(parsed, env);
  const capabilities = await service.runCapabilities();
  if (!capabilities.runs) return unsupportedResult('runs');
  const requested = wantLog ? 'all' : wantLogFailed ? 'failed' : 'none';
  const log =
    requested !== 'none' && !capabilities.job_logs ? 'none' : requested;
  const result = await service.viewRun(repo, runId, log, capabilities.run_jobs);
  const next = [
    ...(capabilities.run_jobs
      ? []
      : ['Run jobs are unsupported on this Forgejo host']),
    ...(capabilities.run_jobs && requested !== 'none' && log === 'none'
      ? ['Job logs are unsupported on this Forgejo host']
      : []),
  ];
  return { ...result, ...(next.length > 0 ? { next } : {}) };
}

async function runCancel(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({ '--repo': 'value' }),
    'run cancel',
  );
  const runId = parseRunId(requireOnePositional(parsed, 'run id'));
  const repo = resolveRepo(parsed, env);
  const service = await serviceFor(parsed, env);
  const capabilities = await service.runCapabilities();
  if (!capabilities.runs) return unsupportedResult('runs');
  if (!capabilities.run_cancel) return unsupportedResult('run_cancel');
  return service.cancelRun(repo, runId);
}

async function runDownload(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const parsed = parseArgs(
    args,
    withFlags({ '--repo': 'value', '--dir': 'value', '--name': 'value' }),
    'run download',
  );
  const runId = parseRunId(requireOnePositional(parsed, 'run id'));
  const repo = resolveRepo(parsed, env);
  const dir = requireFlag(parsed, '--dir');
  const name = stringFlag(parsed, '--name');
  const service = await serviceFor(parsed, env);
  const capabilities = await service.runCapabilities();
  if (!capabilities.runs) return unsupportedResult('runs');
  if (!capabilities.run_artifacts) return unsupportedResult('run_artifacts');
  return service.downloadRunArtifacts(repo, runId, name, dir);
}

const RUN_STATUSES = [
  'unknown',
  'waiting',
  'running',
  'success',
  'failure',
  'cancelled',
  'skipped',
  'blocked',
];

function unsupportedResult(capability: string): Record<string, unknown> {
  return {
    supported: false,
    capability,
    next: [
      `Upgrade Forgejo to a release that advertises the ${capability} API`,
    ],
  };
}

async function serviceFor(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
): Promise<ForgejoService> {
  const connection = await resolveConnection(
    {
      baseUrl: stringFlag(parsed, '--base-url'),
      tokenEnv: stringFlag(parsed, '--token-env'),
      timeoutMs: stringFlag(parsed, '--timeout-ms'),
      caFile: stringFlag(parsed, '--ca-file'),
    },
    env,
  );
  return new ForgejoService(connection);
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

function stateFlag(value: string, allowAll: boolean): string {
  const allowed = allowAll ? ['open', 'closed', 'all'] : ['open', 'closed'];
  if (!allowed.includes(value))
    throw usageError(`--state must be ${allowed.join(' or ')}`);
  return value;
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
const ISSUE_IDENTITY_FIELDS: ReadonlyArray<keyof IssueIdentity> = [
  'number',
  'url',
  'api_url',
  'state',
  'title',
  'labels',
  'assignees',
  'milestone',
  'comments',
  'is_pull_request',
  'user',
  'created_at',
  'updated_at',
  'closed_at',
];
const DEFAULT_ISSUE_LIST_FIELDS: ReadonlyArray<keyof IssueIdentity> = [
  'number',
  'title',
  'state',
  'labels',
];
const RUN_IDENTITY_FIELDS: ReadonlyArray<keyof RunIdentity> = [
  'id',
  'url',
  'api_url',
  'title',
  'event',
  'branch',
  'head_sha',
  'run_number',
  'status',
  'started_at',
  'completed_at',
];
const DEFAULT_RUN_LIST_FIELDS: ReadonlyArray<keyof RunIdentity> = [
  'id',
  'title',
  'status',
  'branch',
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

function chooseFields<T extends object>(
  raw: string | undefined,
  all: ReadonlyArray<keyof T & string>,
  defaults: ReadonlyArray<keyof T & string>,
): ReadonlyArray<keyof T & string> {
  if (raw === undefined) return defaults;
  if (raw === 'all') return all;
  const fields = raw.split(',');
  if (
    fields.some(
      (field, index) =>
        !all.includes(field as keyof T & string) ||
        fields.indexOf(field) !== index,
    )
  ) {
    throw usageError(`Invalid or duplicate --fields value: ${raw}`, [
      `Valid fields: ${all.join(',')},all`,
    ]);
  }
  return fields as Array<keyof T & string>;
}

function selectFields<T extends object>(
  row: T,
  fields: ReadonlyArray<keyof T & string>,
): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
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

/**
 * runAxiCli appends a newline to command output, so help is served without
 * its own trailing one.
 */
function helpText(key: string): string {
  return (FAMILY_HELP[key] ?? HELP[key] ?? TOP_HELP).replace(/\n$/, '');
}

/**
 * DEL and the C1 range, which neither encoder escapes. U+009B and U+009D are
 * CSI and OSC in their 8-bit forms, so a terminal reading Latin-1 would treat
 * server-controlled text carrying them as a control sequence. Both encoders
 * escape C0 already, and `\n` and `\t` sit below this range untouched.
 */
const UNESCAPED_CONTROLS = /[\u007f-\u009f]/g;

function render(output: Record<string, unknown>, json: boolean): string {
  // Structural syntax in both TOON and JSON is printable ASCII, so anything
  // matching here came from a string value and dropping it leaves the
  // document well-formed.
  return (json ? JSON.stringify(output) : encode(output)).replace(
    UNESCAPED_CONTROLS,
    '',
  );
}
