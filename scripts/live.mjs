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
//   FORGEJO_EXPECT_VERSION=16.0                 (optional; overrides the lane)
//   FORGEJO_CA_FILE=/path/to/ca.pem             (optional)
//   FORGEJO_LIVE_RUNNER_LABEL=live              (optional; arms the runner probes)
//
// This mutates FORGEJO_LIVE_REPO. Three independent guards must pass first: the
// harness reads its target from FORGEJO_LIVE_REPO rather than the ordinary
// FORGEJO_REPOSITORY, so everyday configuration can never arm it by accident;
// it refuses unless the host it actually reached reports the version the lane
// expects; and it refuses unless the host's own response for the armed
// repository names that repository back. Every guard exits 2 before writing
// anything. Pointing this at a real repository is unrecoverable.
import { Buffer } from 'node:buffer';
import { execFile, execFileSync } from 'node:child_process';
import console from 'node:console';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';
import { promisify } from 'node:util';

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
// CI supplies the expected major.minor alongside the endpoint it belongs to, so
// a lane pointed at a new host is told what that host must report rather than
// inheriting an expectation compiled in here.
// `||`, not `??`: an unset CI variable arrives as an empty string, and an empty
// expectation would compare equal to an empty reported version — the guard below
// would pass against a host that never said what it was.
const EXPECT_VERSION = process.env['FORGEJO_EXPECT_VERSION'] || LANE.expect;
const CA_FILE = process.env['FORGEJO_CA_FILE'];
// Arms the runner-dependent probes, and names the label the seeded workflows
// ask for. Unset, this lane runs exactly as it did before a runner existed —
// the paths below are the ones docs/live-test-matrix.md records as uncovered
// precisely because no fake server can answer them.
const RUNNER_LABEL = process.env['FORGEJO_LIVE_RUNNER_LABEL'];

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

// Nearly every invocation targets the lane repository; the exceptions
// (the status probe and raw api paths) skip withRepo and call cli directly.
const withRepo = (args) => [...args, '--repo', REPO];
const repoCli = (args, options) => cli(withRepo(args), options);

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

// Cleanup runs in `finally`, where one throw would strand every step after it —
// and the step most expensive to recover by hand is a protected branch. Each
// teardown call goes through here so a failure costs one object, not the rest.
const discard = async (method, path, body) => {
  try {
    return await raw(method, path, body);
  } catch {
    return { status: 0, data: null };
  }
};

// Concurrency is the only way to reach the race-recovery path, so this variant
// runs invocations in parallel; `cli` stays synchronous for everything else.
const execFileAsync = promisify(execFile);
async function cliConcurrent(args) {
  const full = [...args, '--json', ...CONN];
  let out;
  try {
    out = (await execFileAsync('node', [CLI, ...full], { encoding: 'utf8' }))
      .stdout;
  } catch (error) {
    out = String(error.stdout ?? '');
  }
  try {
    return JSON.parse(out);
  } catch {
    return { error: out.slice(0, 200) };
  }
}

const seedStatus = (sha, state, context) =>
  raw('POST', `repos/${REPO}/statuses/${sha}`, {
    state,
    context,
    description: 'seeded by the live matrix',
  });

// `mergeable: true` does not mean every method is ready: Forgejo answers 405
// "please try again later" while it still works out a rebase. Retrying is safe
// because every attempt carries the same expected head, so a head that moved
// underneath is refused rather than merged.
async function mergeWhenReady(number, method, expectedHead) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = repoCli(
      [
        'pr',
        'merge',
        String(number),
        '--method',
        method,
        '--expected-head',
        expectedHead,
      ],
      { allowFail: true },
    );
    if (result.code !== 'API_ERROR' || result.details?.status !== 405)
      return result;
    await sleep(1000);
  }
  return { code: 'STILL_NOT_MERGEABLE' };
}

