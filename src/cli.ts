import { encode } from '@toon-format/toon';
import { exitCodeForError, runAxiCli } from 'axi-sdk-js';
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
import { resolveConnection, type ConnectionInput } from './config.js';
import { asForgejoError, usageError } from './errors.js';
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
import { VERSION } from './version.js';

export interface MainOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
}

const DESCRIPTION =
  'Inspect and manage Forgejo pull request and issue workflows';
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
  forgejo-axi pr <find|list|view|reviews|diff|create|update|checks|mergeability|merge|merged> ...
  forgejo-axi label <list|create|edit|delete> ...
  forgejo-axi issue <list|view|create|edit|close|reopen|comment> ...
  forgejo-axi run <list|view|cancel|download> ...

Connection flags:
  --base-url URL     Forgejo root URL; defaults to FORGEJO_BASE_URL
  --token-env NAME   Read the token from this environment variable
  --timeout-ms N     Request timeout; default 15000
  --ca-file PATH     Replacement CA trust bundle file
  --json             Emit JSON instead of TOON

Examples:
  forgejo-axi status --base-url https://forgejo.example
  forgejo-axi pr checks --repo owner/repo 42
  forgejo-axi issue list --repo owner/repo --label bug
  forgejo-axi api GET repos/owner/repo
`;

const PR_HELP = `forgejo-axi pr — pull request lifecycle commands

Commands:
  find          Find a pull request by head branch
  list          List pull requests
  view          View canonical pull request identity
  reviews       List reviews with their inline comments
  diff          Print the unified diff
  create        Idempotently create or reconcile an open pull request
  update        Idempotently update a pull request
  checks        Normalize commit statuses and required contexts
  mergeability  Evaluate Forgejo mergeability and required checks
  merge         Merge only the expected head and return merged proof
  merged        Return merged-state proof

Run \`forgejo-axi pr <command> --help\` for flags and examples.
`;

const LABEL_HELP = `forgejo-axi label — repository label taxonomy commands

Commands:
  list    List repository labels
  create  Idempotently create or reconcile a label
  edit    Edit a label addressed by name
  delete  Delete a label addressed by name

Labels are addressed by name; the numeric id is resolved for you.

Run \`forgejo-axi label <command> --help\` for flags and examples.
`;

const ISSUE_HELP = `forgejo-axi issue — issue lifecycle commands

Commands:
  list     List issues, optionally filtered
  view     View an issue with its body and comment thread
  create   File a new issue
  edit     Edit title, body, labels, assignees, or milestone
  close    Close an issue, optionally with a final comment
  reopen   Reopen a closed issue
  comment  Post a comment on an issue or pull request

Labels and milestones are addressed by name; ids are resolved for you.
\`list\` returns issues only; use \`pr list\` for pull requests.

Run \`forgejo-axi issue <command> --help\` for flags and examples.
`;

const RUN_HELP = `forgejo-axi run — Actions run lifecycle commands

Commands:
  list      List Actions runs
  view      View a run and its jobs, optionally with job logs
  cancel    Cancel a pending or running run
  download  Download a run's artifacts to a directory

Capabilities are probed per route. A host without the Actions runs API turns
every command into {supported: false, capability: 'runs'}; cancel and download
likewise refuse with 'run_cancel' and 'run_artifacts' when only their routes
are missing (Forgejo 15.0.5 lists runs but has neither). view degrades
instead: without the jobs route it returns the run with no jobs and says so
in next.

Run \`forgejo-axi run <command> --help\` for flags and examples.
`;

