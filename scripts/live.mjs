// Live lane for one Forgejo host: `npm run test:live -- 15|16`.
// Never part of `npm run check`.
//
// Endpoints and tokens come from the environment, so no host, account, or
// credential is written down here. Supply them however you keep secrets — this
// repository uses a sops-encrypted `.env.json` loaded by mise:
//
//   FORGEJO_BASE_URL / FORGEJO_TOKEN            (the 16 lane)
//   FORGEJO_15_BASE_URL / FORGEJO_15_TOKEN      (the 15 lane)
//   FORGEJO_LIVE_REPO=owner/disposable          (arms the harness)
//
// This mutates FORGEJO_LIVE_REPO. Two independent guards must pass first: the
// harness reads its target from FORGEJO_LIVE_REPO rather than the ordinary
// FORGEJO_REPOSITORY, so everyday configuration can never arm it by accident,
// and it refuses unless the host it actually reached reports the version the
// lane expects. Pointing this at a real repository is unrecoverable.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';

const CLI = new URL('../dist/bin/forgejo-axi.js', import.meta.url).pathname;

const LANES = {
  15: {
    base: 'FORGEJO_15_BASE_URL',
    token: 'FORGEJO_15_TOKEN',
    expect: '15.0',
  },
  16: { base: 'FORGEJO_BASE_URL', token: 'FORGEJO_TOKEN', expect: '16.0' },
};

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

const LANE = LANES[process.argv[2]];
if (!LANE) {
  console.error(`usage: node scripts/live.mjs ${Object.keys(LANES).join('|')}`);
  process.exit(2);
}

const BASE_URL = required(LANE.base);
const TOKEN_ENV = LANE.token;
const TOKEN = required(TOKEN_ENV);
const REPO = required('FORGEJO_LIVE_REPO');
const EXPECT_VERSION = LANE.expect;
const CA_FILE = process.env['FORGEJO_CA_FILE'];

const CONN = [
  '--base-url',
  BASE_URL,
  '--token-env',
  TOKEN_ENV,
  ...(CA_FILE ? ['--ca-file', CA_FILE] : []),
];
const API = `${BASE_URL.replace(/\/$/, '')}/api/v1`;

// Nothing this harness prints may carry the token, including failure text.
const scrub = (parts) =>
  parts.map((p) => String(p).split(TOKEN).join('[REDACTED]'));
const writeOut = console.log.bind(console);
const writeErr = console.error.bind(console);
console.log = (...parts) => writeOut(...scrub(parts));
console.error = (...parts) => writeErr(...scrub(parts));

const results = [];
const ok = (name, pass, note = '') =>
  results.push({ name, pass: Boolean(pass), note });

function cli(args, { allowFail = false } = {}) {
  const full = args.includes('--json') ? args : [...args, '--json'];
  let out;
  try {
    out = execFileSync('node', [CLI, ...full, ...CONN], { encoding: 'utf8' });
  } catch (error) {
    out = String(error.stdout ?? '');
    if (!allowFail)
      throw new Error(
        `${args.join(' ')} exited nonzero => ${out.slice(0, 300)}`,
        { cause: error },
      );
  }
  try {
    return JSON.parse(out);
  } catch {
    if (allowFail) return { error: out.slice(0, 200) };
    throw new Error(`${args.join(' ')} gave non-JSON => ${out.slice(0, 300)}`);
  }
}