// Forgejo computes mergeability in the background and answers 405 "please try
// again later" until that lands. A fake server settles instantly, so this wait
// only exists against a real one.
async function settle(number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await raw('GET', `repos/${REPO}/pulls/${number}`);
    if (state.data?.mergeable === true) return true;
    await sleep(1000);
  }
  return false;
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
// The right host is still the wrong target if the armed repository is not the
// one it serves under that name. This asks the host directly rather than going
// through `repo view`, whose `full_name` falls back to the name we supplied and
// whose `url` is rebuilt from our own base URL — both would agree with us no
// matter what the host actually holds.
const liveRepo = await raw('GET', `repos/${REPO}`);
if (liveRepo.status !== 200 || liveRepo.data?.full_name !== REPO) {
  console.error(
    `Refusing to mutate: ${BASE_URL} answered ${liveRepo.status} for ${REPO}` +
      `${liveRepo.data?.full_name ? ` and named it ${liveRepo.data.full_name}` : ''}`,
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
  labelIds: [],
  milestone: null,
  pulls: [],
  branches: [],
  protection: null,
};

// Every probe branch carries the per-run prefix, so cleanup can never reach a
// branch that predates this run.
// Throwing rather than returning a status keeps a failed branch from surfacing
// later as an unrelated mystery: every assertion downstream of a probe branch
// depends on it existing.
async function probeBranch(name, from) {
  const response = await raw('POST', `repos/${REPO}/contents/${name}.txt`, {
    content: Buffer.from(`probe ${name}\n`).toString('base64'),
    message: `live: ${name}`,
    ...(from === undefined ? {} : { branch: from }),
    new_branch: name,
  });
  if (response.status !== 201) {
    throw new Error(
      `could not create probe branch ${name} => ${response.status}`,
    );
  }
  created.branches.push(name);
  return response;
}

const TERMINAL_RUN = new Set(['success', 'failure', 'cancelled', 'skipped']);

// Seeding a workflow onto its own branch makes the push that creates the branch
// the event that triggers the run, so one request both installs and fires it.
// The action reference resolves through the host's configured actions source,
// so a host pointed somewhere other than code.forgejo.org needs it adjusted.
async function workflowBranch(name, yaml) {
  const response = await raw(
    'POST',
    `repos/${REPO}/contents/.forgejo/workflows/${name}.yml`,
    {
      content: Buffer.from(yaml).toString('base64'),
      message: `live: ${name}`,
      new_branch: name,
    },
  );
  if (response.status !== 201) {
    throw new Error(`could not seed workflow ${name} => ${response.status}`);
  }
  created.branches.push(name);
  return response;
}

// Forgejo queues the run after the push returns, and a runner claims it some
// time after that. Returning null rather than throwing keeps an idle or
// mislabelled runner reported as one failed assertion instead of cancelling
// every probe that follows it.
async function waitForRun(branch, done, what, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const run = (repoCli(['run', 'list', '--branch', branch]).runs ?? [])[0];
    if (run && done(run)) return run;
    await sleep(2000);
  }
  console.log(`  timed out after ${tries * 2}s waiting for ${what}`);
  return null;
}