const FAMILY_HELP: Record<string, string> = {
  pr: PR_HELP,
  label: LABEL_HELP,
  issue: ISSUE_HELP,
  run: RUN_HELP,
};

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
  'pr reviews': `forgejo-axi pr reviews — list reviews with their inline comments\n\nUsage:\n  forgejo-axi pr reviews --repo OWNER/REPO NUMBER [--limit N|--full] [connection flags]\n\nFlags:\n  --limit N   Display this many reviews instead of the default 30\n  --full      Display every review, with complete bodies instead of previews\n\nExample:\n  forgejo-axi pr reviews --repo owner/repo 42 --full\n`,
  'pr diff': `forgejo-axi pr diff — print the unified diff\n\nUsage:\n  forgejo-axi pr diff --repo OWNER/REPO NUMBER [--full] [connection flags]\n\nFlags:\n  --full   Print every line instead of the first 30\n\nExample:\n  forgejo-axi pr diff --repo owner/repo 42 --full\n`,
  'label list': `forgejo-axi label list — list repository labels\n\nUsage:\n  forgejo-axi label list --repo OWNER/REPO [--limit N|--full] [connection flags]\n\nExample:\n  forgejo-axi label list --repo owner/repo --full\n`,
  'label create': `forgejo-axi label create — idempotently create or reconcile a label\n\nUsage:\n  forgejo-axi label create --repo OWNER/REPO NAME [--color HEX] [--description TEXT] [connection flags]\n\nFlags:\n  --color HEX          Six-digit hex color; defaults to #ededed on creation\n  --description TEXT   Label description\n\nExample:\n  forgejo-axi label create --repo owner/repo bug --color '#d73a4a' --description 'Something is broken'\n`,
  'label edit': `forgejo-axi label edit — edit a label addressed by name\n\nUsage:\n  forgejo-axi label edit --repo OWNER/REPO NAME [--name NEW] [--color HEX] [--description TEXT] [connection flags]\n\nFlags:\n  --name NEW           Rename the label, preserving its issue assignments\n  --color HEX          Six-digit hex color\n  --description TEXT   Label description\n\nExample:\n  forgejo-axi label edit --repo owner/repo bug --color '#b60205'\n`,
  'label delete': `forgejo-axi label delete — delete a label addressed by name\n\nUsage:\n  forgejo-axi label delete --repo OWNER/REPO NAME [connection flags]\n\nExample:\n  forgejo-axi label delete --repo owner/repo wontfix\n`,
  'issue list': `forgejo-axi issue list — list issues, excluding pull requests\n\nUsage:\n  forgejo-axi issue list --repo OWNER/REPO [--state open|closed|all] [--label NAMES] [--assignee USER] [--milestone NAME] [--limit N|--full] [--fields LIST|all] [connection flags]\n\nFlags:\n  --label NAMES      Comma-separated label names; every name must exist\n  --assignee USER    Only issues assigned to this user\n  --milestone NAME   Only issues in this milestone\n  --fields LIST      Comma-separated identity fields; defaults to number,title,state,labels\n\nExamples:\n  forgejo-axi issue list --repo owner/repo --label bug,triage\n  forgejo-axi issue list --repo owner/repo --state all --full --fields all\n`,
  'issue view': `forgejo-axi issue view — show an issue with its comment thread\n\nUsage:\n  forgejo-axi issue view --repo OWNER/REPO NUMBER [--full] [connection flags]\n\nFlags:\n  --full  Display complete bodies and every comment instead of previews\n\nExample:\n  forgejo-axi issue view --repo owner/repo 7 --full\n`,
  'issue create': `forgejo-axi issue create — file a new issue\n\nUsage:\n  forgejo-axi issue create --repo OWNER/REPO --title TITLE [--body BODY] [--label NAMES] [--assignee USERS] [--milestone NAME] [connection flags]\n\nFlags:\n  --label NAMES      Comma-separated label names\n  --assignee USERS   Comma-separated usernames\n  --milestone NAME   Milestone name\n\nExample:\n  forgejo-axi issue create --repo owner/repo --title 'Race in scheduler' --label bug\n`,
  'issue edit': `forgejo-axi issue edit — edit an issue in place\n\nUsage:\n  forgejo-axi issue edit --repo OWNER/REPO NUMBER [--title TITLE] [--body BODY] [--label NAMES] [--assignee USERS] [--milestone NAME] [connection flags]\n\nFlags:\n  --label NAMES      Replace the label set; empty string clears it\n  --assignee USERS   Replace the assignee set; empty string clears it\n  --milestone NAME   Set the milestone; empty string clears it\n\nExample:\n  forgejo-axi issue edit --repo owner/repo 7 --label bug,triage\n`,
  'issue close': `forgejo-axi issue close — close an issue\n\nUsage:\n  forgejo-axi issue close --repo OWNER/REPO NUMBER [--comment TEXT] [connection flags]\n\nFlags:\n  --comment TEXT  Post this comment before closing\n\nExample:\n  forgejo-axi issue close --repo owner/repo 7 --comment 'Fixed in #42'\n`,
  'issue reopen': `forgejo-axi issue reopen — reopen a closed issue\n\nUsage:\n  forgejo-axi issue reopen --repo OWNER/REPO NUMBER [connection flags]\n\nExample:\n  forgejo-axi issue reopen --repo owner/repo 7\n`,
  'issue comment': `forgejo-axi issue comment — post a comment\n\nUsage:\n  forgejo-axi issue comment --repo OWNER/REPO NUMBER --body TEXT [connection flags]\n\nNUMBER may be a pull request; Forgejo serves pull request discussion through\nthe same issue comment endpoint.\n\nExample:\n  forgejo-axi issue comment --repo owner/repo 7 --body 'Reproduced on 15.0.5'\n`,
  'run list': `forgejo-axi run list — list Actions runs\n\nUsage:\n  forgejo-axi run list --repo OWNER/REPO [--status STATUS] [--branch BRANCH] [--limit N|--full] [--fields LIST|all] [connection flags]\n\nFlags:\n  --status STATUS  unknown|waiting|running|success|failure|cancelled|skipped|blocked\n  --branch BRANCH  Only runs triggered from this branch\n  --fields LIST    Comma-separated identity fields; defaults to id,title,status,branch\n\nExample:\n  forgejo-axi run list --repo owner/repo --status failure\n`,
  'run view': `forgejo-axi run view — show a run and its jobs\n\nUsage:\n  forgejo-axi run view --repo OWNER/REPO RUN_ID [--log|--log-failed] [connection flags]\n\nFlags:\n  --log          Fold every job's log into its job entry\n  --log-failed   Fold only failed jobs' logs\n\nJob logs are omitted, not errored, when the host does not advertise job logs.\n\nExample:\n  forgejo-axi run view --repo owner/repo 42 --log-failed\n`,
  'run cancel': `forgejo-axi run cancel — cancel a pending or running run\n\nUsage:\n  forgejo-axi run cancel --repo OWNER/REPO RUN_ID [connection flags]\n\nCancelling an already-finished run is a no-op; cancelled is false.\n\nExample:\n  forgejo-axi run cancel --repo owner/repo 42\n`,
  'run download': `forgejo-axi run download — download a run's artifacts\n\nUsage:\n  forgejo-axi run download --repo OWNER/REPO RUN_ID --dir DIR [--name NAME] [connection flags]\n\nFlags:\n  --dir DIR    Target directory; created if missing\n  --name NAME  Only artifacts with this exact name\n\nExisting files are never overwritten; download fails instead.\n\nExample:\n  forgejo-axi run download --repo owner/repo 42 --dir ./artifacts\n`,
};

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
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
      ) => Promise<Record<string, unknown> | string>,
    ) =>
    async (args: string[]): Promise<string> => {
      const output = await run(args, env);
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
      // Shadowing the SDK built-in keeps `update` an unknown command until
      // the package is actually published.
      update: () => {
        throw usageError('Unknown command: update', [
          'Run `forgejo-axi --help`',
        ]);
      },
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
  if (!env['FORGEJO_BASE_URL']) {
    return {
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

async function runPull(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> | string> {
  const subcommand = args[0];
  if (!subcommand || subcommand === '--help') return helpText('pr');
  const key = `pr ${subcommand}`;
  if (!Object.hasOwn(HELP, key)) {
    throw usageError(`Unknown pr command: ${subcommand}`, [
      'Run `forgejo-axi pr --help`',
    ]);
  }
  const rest = args.slice(1);
  if (rest.includes('--help')) return helpText(key);
  switch (subcommand) {
    case 'find':
      return pullFind(rest, env);
    case 'list':
      return pullList(rest, env);
    case 'reviews':
      return pullReviews(rest, env);
    case 'diff':
      return pullDiff(rest, env);
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
    // A complete diff is emitted exactly as the forge sent it, trailing
    // newline included, so a saved patch still applies. An excerpt is an
    // excerpt and carries no such promise.
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
  if (state !== undefined) stateFlag(state, false);
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

async function runLabel(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> | string> {
  const subcommand = args[0];
  if (!subcommand || subcommand === '--help') return helpText('label');
  const key = `label ${subcommand}`;
  if (!Object.hasOwn(HELP, key)) {
    throw usageError(`Unknown label command: ${subcommand}`, [
      'Run `forgejo-axi label --help`',
    ]);
  }
  const rest = args.slice(1);
  if (rest.includes('--help')) return helpText(key);
  switch (subcommand) {
    case 'list':
      return labelList(rest, env);
    case 'create':
      return labelCreate(rest, env);
    case 'edit':
      return labelEdit(rest, env);
    case 'delete':
      return labelDelete(rest, env);
    default:
      throw usageError(`Unknown label command: ${subcommand}`);
  }
}

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

async function runIssue(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> | string> {
  const subcommand = args[0];
  if (!subcommand || subcommand === '--help') return helpText('issue');
  const key = `issue ${subcommand}`;
  if (!Object.hasOwn(HELP, key)) {
    throw usageError(`Unknown issue command: ${subcommand}`, [
      'Run `forgejo-axi issue --help`',
    ]);
  }
  const rest = args.slice(1);
  if (rest.includes('--help')) return helpText(key);
  switch (subcommand) {
    case 'list':
      return issueList(rest, env);
    case 'view':
      return issueView(rest, env);
    case 'create':
      return issueCreate(rest, env);
    case 'edit':
      return issueEdit(rest, env);
    case 'close':
      return issueSetState(rest, env, 'closed');
    case 'reopen':
      return issueSetState(rest, env, 'open');
    case 'comment':
      return issueComment(rest, env);
    default:
      throw usageError(`Unknown issue command: ${subcommand}`);
  }
}

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
  return {
    issue,
    comments: displayed,
    comment_info: {
      fetched: comments.length,
      displayed: displayed.length,
      truncated: hidden > 0,
    },
    ...(hidden > 0
      ? { next: ['Rerun with --full to display every comment'] }
      : {}),
  };
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

async function runRun(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> | string> {
  const subcommand = args[0];
  if (!subcommand || subcommand === '--help') return helpText('run');
  const key = `run ${subcommand}`;
  if (!Object.hasOwn(HELP, key)) {
    throw usageError(`Unknown run command: ${subcommand}`, [
      'Run `forgejo-axi run --help`',
    ]);
  }
  const rest = args.slice(1);
  if (rest.includes('--help')) return helpText(key);
  switch (subcommand) {
    case 'list':
      return runList(rest, env);
    case 'view':
      return runView(rest, env);
    case 'cancel':
      return runCancel(rest, env);
    case 'download':
      return runDownload(rest, env);
    default:
      throw usageError(`Unknown run command: ${subcommand}`);
  }
}

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
  if (status !== undefined) runStatusFlag(status);
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

function runStatusFlag(value: string): void {
  if (!RUN_STATUSES.includes(value))
    throw usageError(`--status must be one of ${RUN_STATUSES.join(', ')}`);
}

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

function render(output: Record<string, unknown>, json: boolean): string {
  return json ? JSON.stringify(output) : encode(output);
}