async function raw(method, path, body) {
  const response = await globalThis.fetch(`${API}/${path}`, {
    method,
    headers: {
      authorization: `token ${TOKEN}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    total: response.headers.get('x-total-count'),
    link: response.headers.get('link'),
    data: text ? JSON.parse(text) : null,
  };
}

// ---- refuse before any mutation ---------------------------------------------
// Reaching the wrong host is the failure that cannot be undone, so prove the
// identity of the host actually answering before writing anything to it.
let probed;
try {
  probed = cli(['status']);
} catch (error) {
  console.error(
    `Refusing to mutate: ${BASE_URL} did not answer a usable status probe — ${String(error.message).slice(0, 200)}`,
  );
  process.exit(2);
}
const version = String(probed.server?.version ?? '');
const majorMinor = version.split('.').slice(0, 2).join('.');
if (majorMinor !== EXPECT_VERSION) {
  console.error(
    `Refusing to mutate: ${BASE_URL} reports ${version || 'an unknown version'}, expected ${EXPECT_VERSION}.x`,
  );
  process.exit(2);
}
console.log(
  `host ${BASE_URL} — Forgejo ${version}, actions_job_logs=${probed.capabilities?.actions_job_logs}`,
);

const BRANCH = `live-probe-${Date.now().toString(36)}`;
const created = {
  issues: [],
  labels: [],
  pageLabels: [],
  milestone: null,
  pull: null,
};

try {
  // ---- seed ----------------------------------------------------------------
  for (const name of ['live-bug', 'live-triage']) {
    cli(['label', 'create', '--repo', REPO, name, '--color', '#ededed']);
    created.labels.push(name);
  }
  const ms = await raw('POST', `repos/${REPO}/milestones`, { title: 'v-live' });
  created.milestone = ms.data?.id ?? null;
  ok('seed milestone', ms.status === 201);

  // ---- create / view -------------------------------------------------------
  const made = cli([
    'issue',
    'create',
    '--repo',
    REPO,
    '--title',
    'live: scheduler race',
    '--body',
    'seeded by the live matrix',
    '--label',
    'live-bug',
    '--milestone',
    'v-live',
  ]);
  const n = made.issue.number;
  created.issues.push(n);
  ok(
    'create applies labels and milestone',
    made.issue.labels.includes('live-bug') && made.issue.milestone === 'v-live',
  );
  ok(
    'create builds canonical url',
    made.issue.url === `${BASE_URL.replace(/\/$/, '')}/${REPO}/issues/${n}`,
  );
  ok(
    'is_pull_request false for an issue',
    made.issue.is_pull_request === false,
  );

  // ---- edit reconcile ------------------------------------------------------
  const edit1 = cli([
    'issue',
    'edit',
    '--repo',
    REPO,
    String(n),
    '--label',
    'live-bug,live-triage',
  ]);
  ok(
    'edit replaces labels through the labels endpoint',
    edit1.updated === true && edit1.issue.labels.length === 2,
  );
  const edit2 = cli([
    'issue',
    'edit',
    '--repo',
    REPO,
    String(n),
    '--label',
    'live-bug,live-triage',
  ]);
  ok('repeat edit is a no-op', edit2.updated === false);

  const cleared = cli([
    'issue',
    'edit',
    '--repo',
    REPO,
    String(n),
    '--milestone',
    '',
  ]);
  ok('an empty value clears the milestone', cleared.issue.milestone === null);

  // ---- comment / close / reopen -------------------------------------------
  const commented = cli([
    'issue',
    'comment',
    '--repo',
    REPO,
    String(n),
    '--body',
    'live comment',
  ]);
  ok('comment returns an identity', Number.isInteger(commented.comment.id));

  const closed = cli([
    'issue',
    'close',
    '--repo',
    REPO,
    String(n),
    '--comment',
    'closing from the live matrix',
  ]);
  const thread = await raw('GET', `repos/${REPO}/issues/${n}/comments`);
  ok(
    'close posts the comment then closes',
    closed.issue.state === 'closed' &&
      thread.data.some((c) => c.body === 'closing from the live matrix'),
  );
  ok('closed_at populated', Boolean(closed.issue.closed_at));
  ok(
    'reopen restores open',
    cli(['issue', 'reopen', '--repo', REPO, String(n)]).issue.state === 'open',
  );
  ok(
    'reopen is idempotent',
    cli(['issue', 'reopen', '--repo', REPO, String(n)]).updated === false,
  );

  // ---- filters must actually narrow ----------------------------------------
  // Forgejo answers an unrecognised filter with an unfiltered list, so a filter
  // that silently does nothing looks exactly like one that works.
  const other = cli([
    'issue',
    'create',
    '--repo',
    REPO,
    '--title',
    'live: unrelated',
  ]);
  created.issues.push(other.issue.number);
  const excludesOther = (list) =>
    list.issues.every((i) => i.number !== other.issue.number) &&
    list.issues.some((i) => i.number === n);

  ok(
    'label filter narrows',
    excludesOther(
      cli(['issue', 'list', '--repo', REPO, '--label', 'live-triage']),
    ),
  );
  cli(['issue', 'edit', '--repo', REPO, String(n), '--milestone', 'v-live']);
  ok(
    'milestone filter narrows',
    excludesOther(
      cli(['issue', 'list', '--repo', REPO, '--milestone', 'v-live']),
    ),
  );
  const owner = REPO.split('/')[0];
  cli(['issue', 'edit', '--repo', REPO, String(n), '--assignee', owner]);
  ok(
    'assignee filter narrows',
    excludesOther(cli(['issue', 'list', '--repo', REPO, '--assignee', owner])),
  );
  ok(
    'state filter narrows',
    cli(['issue', 'list', '--repo', REPO, '--state', 'closed']).issues.every(
      (i) => i.number !== n,
    ),
  );
  ok(
    'unknown filter label refuses',
    cli(['issue', 'list', '--repo', REPO, '--label', 'no-such-label'], {
      allowFail: true,
    }).code === 'LABEL_NOT_FOUND',
  );

  // ---- does this host paginate comments? -----------------------------------
  // The whole thread is read in one request. If a host ever honours page/limit
  // that read silently truncates, so this must be proven per lane.
  const long = cli([
    'issue',
    'create',
    '--repo',
    REPO,
    '--title',
    'live: comment thread',
  ]);
  const t = long.issue.number;
  created.issues.push(t);
  for (let i = 1; i <= 55; i += 1)
    await raw('POST', `repos/${REPO}/issues/${t}/comments`, { body: `c${i}` });

  const p1 = await raw('GET', `repos/${REPO}/issues/${t}/comments?limit=10`);
  const p2 = await raw(
    'GET',
    `repos/${REPO}/issues/${t}/comments?limit=10&page=2`,
  );
  ok(
    'comments endpoint ignores page/limit',
    !(
      p1.data.length === 10 &&
      p2.data.length &&
      p1.data[0].id !== p2.data[0].id
    ),
    `page1=${p1.data.length} page2=${p2.data.length} total=${p1.total} link=${p1.link ? 'yes' : 'none'}`,
  );
  const viewed = cli(['issue', 'view', '--repo', REPO, String(t), '--full']);
  ok('issue view returns the whole thread', viewed.comments.length === 55);
  ok(
    'comment_info counts match',
    viewed.comment_info.fetched === 55 && viewed.comment_info.displayed === 55,
  );

  // ---- body preview --------------------------------------------------------
  const big = cli([
    'issue',
    'create',
    '--repo',
    REPO,
    '--title',
    'live: long body',
    '--body',
    'x'.repeat(600),
  ]);
  created.issues.push(big.issue.number);
  const preview = cli([
    'issue',
    'view',
    '--repo',
    REPO,
    String(big.issue.number),
  ]);
  ok(
    'body preview elides at 500 code points',
    preview.issue.body.length === 500 &&
      preview.issue.body.endsWith('...') &&
      preview.issue.body_length === 600 &&
      preview.issue.body_truncated === true,
  );

  // ---- repo view -----------------------------------------------------------
  const repo = cli(['repo', 'view', '--repo', REPO]).repository;
  ok(
    'repo view reports canonical identity',
    repo.full_name === REPO &&
      repo.url === `${BASE_URL.replace(/\/$/, '')}/${REPO}`,
  );

  // ---- a real multi-page endpoint ------------------------------------------
  // One Forgejo endpoint is already known to ignore page and limit. The shared
  // pagination helper is what issue list, pr list and label list all walk, so
  // prove it against a genuine page boundary rather than assuming.
  const paged = [];
  for (let i = 1; i <= 55; i += 1) {
    const made = await raw('POST', `repos/${REPO}/labels`, {
      name: `live-page-${String(i).padStart(2, '0')}`,
      color: '#ededed',
    });
    if (made.data?.id) created.pageLabels.push(made.data.id);
    paged.push(`live-page-${String(i).padStart(2, '0')}`);
  }

  const walked = cli([
    'api',
    'GET',
    `repos/${REPO}/labels`,
    '--paginate',
    '--full',
  ]);
  const walkedNames = new Set(walked.data.map((l) => l.name));
  ok(
    'api --paginate walks every page',
    walked.page_info.complete === true &&
      walked.page_info.pages >= 2 &&
      paged.every((name) => walkedNames.has(name)),
    `pages=${walked.page_info.pages} fetched=${walked.page_info.fetched}`,
  );

  const allLabels = cli(['label', 'list', '--repo', REPO, '--full']);
  const listedNames = new Set(allLabels.labels.map((l) => l.name));
  ok(
    'label list crosses the page boundary',
    allLabels.page_info.complete === true &&
      paged.every((name) => listedNames.has(name)),
    `fetched=${allLabels.page_info.fetched}`,
  );

  ok(
    'label edit updates in place',
    cli([
      'label',
      'edit',
      '--repo',
      REPO,
      'live-triage',
      '--description',
      'live edited',
    ]).updated === true,
  );

  // ---- pull request lane ---------------------------------------------------
  await raw('POST', `repos/${REPO}/contents/live-base.txt`, {
    content: Buffer.from('base\n').toString('base64'),
    message: 'live: seed base',
  });
  const branched = await raw('POST', `repos/${REPO}/contents/${BRANCH}.txt`, {
    content: Buffer.from(`probe ${BRANCH}\n`).toString('base64'),
    message: 'live: probe branch',
    new_branch: BRANCH,
  });
  ok('create a unique probe branch', branched.status === 201, BRANCH);

  const pr = cli([
    'pr',
    'create',
    '--repo',
    REPO,
    '--head',
    BRANCH,
    '--base',
    'main',
    '--title',
    'live: probe',
  ]);
  created.pull = pr.pull_request?.number ?? null;
  ok('open a pull request', Number.isInteger(created.pull));

  const posted = cli([
    'issue',
    'comment',
    '--repo',
    REPO,
    String(created.pull),
    '--body',
    'live: threaded into PR discussion',
  ]);
  ok(
    'issue comment accepts a pull request number',
    Number.isInteger(posted.comment?.id),
  );
  const prThread = await raw(
    'GET',
    `repos/${REPO}/issues/${created.pull}/comments`,
  );
  ok(
    'the comment lands in the pull request discussion',
    prThread.data.some((c) => c.body === 'live: threaded into PR discussion') &&
      prThread.data.some((c) => Boolean(c.pull_request_url)),
  );
  ok(
    'issue view flags a pull request',
    cli(['issue', 'view', '--repo', REPO, String(created.pull)]).issue
      .is_pull_request === true,
  );

  // Only meaningful once a pull request exists, and only if the field is
  // actually selected — the default schema omits it, so asking without
  // --fields would compare against undefined and prove nothing.
  const listed = cli([
    'issue',
    'list',
    '--repo',
    REPO,
    '--full',
    '--fields',
    'number,is_pull_request',
  ]);
  ok(
    'issue list excludes pull requests',
    listed.issues.length > 0 &&
      listed.issues.every((i) => i.is_pull_request === false) &&
      !listed.issues.some((i) => i.number === created.pull),
  );

  // ---- pull request reads --------------------------------------------------
  ok(
    'pr list includes the open pull request',
    cli(['pr', 'list', '--repo', REPO, '--full']).pull_requests.some(
      (p) => p.number === created.pull,
    ),
  );
  ok(
    'pr find locates it by head branch',
    cli(['pr', 'find', '--repo', REPO, '--head', BRANCH]).pull_request
      .number === created.pull,
  );
  const prView = cli([
    'pr',
    'view',
    '--repo',
    REPO,
    String(created.pull),
  ]).pull_request;
  ok('pr view reports the head sha', /^[0-9a-f]{40}$/.test(prView.head_sha));
  ok(
    'pr update changes the title',
    cli([
      'pr',
      'update',
      '--repo',
      REPO,
      String(created.pull),
      '--title',
      'live: probe (updated)',
    ]).pull_request.title === 'live: probe (updated)',
  );

  // ---- checks against real commit statuses ---------------------------------
  // An empty status set must read as none, never as a failure — a host without
  // Actions has no statuses to report and that is not a red check.
  const empty = cli(['pr', 'checks', '--repo', REPO, String(created.pull)]);
  ok(
    'no statuses reads as none, not failure',
    empty.checks.reported === 0 && empty.checks.state === 'none',
    `state=${empty.checks.state}`,
  );

  await raw('POST', `repos/${REPO}/statuses/${prView.head_sha}`, {
    state: 'success',
    context: 'live/probe',
    description: 'seeded by the live matrix',
  });
  const green = cli(['pr', 'checks', '--repo', REPO, String(created.pull)]);
  ok(
    'pr checks aggregates a real commit status',
    green.checks.reported === 1 &&
      green.checks.state === 'success' &&
      green.checks.statuses.some((s) => s.context === 'live/probe'),
    `reported=${green.checks.reported} state=${green.checks.state}`,
  );
  const mergeability = cli([
    'pr',
    'mergeability',
    '--repo',
    REPO,
    String(created.pull),
  ]);
  ok(
    'mergeability reflects the real head and checks',
    mergeability.mergeability.head_sha === prView.head_sha &&
      mergeability.mergeability.checks_pass === true,
    `mergeable=${mergeability.mergeability.mergeable}`,
  );

  // The expected-head guard must refuse a stale head rather than merge it.
  const raced = cli(
    [
      'pr',
      'merge',
      '--repo',
      REPO,
      String(created.pull),
      '--expected-head',
      '0'.repeat(40),
    ],
    { allowFail: true },
  );
  const stillOpen = await raw('GET', `repos/${REPO}/pulls/${created.pull}`);
  ok(
    'expected-head refuses a stale head without merging',
    raced.code === 'HEAD_CHANGED' && stillOpen.data?.merged === false,
    String(raced.code),
  );

  // Forgejo computes mergeability in the background and answers 405 "please try
  // again later" until that lands. A fake server settles instantly, so this wait
  // only exists against a real one.
  let settled = false;
  for (let attempt = 0; attempt < 20 && !settled; attempt += 1) {
    const state = await raw('GET', `repos/${REPO}/pulls/${created.pull}`);
    settled = state.data?.mergeable === true;
    if (!settled) await sleep(1000);
  }
  ok('forgejo settles mergeability in the background', settled);

  // ...and must go through when the head is the one we proved.
  const merge = cli([
    'pr',
    'merge',
    '--repo',
    REPO,
    String(created.pull),
    '--method',
    'squash',
    '--expected-head',
    prView.head_sha,
  ]);
  const afterMerge = await raw('GET', `repos/${REPO}/pulls/${created.pull}`);
  ok(
    'expected-head merges when the head matches',
    Boolean(merge.proof) && afterMerge.data?.merged === true,
  );
  ok(
    'pr merged proves the merge independently',
    Boolean(cli(['pr', 'merged', '--repo', REPO, String(created.pull)]).proof),
  );
} catch (error) {
  ok('RUN ABORTED', false, String(error.message).slice(0, 400));
} finally {
  let removed = 0;
  if (created.pull) {
    await raw('PATCH', `repos/${REPO}/pulls/${created.pull}`, {
      state: 'closed',
    });
    const gone = await raw('DELETE', `repos/${REPO}/issues/${created.pull}`);
    ok(
      'pull request removed',
      gone.status === 204,
      gone.status === 204 ? 'deleted' : `closed only (${gone.status})`,
    );
  }
  for (const number of created.issues) {
    const gone = await raw('DELETE', `repos/${REPO}/issues/${number}`);
    if (gone.status === 204) removed += 1;
  }
  for (const name of created.labels) {
    try {
      cli(['label', 'delete', '--repo', REPO, name]);
    } catch {
      /* best effort */
    }
  }
  for (const id of created.pageLabels)
    await raw('DELETE', `repos/${REPO}/labels/${id}`);
  if (created.milestone)
    await raw('DELETE', `repos/${REPO}/milestones/${created.milestone}`);
  await raw('DELETE', `repos/${REPO}/branches/${BRANCH}`);
  for (const file of ['live-base.txt', `${BRANCH}.txt`]) {
    const head = await raw('GET', `repos/${REPO}/contents/${file}`);
    if (head.data?.sha)
      await raw('DELETE', `repos/${REPO}/contents/${file}`, {
        message: 'live: cleanup',
        sha: head.data.sha,
      });
  }
  ok(
    'cleanup removed every created issue',
    removed === created.issues.length,
    `${removed}/${created.issues.length}`,
  );
}

for (const r of results)
  console.log(
    `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? `  [${r.note}]` : ''}`,
  );
const failed = results.filter((r) => !r.pass).length;
console.log(
  `\n${BASE_URL}: ${results.length - failed}/${results.length} passed`,
);
process.exitCode = failed ? 1 : 0;
