/**
 * The command catalog's single source of guidance. The CLI serves these
 * strings on `--help` and `src/skill.ts` renders the committed Agent Skill
 * from the same values, so guidance cannot drift into a second manual.
 */

export const DESCRIPTION =
  'Inspect and manage Forgejo pull request and issue workflows';

export const TOP_HELP = `forgejo-axi — ${DESCRIPTION}

Usage:
  forgejo-axi status [connection flags]
  forgejo-axi repo view --repo OWNER/REPO [connection flags]
  forgejo-axi api METHOD PATH [--data JSON] [--paginate [--limit N|--full]] [connection flags]
  forgejo-axi pr <find|list|view|history|reviews|diff|create|update|checks|mergeability|merge|merged> ...
  forgejo-axi label <list|create|edit|delete> ...
  forgejo-axi issue <list|view|history|create|edit|close|reopen|comment> ...
  forgejo-axi run <list|view|cancel|download> ...

Connection flags:
  --base-url URL     Forgejo root URL; defaults to environment or hosts.json
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
  history       Inspect or soft-delete content history
  reviews       List reviews with their inline comments
  diff          Print the unified diff
  create        Idempotently create or reconcile an open pull request
  update        Idempotently update a pull request
  checks        Normalize commit statuses and required contexts
  mergeability  Evaluate Forgejo mergeability and required checks
  merge         Merge only the expected head and return merged proof
  merged        Return merged-state proof

Wherever a command takes NUMBER it also accepts the pull request's URL, which
carries the repository with it and makes --repo unnecessary. The request still
goes to the configured base URL; the URL's host is never used to route it.

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
  history  Inspect or soft-delete content history for an issue or pull request
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

export const FAMILY_HELP: Record<string, string> = {
  pr: PR_HELP,
  label: LABEL_HELP,
  issue: ISSUE_HELP,
  run: RUN_HELP,
};

export const HELP: Record<string, string> = {
  status: `forgejo-axi status — probe host, authentication, version, and capabilities\n\nUsage:\n  forgejo-axi status [connection flags]\n\nExample:\n  forgejo-axi status --base-url https://forgejo.example\n`,
  'repo view': `forgejo-axi repo view — show repository identity and lifecycle features\n\nUsage:\n  forgejo-axi repo view --repo OWNER/REPO [connection flags]\n\nExample:\n  forgejo-axi repo view --repo owner/repo\n`,
  api: `forgejo-axi api — call a Forgejo API v1 path\n\nUsage:\n  forgejo-axi api METHOD PATH [--data JSON] [--paginate [--limit N|--full]] [connection flags]\n\nFlags:\n  --data JSON    JSON request body\n  --paginate     Fetch every array page (GET only)\n  --limit N      Display at most N fetched rows in TOON mode\n  --full         Display every fetched row in TOON mode\n\nExamples:\n  forgejo-axi api GET repos/owner/repo\n  forgejo-axi api GET repos/owner/repo/pulls --paginate --full\n  forgejo-axi api PATCH repos/owner/repo/pulls/4 --data '{"title":"New title"}'\n`,
  'pr find': `forgejo-axi pr find — find by head branch\n\nUsage:\n  forgejo-axi pr find --repo OWNER/REPO --head BRANCH [--base BRANCH] [--state open|closed|all] [connection flags]\n\nExample:\n  forgejo-axi pr find --repo owner/repo --head feature --base main\n`,
  'pr list': `forgejo-axi pr list — list pull requests\n\nUsage:\n  forgejo-axi pr list --repo OWNER/REPO [--state open|closed|all] [--limit N|--full] [--fields LIST|all] [connection flags]\n\nFlags:\n  --fields LIST  Comma-separated identity fields; defaults to number,title,state,head\n\nExamples:\n  forgejo-axi pr list --repo owner/repo\n  forgejo-axi pr list --repo owner/repo --state all --full --fields all\n`,
  'pr view': `forgejo-axi pr view — show canonical pull request identity and body\n\nUsage:\n  forgejo-axi pr view [--repo OWNER/REPO] NUMBER|URL [--full] [--fields LIST|all] [connection flags]\n\nFlags:\n  --full         Display the complete pull request body instead of its preview\n  --fields LIST  Comma-separated fields to keep; defaults to every field\n\nA requested field the host does not supply is omitted, never emitted as null.\n\nExamples:\n  forgejo-axi pr view --repo owner/repo 42 --full\n  forgejo-axi pr view https://forgejo.example/owner/repo/pulls/42 --fields state,head_sha\n`,
  'pr history': `forgejo-axi pr history — inspect or soft-delete pull request content history\n\nUsage:\n  forgejo-axi pr history [overview|list|detail|soft-delete] [--repo OWNER/REPO] NUMBER|URL [--comment-id ID] [--history-id ID] [--raw] [--yes] [connection flags]\n\nCommands:\n  overview    Show edit counts for the body and comments\n  list        List revisions, newest first; this is the default operation\n  detail      Reconstruct exact before/after text for one revision\n  soft-delete Delete one revision after detail confirms it is deletable\n\nFlags:\n  --comment-id ID   Comment id; 0 addresses the pull request body\n  --history-id ID   Revision id for detail or soft-delete\n  --raw             Include the dependency's raw diff HTML (detail only)\n  --yes             Required for soft-delete; no prompt is ever shown\n\nExamples:\n  forgejo-axi pr history overview --repo owner/repo 42\n  forgejo-axi pr history list --repo owner/repo 42 --comment-id 17\n  forgejo-axi pr history detail --repo owner/repo 42 --history-id 249\n  forgejo-axi pr history soft-delete --repo owner/repo 42 --history-id 249 --yes\n`,
  'pr reviews': `forgejo-axi pr reviews — list reviews with their inline comments\n\nUsage:\n  forgejo-axi pr reviews [--repo OWNER/REPO] NUMBER|URL [--limit N|--full] [connection flags]\n\nFlags:\n  --limit N   Display this many reviews instead of the default 30\n  --full      Display every review, with complete bodies instead of previews\n\nExample:\n  forgejo-axi pr reviews --repo owner/repo 42 --full\n`,
  'pr diff': `forgejo-axi pr diff — print the unified diff\n\nUsage:\n  forgejo-axi pr diff [--repo OWNER/REPO] NUMBER|URL [--full] [connection flags]\n\nFlags:\n  --full   Print every line instead of the first 30\n\nExample:\n  forgejo-axi pr diff --repo owner/repo 42 --full\n`,
  'pr create': `forgejo-axi pr create — idempotently create or reconcile an open pull request\n\nUsage:\n  forgejo-axi pr create --repo OWNER/REPO --title TITLE --head BRANCH --base BRANCH [--body BODY | --body-file PATH|-] [--draft] [connection flags]\n\nFlags:\n  --body BODY           Pull request body text\n  --body-file PATH|-    Read the body from a UTF-8 file, or '-' for stdin\n  --draft               Create the pull request as a draft\n\nThe body flags are mutually exclusive; --body-file content is sent verbatim.\n\nExamples:\n  forgejo-axi pr create --repo owner/repo --title "Fix race" --head fix/race --base main\n  forgejo-axi pr create --repo owner/repo --title "Fix race" --head fix/race --base main --body-file ./body.md\n  cat body.md | forgejo-axi pr create --repo owner/repo --title "Fix race" --head fix/race --base main --body-file -\n`,
  'pr update': `forgejo-axi pr update — idempotently update a pull request\n\nUsage:\n  forgejo-axi pr update [--repo OWNER/REPO] NUMBER|URL [--title TITLE] [--body BODY | --body-file PATH|-] [--base BRANCH] [--state open|closed] [connection flags]\n\nFlags:\n  --body BODY           Pull request body text\n  --body-file PATH|-    Read the body from a UTF-8 file, or '-' for stdin\n\nThe body flags are mutually exclusive; --body-file content is sent verbatim.\n\nExamples:\n  forgejo-axi pr update --repo owner/repo 42 --state closed\n  forgejo-axi pr update --repo owner/repo 42 --body-file ./body.md\n  cat body.md | forgejo-axi pr update --repo owner/repo 42 --body-file -\n`,
  'pr checks': `forgejo-axi pr checks — normalize statuses and required contexts\n\nUsage:\n  forgejo-axi pr checks [--repo OWNER/REPO] NUMBER|URL [connection flags]\n\nExample:\n  forgejo-axi pr checks --repo owner/repo 42 --json\n`,
  'pr mergeability': `forgejo-axi pr mergeability — evaluate mergeability and required checks\n\nUsage:\n  forgejo-axi pr mergeability [--repo OWNER/REPO] NUMBER|URL [connection flags]\n\nExample:\n  forgejo-axi pr mergeability --repo owner/repo 42\n`,
  'pr merge': `forgejo-axi pr merge — expected-head merge with merged-state proof\n\nUsage:\n  forgejo-axi pr merge [--repo OWNER/REPO] NUMBER|URL --expected-head SHA [--method merge|squash|rebase] [connection flags]\n\nExample:\n  forgejo-axi pr merge --repo owner/repo 42 --expected-head abc123 --method squash\n`,
  'pr merged': `forgejo-axi pr merged — return merged-state proof\n\nUsage:\n  forgejo-axi pr merged [--repo OWNER/REPO] NUMBER|URL [connection flags]\n\nExample:\n  forgejo-axi pr merged --repo owner/repo 42\n`,
  'label list': `forgejo-axi label list — list repository labels\n\nUsage:\n  forgejo-axi label list --repo OWNER/REPO [--limit N|--full] [connection flags]\n\nExample:\n  forgejo-axi label list --repo owner/repo --full\n`,
  'label create': `forgejo-axi label create — idempotently create or reconcile a label\n\nUsage:\n  forgejo-axi label create --repo OWNER/REPO NAME [--color HEX] [--description TEXT] [connection flags]\n\nFlags:\n  --color HEX          Six-digit hex color; defaults to #ededed on creation\n  --description TEXT   Label description\n\nExample:\n  forgejo-axi label create --repo owner/repo bug --color '#d73a4a' --description 'Something is broken'\n`,
  'label edit': `forgejo-axi label edit — edit a label addressed by name\n\nUsage:\n  forgejo-axi label edit --repo OWNER/REPO NAME [--name NEW] [--color HEX] [--description TEXT] [connection flags]\n\nFlags:\n  --name NEW           Rename the label, preserving its issue assignments\n  --color HEX          Six-digit hex color\n  --description TEXT   Label description\n\nExample:\n  forgejo-axi label edit --repo owner/repo bug --color '#b60205'\n`,
  'label delete': `forgejo-axi label delete — delete a label addressed by name\n\nUsage:\n  forgejo-axi label delete --repo OWNER/REPO NAME [connection flags]\n\nExample:\n  forgejo-axi label delete --repo owner/repo wontfix\n`,
  'issue list': `forgejo-axi issue list — list issues, excluding pull requests\n\nUsage:\n  forgejo-axi issue list --repo OWNER/REPO [--state open|closed|all] [--label NAMES] [--assignee USER] [--milestone NAME] [--limit N|--full] [--fields LIST|all] [connection flags]\n\nFlags:\n  --label NAMES      Comma-separated label names; every name must exist\n  --assignee USER    Only issues assigned to this user\n  --milestone NAME   Only issues in this milestone\n  --fields LIST      Comma-separated identity fields; defaults to number,title,state,labels\n\nExamples:\n  forgejo-axi issue list --repo owner/repo --label bug,triage\n  forgejo-axi issue list --repo owner/repo --state all --full --fields all\n`,
  'issue view': `forgejo-axi issue view — show an issue with its comment thread\n\nUsage:\n  forgejo-axi issue view --repo OWNER/REPO NUMBER [--full] [--fields LIST|all] [connection flags]\n\nFlags:\n  --full         Display complete bodies and every comment instead of previews\n  --fields LIST  Comma-separated issue fields to keep; defaults to every field\n\n--fields narrows the issue object only; the comment thread is unaffected.\n\nExamples:\n  forgejo-axi issue view --repo owner/repo 7 --full\n  forgejo-axi issue view --repo owner/repo 7 --fields state,labels\n`,
  'issue history': `forgejo-axi issue history — inspect or soft-delete issue content history\n\nUsage:\n  forgejo-axi issue history [overview|list|detail|soft-delete] --repo OWNER/REPO NUMBER [--comment-id ID] [--history-id ID] [--raw] [--yes] [connection flags]\n\nCommands:\n  overview    Show edit counts for the body and comments\n  list        List revisions, newest first; this is the default operation\n  detail      Reconstruct exact before/after text for one revision\n  soft-delete Delete one revision after detail confirms it is deletable\n\nFlags:\n  --comment-id ID   Comment id; 0 addresses the issue body\n  --history-id ID   Revision id for detail or soft-delete\n  --raw             Include the dependency's raw diff HTML (detail only)\n  --yes             Required for soft-delete; no prompt is ever shown\n\nExamples:\n  forgejo-axi issue history overview --repo owner/repo 7\n  forgejo-axi issue history list --repo owner/repo 7 --comment-id 17\n  forgejo-axi issue history detail --repo owner/repo 7 --history-id 249\n  forgejo-axi issue history soft-delete --repo owner/repo 7 --history-id 249 --yes\n`,
  'issue create': `forgejo-axi issue create — file a new issue\n\nUsage:\n  forgejo-axi issue create --repo OWNER/REPO --title TITLE [--body BODY] [--label NAMES] [--assignee USERS] [--milestone NAME] [connection flags]\n\nFlags:\n  --label NAMES      Comma-separated label names\n  --assignee USERS   Comma-separated usernames\n  --milestone NAME   Milestone name\n\nExample:\n  forgejo-axi issue create --repo owner/repo --title 'Race in scheduler' --label bug\n`,
  'issue edit': `forgejo-axi issue edit — edit an issue in place\n\nUsage:\n  forgejo-axi issue edit --repo OWNER/REPO NUMBER [--title TITLE] [--body BODY] [--label NAMES] [--assignee USERS] [--milestone NAME] [connection flags]\n\nFlags:\n  --label NAMES      Replace the label set; empty string clears it\n  --assignee USERS   Replace the assignee set; empty string clears it\n  --milestone NAME   Set the milestone; empty string clears it\n\nExample:\n  forgejo-axi issue edit --repo owner/repo 7 --label bug,triage\n`,
  'issue close': `forgejo-axi issue close — close an issue\n\nUsage:\n  forgejo-axi issue close --repo OWNER/REPO NUMBER [--comment TEXT] [connection flags]\n\nFlags:\n  --comment TEXT  Post this comment before closing\n\nExample:\n  forgejo-axi issue close --repo owner/repo 7 --comment 'Fixed in #42'\n`,
  'issue reopen': `forgejo-axi issue reopen — reopen a closed issue\n\nUsage:\n  forgejo-axi issue reopen --repo OWNER/REPO NUMBER [connection flags]\n\nExample:\n  forgejo-axi issue reopen --repo owner/repo 7\n`,
  'issue comment': `forgejo-axi issue comment — post a comment\n\nUsage:\n  forgejo-axi issue comment --repo OWNER/REPO NUMBER --body TEXT [connection flags]\n\nNUMBER may be a pull request; Forgejo serves pull request discussion through\nthe same issue comment endpoint.\n\nExample:\n  forgejo-axi issue comment --repo owner/repo 7 --body 'Reproduced on 15.0.5'\n`,
  'run list': `forgejo-axi run list — list Actions runs\n\nUsage:\n  forgejo-axi run list --repo OWNER/REPO [--status STATUS] [--branch BRANCH] [--limit N|--full] [--fields LIST|all] [connection flags]\n\nFlags:\n  --status STATUS  unknown|waiting|running|success|failure|cancelled|skipped|blocked\n  --branch BRANCH  Only runs triggered from this branch\n  --fields LIST    Comma-separated identity fields; defaults to id,title,status,branch\n\nExample:\n  forgejo-axi run list --repo owner/repo --status failure\n`,
  'run view': `forgejo-axi run view — show a run and its jobs\n\nUsage:\n  forgejo-axi run view --repo OWNER/REPO RUN_ID [--log|--log-failed] [--fields LIST|all] [connection flags]\n\nFlags:\n  --log          Fold every job's log into its job entry\n  --log-failed   Fold only failed jobs' logs\n  --fields LIST  Comma-separated run fields to keep; defaults to every field\n\nJob logs are omitted, not errored, when the host does not advertise job logs.\n--fields narrows the run object only; the job list is unaffected.\n\nExamples:\n  forgejo-axi run view --repo owner/repo 42 --log-failed\n  forgejo-axi run view --repo owner/repo 42 --fields status,head_sha\n`,
  'run cancel': `forgejo-axi run cancel — cancel a pending or running run\n\nUsage:\n  forgejo-axi run cancel --repo OWNER/REPO RUN_ID [connection flags]\n\nCancelling an already-finished run is a no-op; cancelled is false.\n\nExample:\n  forgejo-axi run cancel --repo owner/repo 42\n`,
  'run download': `forgejo-axi run download — download a run's artifacts\n\nUsage:\n  forgejo-axi run download --repo OWNER/REPO RUN_ID --dir DIR [--name NAME] [connection flags]\n\nFlags:\n  --dir DIR    Target directory; created if missing\n  --name NAME  Only artifacts with this exact name\n\nExisting files are never overwritten; download fails instead.\n\nExample:\n  forgejo-axi run download --repo owner/repo 42 --dir ./artifacts\n`,
};