try {
  // ---- seed ----------------------------------------------------------------
  for (const name of ['live-bug', 'live-triage']) {
    const outcome = repoCli(['label', 'create', name, '--color', '#ededed']);
    // `label create` reconciles an existing label rather than duplicating it,
    // so tracking the name unconditionally would make cleanup delete a label
    // the repository already owned.
    if (outcome.created === true) created.labels.push(name);
  }
  const ms = await raw('POST', `repos/${REPO}/milestones`, { title: 'v-live' });
  created.milestone = ms.data?.id ?? null;
  ok('seed milestone', ms.status === 201);

  // ---- create / view -------------------------------------------------------
  const made = repoCli([
    'issue',
    'create',
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
  const edit1 = repoCli([
    'issue',
    'edit',
    String(n),
    '--label',
    'live-bug,live-triage',
  ]);
  ok(
    'edit replaces labels through the labels endpoint',
    edit1.updated === true && edit1.issue.labels.length === 2,
  );
  const edit2 = repoCli([
    'issue',
    'edit',
    String(n),
    '--label',
    'live-bug,live-triage',
  ]);
  ok('repeat edit is a no-op', edit2.updated === false);

  const cleared = repoCli(['issue', 'edit', String(n), '--milestone', '']);
  ok('an empty value clears the milestone', cleared.issue.milestone === null);

  // ---- comment / close / reopen -------------------------------------------
  const commented = repoCli([
    'issue',
    'comment',
    String(n),
    '--body',
    'live comment',
  ]);
  ok('comment returns an identity', Number.isInteger(commented.comment.id));

  const closed = repoCli([
    'issue',
    'close',
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
    repoCli(['issue', 'reopen', String(n)]).issue.state === 'open',
  );
  ok(
    'reopen is idempotent',
    repoCli(['issue', 'reopen', String(n)]).updated === false,
  );

  // ---- filters must actually narrow ----------------------------------------
  // Forgejo answers an unrecognised filter with an unfiltered list, so a filter
  // that silently does nothing looks exactly like one that works.
  const other = repoCli(['issue', 'create', '--title', 'live: unrelated']);
  created.issues.push(other.issue.number);
  const excludesOther = (list) =>
    list.issues.every((i) => i.number !== other.issue.number) &&
    list.issues.some((i) => i.number === n);

  ok(
    'label filter narrows',
    excludesOther(repoCli(['issue', 'list', '--label', 'live-triage'])),
  );
  repoCli(['issue', 'edit', String(n), '--milestone', 'v-live']);
  ok(
    'milestone filter narrows',
    excludesOther(repoCli(['issue', 'list', '--milestone', 'v-live'])),
  );
  const owner = REPO.split('/')[0];
  repoCli(['issue', 'edit', String(n), '--assignee', owner]);
  ok(
    'assignee filter narrows',
    excludesOther(repoCli(['issue', 'list', '--assignee', owner])),
  );
  ok(
    'state filter narrows',
    repoCli(['issue', 'list', '--state', 'closed']).issues.every(
      (i) => i.number !== n,
    ),
  );
  ok(
    'unknown filter label refuses',
    repoCli(['issue', 'list', '--label', 'no-such-label'], {
      allowFail: true,
    }).code === 'LABEL_NOT_FOUND',
  );

  // ---- does this host paginate comments? -----------------------------------
  // The whole thread is read in one request. If a host ever honours page/limit
  // that read silently truncates, so this must be proven per lane.
  const long = repoCli(['issue', 'create', '--title', 'live: comment thread']);
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
  const viewed = repoCli(['issue', 'view', String(t), '--full']);
  ok('issue view returns the whole thread', viewed.comments.length === 55);
  ok(
    'comment_info counts match',
    viewed.comment_info.fetched === 55 && viewed.comment_info.displayed === 55,
  );

  // ---- body preview --------------------------------------------------------
  const big = repoCli([
    'issue',
    'create',
    '--title',
    'live: long body',
    '--body',
    'x'.repeat(600),
  ]);
  created.issues.push(big.issue.number);
  const preview = repoCli(['issue', 'view', String(big.issue.number)]);
  ok(
    'body preview elides at 500 code points',
    preview.issue.body.length === 500 &&
      preview.issue.body.endsWith('...') &&
      preview.issue.body_length === 600 &&
      preview.issue.body_truncated === true,
  );

  // ---- repo view -----------------------------------------------------------
  const repo = repoCli(['repo', 'view']).repository;
  ok(
    'repo view reports canonical identity',
    repo.full_name === REPO &&
      repo.url === `${BASE_URL.replace(/\/$/, '')}/${REPO}`,
  );

  // ---- run family, no runner required ----------------------------------------
  // A real host answers `run list` with {workflow_runs: []} even before any
  // workflow has run — exactly the envelope a hand-written fixture once got
  // wrong, so decode it against the genuine article.
  if (probed.capabilities?.runs === true) {
    const runs = repoCli(['run', 'list']);
    ok(
      'run list decodes the real envelope',
      Array.isArray(runs.runs) && runs.page_info.complete === true,
      `fetched=${runs.runs.length}`,
    );
    const filtered = repoCli([
      'run',
      'list',
      '--status',
      'success',
      '--branch',
      'main',
    ]);
    ok(
      'run list filters are accepted by the host',
      Array.isArray(filtered.runs),
    );
    ok(
      'run view maps a missing run to NOT_FOUND',
      repoCli(['run', 'view', '999999999'], { allowFail: true }).code ===
        'NOT_FOUND',
    );
  } else {
    const unsupported = repoCli(['run', 'list'], {
      allowFail: true,
    });
    ok(
      'run family reports unsupported from the probe',
      unsupported.supported === false && unsupported.capability === 'runs',
    );
  }

  // ---- run family, runner required -----------------------------------------
  // Job logs, artifact download, and the cancel of a genuinely running run are
  // the paths docs/live-test-matrix.md records as uncovered: a fake server can
  // return whatever shape we ask it for, so only a real runner settles them.
  if (RUNNER_LABEL && probed.capabilities?.runs === true) {
    const marker = `live-marker-${BRANCH}`;
    const quick = `${BRANCH}-wf-quick`;
    // Deliberately one step and no action: whether a run reaches success and
    // whether its logs come back must not depend on artifact upload, which
    // reaches the host from inside the job container and so fails for reasons
    // of its own.
    await workflowBranch(
      quick,
      [
        'name: live-quick',
        'on: [push]',
        'jobs:',
        '  quick:',
        `    runs-on: ${RUNNER_LABEL}`,
        '    steps:',
        `      - run: echo "${marker}"`,
        '',
      ].join('\n'),
    );
    const quickRun = await waitForRun(
      quick,
      (run) => TERMINAL_RUN.has(run.status),
      'the seeded workflow to finish',
    );
    ok(
      'a pushed workflow produces a real run',
      quickRun?.status === 'success',
      `status=${quickRun?.status ?? 'none'}`,
    );

    if (quickRun && probed.capabilities?.actions_job_logs === true) {
      const viewed = repoCli(['run', 'view', String(quickRun.id), '--log']);
      const logs = (viewed.jobs ?? []).map((job) => job.log ?? '');
      ok(
        'run view --log decodes real runner output',
        logs.some((log) => log.includes(marker)),
        `jobs=${logs.length}`,
      );
    }

    if (probed.capabilities?.run_artifacts === true) {
      const upload = `${BRANCH}-wf-artifact`;
      // No checkout: the job writes the file it uploads, so this depends on one
      // action rather than two.
      await workflowBranch(
        upload,
        [
          'name: live-artifact',
          'on: [push]',
          'jobs:',
          '  upload:',
          `    runs-on: ${RUNNER_LABEL}`,
          '    steps:',
          `      - run: mkdir -p out && echo "${marker}" > out/live.txt`,
          '      - uses: forgejo/upload-artifact@v4',
          '        with:',
          '          name: live-artifact',
          '          path: out',
          '',
        ].join('\n'),
      );
      const uploadRun = await waitForRun(
        upload,
        (run) => TERMINAL_RUN.has(run.status),
        'the artifact workflow to finish',
      );
      // Upload runs from inside the job container rather than from the runner,
      // so it is the first probe here to need the host reachable from the
      // workflow network.
      ok(
        'a workflow uploads an artifact to the host',
        uploadRun?.status === 'success',
        `status=${uploadRun?.status ?? 'none'}`,
      );

      if (uploadRun?.status === 'success') {
        const dir = await mkdtemp(join(tmpdir(), 'forgejo-axi-live-'));
        try {
          const got = repoCli([
            'run',
            'download',
            String(uploadRun.id),
            '--dir',
            dir,
          ]);
          const [artifact] = got.downloaded ?? [];
          ok(
            'run download writes a real artifact to disk',
            artifact?.name === 'live-artifact' && artifact.size_in_bytes > 0,
            `bytes=${artifact?.size_in_bytes ?? 0}`,
          );
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    }

    if (probed.capabilities?.run_cancel === true) {
      const slow = `${BRANCH}-wf-sleep`;
      await workflowBranch(
        slow,
        [
          'name: live-sleep',
          'on: [push]',
          'jobs:',
          '  slow:',
          `    runs-on: ${RUNNER_LABEL}`,
          '    steps:',
          '      - run: sleep 120',
          '',
        ].join('\n'),
      );
      const running = await waitForRun(
        slow,
        (run) => run.status === 'running',
        'the sleeping workflow to start',
      );
      ok('a seeded workflow reaches running', running !== null);

      if (running) {
        const stopped = repoCli(['run', 'cancel', String(running.id)]);
        ok(
          'run cancel stops a genuinely running run',
          stopped.cancelled === true,
          `status=${stopped.run?.status}`,
        );
        const settled = await waitForRun(
          slow,
          (run) => TERMINAL_RUN.has(run.status),
          'the cancelled run to settle',
        );
        const repeat = repoCli(['run', 'cancel', String(running.id)], {
          allowFail: true,
        });
        ok(
          'cancelling a finished run is the contracted no-op',
          repeat.cancelled === false && repeat.run?.status === settled?.status,
          `status=${repeat.run?.status}`,
        );
        // The CLI now returns before sending this, so only a direct call can
        // say what the host would have answered. Recorded rather than asserted:
        // both answers are legitimate, and which one it is decides whether the
        // pre-check needs to grow a CONFLICT recovery for the run that finishes
        // between the read and the POST.
        const direct = await globalThis.fetch(
          `${API}/repos/${REPO}/actions/runs/${running.id}/cancel`,
          { method: 'POST', headers: { authorization: `token ${TOKEN}` } },
        );
        ok(
          'host answered a redundant cancel of a finished run',
          direct.status > 0,
          `http=${direct.status} (2xx: the old unconditional POST was safe)`,
        );
      }
    }
  } else if (!RUNNER_LABEL) {
    console.log(
      'runner probes skipped — set FORGEJO_LIVE_RUNNER_LABEL to a label the ' +
        'repository runner advertises',
    );
  }

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
    if (made.data?.id) created.labelIds.push(made.data.id);
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

  const allLabels = repoCli(['label', 'list', '--full']);
  const listedNames = new Set(allLabels.labels.map((l) => l.name));
  ok(
    'label list crosses the page boundary',
    allLabels.page_info.complete === true &&
      paged.every((name) => listedNames.has(name)),
    `fetched=${allLabels.page_info.fetched}`,
  );

  ok(
    'label edit updates in place',
    repoCli(['label', 'edit', 'live-triage', '--description', 'live edited'])
      .updated === true,
  );

  // ---- pull request lane ---------------------------------------------------
  await raw('POST', `repos/${REPO}/contents/${BRANCH}-base.txt`, {
    content: Buffer.from('base\n').toString('base64'),
    message: 'live: seed base',
  });
  await probeBranch(BRANCH);

  const pr = repoCli([
    'pr',
    'create',
    '--head',
    BRANCH,
    '--base',
    'main',
    '--title',
    'live: probe',
  ]);
  const PULL = pr.pull_request?.number ?? null;
  if (PULL !== null) created.pulls.push(PULL);
  ok('open a pull request', Number.isInteger(PULL));

  const posted = repoCli([
    'issue',
    'comment',
    String(PULL),
    '--body',
    'live: threaded into PR discussion',
  ]);
  ok(
    'issue comment accepts a pull request number',
    Number.isInteger(posted.comment?.id),
  );
  const prThread = await raw('GET', `repos/${REPO}/issues/${PULL}/comments`);
  ok(
    'the comment lands in the pull request discussion',
    prThread.data.some((c) => c.body === 'live: threaded into PR discussion') &&
      prThread.data.some((c) => Boolean(c.pull_request_url)),
  );
  ok(
    'issue view flags a pull request',
    repoCli(['issue', 'view', String(PULL)]).issue.is_pull_request === true,
  );

  // Only meaningful once a pull request exists, and only if the field is
  // actually selected — the default schema omits it, so asking without
  // --fields would compare against undefined and prove nothing.
  const listed = repoCli([
    'issue',
    'list',
    '--full',
    '--fields',
    'number,is_pull_request',
  ]);
  ok(
    'issue list excludes pull requests',
    listed.issues.length > 0 &&
      listed.issues.every((i) => i.is_pull_request === false) &&
      !listed.issues.some((i) => i.number === PULL),
  );

  // ---- pull request reads --------------------------------------------------
  ok(
    'pr list includes the open pull request',
    repoCli(['pr', 'list', '--full']).pull_requests.some(
      (p) => p.number === PULL,
    ),
  );
  ok(
    'pr find locates it by head branch',
    repoCli(['pr', 'find', '--head', BRANCH]).pull_request.number === PULL,
  );
  const prView = repoCli(['pr', 'view', String(PULL)]).pull_request;
  ok('pr view reports the head sha', /^[0-9a-f]{40}$/.test(prView.head_sha));
  ok(
    'pr update changes the title',
    repoCli(['pr', 'update', String(PULL), '--title', 'live: probe (updated)'])
      .pull_request.title === 'live: probe (updated)',
  );

  // ---- checks against real commit statuses ---------------------------------
  // An empty status set must read as none, never as a failure — a host without
  // Actions has no statuses to report and that is not a red check.
  const empty = repoCli(['pr', 'checks', String(PULL)]);
  ok(
    'no statuses reads as none, not failure',
    empty.checks.reported === 0 && empty.checks.state === 'none',
    `state=${empty.checks.state}`,
  );

  await seedStatus(prView.head_sha, 'success', 'live/probe');
  const green = repoCli(['pr', 'checks', String(PULL)]);
  ok(
    'pr checks aggregates a real commit status',
    green.checks.reported === 1 &&
      green.checks.state === 'success' &&
      green.checks.statuses.some((s) => s.context === 'live/probe'),
    `reported=${green.checks.reported} state=${green.checks.state}`,
  );
  const mergeability = repoCli(['pr', 'mergeability', String(PULL)]);
  ok(
    'mergeability reflects the real head and checks',
    mergeability.mergeability.head_sha === prView.head_sha &&
      mergeability.mergeability.checks_pass === true,
    `mergeable=${mergeability.mergeability.mergeable}`,
  );

  // ---- reviews and diff (read-only) ----------------------------------------
  const noReviews = repoCli(['pr', 'reviews', String(PULL)]);
  ok(
    'a pull request with no reviews lists none',
    noReviews.reviews.length === 0 && noReviews.page_info.fetched === 0,
    `fetched=${noReviews.page_info.fetched}`,
  );

  const diff = repoCli(['pr', 'diff', String(PULL)]);
  ok(
    'pr diff returns the diff Forgejo generates for the pull request',
    diff.diff.includes('diff --git') &&
      diff.diff.includes(`${BRANCH}.txt`) &&
      diff.diff_info.lines > 0,
    `lines=${diff.diff_info.lines}`,
  );

  // Forgejo refuses to let an author approve their own pull request but accepts
  // a COMMENT review, which is what proves the verdict and the file-anchored
  // comment survive the round trip.
  const submitted = await raw('POST', `repos/${REPO}/pulls/${PULL}/reviews`, {
    event: 'COMMENT',
    body: 'live probe review',
    comments: [
      { path: `${BRANCH}.txt`, new_position: 1, body: 'live inline probe' },
    ],
  });
  ok(
    'submit a COMMENT review on our own pull request',
    submitted.status === 200,
    `status=${submitted.status}`,
  );
  const reviewed = repoCli(['pr', 'reviews', String(PULL)]);
  const probe = reviewed.reviews.find(
    (review) => review.body === 'live probe review',
  );
  ok(
    'pr reviews reports the reviewer, the verdict and the anchored comment',
    probe?.state === 'COMMENT' &&
      typeof probe.user === 'string' &&
      probe.comments.some((comment) => comment.path === `${BRANCH}.txt`),
    `state=${probe?.state} comments=${probe?.comments.length}`,
  );

  // The expected-head guard must refuse a stale head rather than merge it.
  const raced = repoCli(
    ['pr', 'merge', String(PULL), '--expected-head', '0'.repeat(40)],
    { allowFail: true },
  );
  const stillOpen = await raw('GET', `repos/${REPO}/pulls/${PULL}`);
  ok(
    'expected-head refuses a stale head without merging',
    raced.code === 'HEAD_CHANGED' && stillOpen.data?.merged === false,
    String(raced.code),
  );

  ok('forgejo settles mergeability in the background', await settle(PULL));

  // ...and must go through when the head is the one we proved.
  const merge = await mergeWhenReady(PULL, 'squash', prView.head_sha);
  const afterMerge = await raw('GET', `repos/${REPO}/pulls/${PULL}`);
  ok(
    'expected-head merges when the head matches',
    Boolean(merge.proof) && afterMerge.data?.merged === true,
    String(merge.code ?? 'merged'),
  );
  ok(
    'pr merged proves the merge independently',
    Boolean(repoCli(['pr', 'merged', String(PULL)]).proof),
  );

  // ---- the merge methods other than squash ---------------------------------
  // Forgejo implements each `Do` value differently, so proving squash proves
  // nothing about the other two. Each still goes through the expected-head guard.
  for (const method of ['merge', 'rebase']) {
    const branch = `${BRANCH}-${method}`;
    await probeBranch(branch);
    const opened = repoCli([
      'pr',
      'create',
      '--head',
      branch,
      '--base',
      'main',
      '--title',
      `live: ${method}`,
    ]);
    const number = opened.pull_request.number;
    created.pulls.push(number);
    const merged = await mergeWhenReady(
      number,
      method,
      opened.pull_request.head_sha,
    );
    const after = await raw('GET', `repos/${REPO}/pulls/${number}`);
    ok(
      `pr merge --method ${method} merges behind a proven head`,
      merged.proof?.merged === true && after.data?.merged === true,
      `merge_commit=${merged.proof?.merge_commit_sha ? 'yes' : 'none'}`,
    );
  }

  // ---- pr create reconciles rather than duplicating ------------------------
  const reconcileBranch = `${BRANCH}-reconcile`;
  await probeBranch(reconcileBranch);
  const openArgs = [
    'pr',
    'create',
    '--head',
    reconcileBranch,
    '--base',
    'main',
    '--body',
    'reconcile probe',
  ];
  const firstOpen = repoCli([...openArgs, '--title', 'live: reconcile']);
  created.pulls.push(firstOpen.pull_request.number);
  ok(
    'pr create opens a new pull request',
    firstOpen.created === true && firstOpen.updated === false,
  );
  const repeated = repoCli([...openArgs, '--title', 'live: reconcile']);
  ok(
    'pr create against the desired state is exit 0 and mutation-free',
    repeated.created === false &&
      repeated.updated === false &&
      repeated.pull_request.number === firstOpen.pull_request.number,
  );
  const retitled = repoCli([...openArgs, '--title', 'live: reconcile (moved)']);
  ok(
    'pr create reconciles a differing title onto the existing pull request',
    retitled.created === false &&
      retitled.updated === true &&
      retitled.pull_request.number === firstOpen.pull_request.number &&
      retitled.pull_request.title === 'live: reconcile (moved)',
  );

  // Forgejo refuses a second pull request for the same head and base with 409,
  // which is the conflict `pr create` absorbs instead of failing on. Proving the
  // absorption needs a pull request this CLI did not open, so it is created out
  // of band first.
  const adoptBranch = `${BRANCH}-adopt`;
  await probeBranch(adoptBranch);
  const outOfBand = await raw('POST', `repos/${REPO}/pulls`, {
    title: 'live: opened out of band',
    head: adoptBranch,
    base: 'main',
  });
  if (!Number.isInteger(outOfBand.data?.number)) {
    throw new Error(
      `could not open a pull request out of band => ${outOfBand.status}`,
    );
  }
  created.pulls.push(outOfBand.data.number);
  const adopted = repoCli([
    'pr',
    'create',
    '--head',
    adoptBranch,
    '--base',
    'main',
    '--title',
    'live: opened out of band',
  ]);
  ok(
    'pr create reconciles onto a pull request it did not open',
    adopted.created === false &&
      adopted.updated === false &&
      adopted.pull_request.number === outOfBand.data.number,
    `number=${adopted.pull_request?.number}`,
  );

  // Forgejo's duplicate check is a read followed by an insert with no unique
  // constraint behind it, so fully overlapping creates all pass the check and
  // all succeed — the host answers 409 only once a previous create has landed.
  // Race recovery cannot absorb a conflict Forgejo never raises; what the CLI
  // must not do is fail. The note records how many rows the host actually made.
  const raceBranch = `${BRANCH}-race`;
  await probeBranch(raceBranch);
  const racers = await Promise.all(
    [0, 1, 2].map(() =>
      cliConcurrent(
        withRepo([
          'pr',
          'create',
          '--head',
          raceBranch,
          '--base',
          'main',
          '--title',
          'live: race',
        ]),
      ),
    ),
  );
  const raceNumbers = [
    ...new Set(
      racers.map((r) => r.pull_request?.number).filter(Number.isInteger),
    ),
  ];
  created.pulls.push(...raceNumbers);
  ok(
    'concurrent pr create returns a pull request to every caller',
    racers.every((r) => Number.isInteger(r.pull_request?.number)),
    `pull_requests=${raceNumbers.length}`,
  );

  // ---- required contexts against real branch protection --------------------
  // Required-context semantics come from the base branch's protection rule, so
  // the only way to prove them is to provision one and take it down again.
  const protBase = `${BRANCH}-protected`;
  const protHead = `${BRANCH}-protected-head`;
  await probeBranch(protBase);
  const protection = await raw('POST', `repos/${REPO}/branch_protections`, {
    branch_name: protBase,
    enable_status_check: true,
    status_check_contexts: ['live/required'],
  });
  if (protection.status === 201) created.protection = protBase;
  ok(
    'provision a protected base branch with a required context',
    protection.status === 201,
    `status=${protection.status}`,
  );
  await probeBranch(protHead, protBase);
  const protPull = repoCli([
    'pr',
    'create',
    '--head',
    protHead,
    '--base',
    protBase,
    '--title',
    'live: required contexts',
  ]);
  const protNumber = protPull.pull_request.number;
  const protSha = protPull.pull_request.head_sha;
  created.pulls.push(protNumber);
  const protChecks = () => repoCli(['pr', 'checks', String(protNumber)]).checks;

  const missing = protChecks();
  ok(
    'checks read protection from the real base branch',
    missing.protection.protected === true &&
      missing.protection.status_checks_enabled === true &&
      missing.protection.rule === protBase,
    `rule=${missing.protection.rule}`,
  );
  ok(
    'a required context nothing has reported is missing',
    missing.required_state === 'missing' &&
      missing.passes === false &&
      missing.required.some(
        (item) => item.context === 'live/required' && item.state === 'missing',
      ),
    `required_state=${missing.required_state}`,
  );

  // The assertion that matters: a green status on some other context must not
  // let a missing required context read as a pass.
  await seedStatus(protSha, 'success', 'live/unrelated');
  const unrelated = protChecks();
  ok(
    'an unrelated green status leaves the required context missing',
    unrelated.state === 'success' &&
      unrelated.required_state === 'missing' &&
      unrelated.passes === false,
    `state=${unrelated.state} required_state=${unrelated.required_state}`,
  );

  // Forgejo timestamps a status to the second, so each transition is separated
  // enough that the newest one is unambiguous.
  for (const state of ['pending', 'failure', 'success']) {
    await sleep(1100);
    await seedStatus(protSha, state, 'live/required');
    const current = protChecks();
    ok(
      `a ${state} required context reports ${state}`,
      current.required_state === state &&
        current.passes === (state === 'success'),
      `required_state=${current.required_state} passes=${current.passes}`,
    );
  }

  // ---- label reconcile, collisions and archived state ----------------------
  const reconcileLabel = 'live-reconcile';
  const madeLabel = repoCli([
    'label',
    'create',
    reconcileLabel,
    '--color',
    '#ededed',
    '--description',
    'first',
  ]);
  if (madeLabel.created === true) created.labels.push(reconcileLabel);
  ok('label create opens a new label', madeLabel.created === true);
  const sameLabel = repoCli([
    'label',
    'create',
    reconcileLabel,
    '--color',
    '#ededed',
    '--description',
    'first',
  ]);
  ok(
    'label create against the desired state is exit 0 and mutation-free',
    sameLabel.created === false && sameLabel.updated === false,
  );
  const recolored = repoCli([
    'label',
    'create',
    reconcileLabel,
    '--color',
    '#00aabb',
  ]);
  ok(
    'label create reconciles a differing color onto the existing label',
    recolored.created === false &&
      recolored.updated === true &&
      recolored.label.color === '#00aabb',
    `color=${recolored.label?.color}`,
  );
  const collided = repoCli(
    ['label', 'edit', reconcileLabel, '--name', 'live-bug'],
    { allowFail: true },
  );
  ok(
    'renaming a label onto a name the repository carries is refused',
    collided.code === 'LABEL_EXISTS',
    String(collided.code),
  );

  // Forgejo does not enforce label-name uniqueness, so an ambiguous name has to
  // be reported rather than silently resolved to whichever row came first.
  const duplicated = [];
  for (let i = 0; i < 2; i += 1) {
    const made = await raw('POST', `repos/${REPO}/labels`, {
      name: 'live-duplicate',
      color: '#ededed',
    });
    if (made.data?.id) {
      duplicated.push(made.data.id);
      created.labelIds.push(made.data.id);
    }
  }
  const ambiguous = repoCli(
    ['label', 'edit', 'live-duplicate', '--description', 'x'],
    { allowFail: true },
  );
  ok(
    'an ambiguous label name reports both ids',
    duplicated.length === 2 &&
      ambiguous.code === 'LABEL_AMBIGUOUS' &&
      duplicated.every((id) => ambiguous.details?.ids?.includes(id)),
    `code=${ambiguous.code} ids=${JSON.stringify(ambiguous.details?.ids)}`,
  );

  // Forgejo re-derives archived state from every edit request, so an edit that
  // forgets to resend it silently unarchives the label.
  const archived = await raw('POST', `repos/${REPO}/labels`, {
    name: 'live-archived',
    color: '#ededed',
  });
  if (!Number.isInteger(archived.data?.id)) {
    throw new Error(`could not seed an archived label => ${archived.status}`);
  }
  created.labelIds.push(archived.data.id);
  await raw('PATCH', `repos/${REPO}/labels/${archived.data.id}`, {
    is_archived: true,
  });
  const editedArchived = repoCli([
    'label',
    'edit',
    'live-archived',
    '--description',
    'still archived',
  ]);
  ok(
    'editing an archived label preserves is_archived',
    editedArchived.updated === true &&
      editedArchived.label.is_archived === true &&
      editedArchived.label.description === 'still archived',
    `is_archived=${editedArchived.label?.is_archived}`,
  );

  // ---- api write verbs -----------------------------------------------------
  const apiCreated = cli([
    'api',
    'POST',
    `repos/${REPO}/labels`,
    '--data',
    JSON.stringify({ name: 'live-api', color: '#ededed' }),
  ]);
  const apiLabelId = apiCreated.data?.id;
  if (Number.isInteger(apiLabelId)) created.labelIds.push(apiLabelId);
  ok(
    'api POST sends --data as the request body',
    apiCreated.status === 201 && apiCreated.data?.name === 'live-api',
    `status=${apiCreated.status}`,
  );
  const apiPatched = cli([
    'api',
    'PATCH',
    `repos/${REPO}/labels/${apiLabelId}`,
    '--data',
    JSON.stringify({ description: 'via api' }),
  ]);
  ok(
    'api PATCH sends --data as the request body',
    apiPatched.status === 200 && apiPatched.data?.description === 'via api',
    `status=${apiPatched.status}`,
  );
  const apiDeleted = cli([
    'api',
    'DELETE',
    `repos/${REPO}/labels/${apiLabelId}`,
  ]);
  ok(
    'api DELETE returns an empty success',
    apiDeleted.status === 204 && apiDeleted.data === null,
    `status=${apiDeleted.status}`,
  );
  const refused = cli(
    ['api', 'GET', `repos/${REPO}/labels`, '--paginate', '--data', '{}'],
    { allowFail: true },
  );
  ok(
    'api refuses to combine --data with --paginate',
    refused.code === 'VALIDATION_ERROR',
    String(refused.code),
  );
} catch (error) {
  ok('RUN ABORTED', false, String(error.message).slice(0, 400));
} finally {
  let removed = 0;
  let removedPulls = 0;
  for (const number of created.pulls) {
    await discard('PATCH', `repos/${REPO}/pulls/${number}`, {
      state: 'closed',
    });
    const gone = await discard('DELETE', `repos/${REPO}/issues/${number}`);
    if (gone.status === 204) removedPulls += 1;
  }
  for (const number of created.issues) {
    const gone = await discard('DELETE', `repos/${REPO}/issues/${number}`);
    if (gone.status === 204) removed += 1;
  }
  for (const name of created.labels) {
    try {
      repoCli(['label', 'delete', name]);
    } catch {
      /* best effort */
    }
  }
  // A duplicated or archived name cannot be addressed by name, so these go by id.
  for (const id of created.labelIds)
    await discard('DELETE', `repos/${REPO}/labels/${id}`);
  if (created.milestone)
    await discard('DELETE', `repos/${REPO}/milestones/${created.milestone}`);
  // Protection has to go before the branch it protects, or the branch survives.
  // A leak here is the one the next run cannot clean up for itself, so it is
  // reported rather than swallowed the way the label teardown is.
  const leaked = [];
  if (created.protection) {
    const gone = await discard(
      'DELETE',
      `repos/${REPO}/branch_protections/${created.protection}`,
    );
    if (gone.status !== 204) leaked.push(`protection ${created.protection}`);
  }
  for (const branch of created.branches) {
    const gone = await discard('DELETE', `repos/${REPO}/branches/${branch}`);
    if (gone.status !== 204) leaked.push(`branch ${branch}`);
  }
  // A merged branch leaves its file behind on the base. Every name carries the
  // per-run branch prefix, so cleanup can never reach a file that predates this
  // run.
  for (const file of [
    `${BRANCH}-base.txt`,
    ...created.branches.map((branch) => `${branch}.txt`),
  ]) {
    const head = await discard('GET', `repos/${REPO}/contents/${file}`);
    if (head.data?.sha)
      await discard('DELETE', `repos/${REPO}/contents/${file}`, {
        message: 'live: cleanup',
        sha: head.data.sha,
      });
  }
  ok(
    'cleanup removed every created issue',
    removed === created.issues.length,
    `${removed}/${created.issues.length}`,
  );
  ok(
    'cleanup removed every created pull request',
    removedPulls === created.pulls.length,
    `${removedPulls}/${created.pulls.length}`,
  );
  ok(
    'cleanup removed every branch and its protection',
    leaked.length === 0,
    leaked.join(', ') || `${created.branches.length} branches`,
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
