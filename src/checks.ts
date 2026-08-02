/** Commit status as Forgejo reports it; the CLI calls these Checks. */
export interface ApiStatus {
  id?: number;
  context?: string;
  status?: string;
  target_url?: string;
  description?: string;
  updated_at?: string;
}

export interface ApiBranch {
  name?: string;
  protected?: boolean;
  effective_branch_protection_name?: string;
  enable_status_check?: boolean;
  status_check_contexts?: string[];
}

type CheckState = 'none' | 'pending' | 'failure' | 'success';
type RequiredState =
  'not_required' | 'missing' | 'pending' | 'failure' | 'success';

interface NormalizedStatus {
  context: string;
  state: Exclude<CheckState, 'none'>;
  description: string | null;
  target_url: string | null;
  updated_at: string | null;
}

interface RequiredCheck {
  context: string;
  state: Exclude<RequiredState, 'not_required'>;
  matched: string[];
}

export interface ChecksResult {
  sha: string;
  reported: number;
  state: CheckState;
  statuses: NormalizedStatus[];
  required: RequiredCheck[];
  required_state: RequiredState;
  passes: boolean;
  protection: {
    protected: boolean;
    rule: string | null;
    status_checks_enabled: boolean;
  };
}

/**
 * Decides whether a pull request passes its Checks. Takes what the two API
 * routes returned and performs no I/O of its own.
 */
export function evaluateChecks(
  sha: string,
  input: ApiStatus[],
  branch: ApiBranch,
): ChecksResult {
  const statuses = latestStatuses(input);
  const statusChecksEnabled = branch.enable_status_check === true;
  const patterns = statusChecksEnabled
    ? (branch.status_check_contexts ?? [])
    : [];
  const required: RequiredCheck[] = patterns.map((pattern) => {
    const matchesPattern = compileContextPattern(pattern);
    const matched = statuses.filter((status) => matchesPattern(status.context));
    return {
      context: pattern,
      state:
        matched.length === 0
          ? 'missing'
          : worstState(matched.map((status) => status.state)),
      matched: matched.map((status) => status.context),
    };
  });
  const state =
    statuses.length === 0
      ? 'none'
      : worstState(statuses.map((status) => status.state));
  const requiredState: RequiredState =
    required.length === 0
      ? 'not_required'
      : worstRequired(required.map((item) => item.state));
  return {
    sha,
    reported: statuses.length,
    state,
    statuses,
    required,
    required_state: requiredState,
    passes:
      requiredState === 'not_required'
        ? state === 'success'
        : requiredState === 'success',
    protection: {
      protected: branch.protected ?? false,
      rule: branch.effective_branch_protection_name ?? null,
      status_checks_enabled: statusChecksEnabled,
    },
  };
}

type ClassRange = { lo: number; hi: number };

type PatternToken =
  | { kind: 'literal'; rune: string }
  | { kind: 'any' }
  | { kind: 'star' }
  | { kind: 'class'; negated: boolean; ranges: ClassRange[] }
  | { kind: 'alternation'; options: PatternToken[][] };

type BraceFrame = { options: PatternToken[][]; current: PatternToken[] };

/** A pattern gobwas rejects outright, which can then match nothing. */
const NEVER = () => false;

/**
 * Compiles one required-context pattern the way Forgejo matches it.
 *
 * Forgejo compiles required contexts with `glob.Compile(pattern)` and no
 * separator argument, so `*` and `?` cross `/` and a leading dot carries no
 * special meaning. minimatch cannot be configured to cross a separator, so the
 * dialect is compiled here rather than delegated. Live-probed on Forgejo 15
 * and 16.
 *
 * Without separators `*` and `**` both match any run of characters, `?`
 * matches any one character, `[abc]`, `[a-z]` and `[!abc]` are classes,
 * `{a,b}` alternates, and `\` escapes the next character. Everything else is a
 * literal.
 *
 * The pattern becomes tokens rather than a `RegExp` for two reasons. gobwas
 * matches runes, so `?` there covers an astral character a UTF-16 class would
 * split in half. And a glob translated to a backtracking expression is
 * exponential on patterns like `*a*a*a*x`, which a commit status could reach
 * because it names its own context; walking a set of reachable positions is
 * linear in the context per token instead.
 *
 * Forgejo logs and drops a pattern gobwas rejects, so a malformed rule cannot
 * block a merge there. Here it matches nothing and reads `missing`, which
 * blocks. That is the fail-closed direction and it surfaces the broken rule
 * rather than ignoring it. A reversed range like `[z-a]` is not rejected by
 * either side — gobwas builds a range nothing satisfies, and so does this.
 */
function compileContextPattern(pattern: string): (value: string) => boolean {
  const runes = Array.from(pattern);
  const root: PatternToken[] = [];
  const open: BraceFrame[] = [];
  let current = root;
  for (let index = 0; index < runes.length; index += 1) {
    const rune = runes[index] as string;
    if (rune === '\\') {
      if (index + 1 >= runes.length) return NEVER;
      index += 1;
      current.push({ kind: 'literal', rune: runes[index] as string });
    } else if (rune === '*') {
      // Without a separator gobwas treats `**` exactly as `*`.
      while (runes[index + 1] === '*') index += 1;
      current.push({ kind: 'star' });
    } else if (rune === '?') {
      current.push({ kind: 'any' });
    } else if (rune === '{') {
      const frame: BraceFrame = { options: [], current: [] };
      open.push(frame);
      current = frame.current;
    } else if (rune === ',' && open.length > 0) {
      const frame = open[open.length - 1] as BraceFrame;
      frame.options.push(frame.current);
      frame.current = [];
      current = frame.current;
    } else if (rune === '}' && open.length > 0) {
      const frame = open.pop() as BraceFrame;
      frame.options.push(frame.current);
      const parent = open[open.length - 1]?.current ?? root;
      parent.push({ kind: 'alternation', options: frame.options });
      current = parent;
    } else if (rune === '[') {
      const parsed = parseClass(runes, index);
      if (!parsed) return NEVER;
      current.push(parsed.token);
      index = parsed.end;
    } else {
      current.push({ kind: 'literal', rune });
    }
  }
  if (open.length > 0) return NEVER;
  return (value) => {
    const target = Array.from(value);
    return advance(root, target, new Set([0])).has(target.length);
  };
}

/**
 * Walks `tokens` from every reachable position at once, so a pattern with
 * several stars costs one pass per token rather than one per way of splitting
 * the value between them.
 */
function advance(
  tokens: PatternToken[],
  runes: string[],
  starts: Set<number>,
): Set<number> {
  let positions = starts;
  for (const token of tokens) {
    if (positions.size === 0) return positions;
    const next = new Set<number>();
    if (token.kind === 'star') {
      // A star reaches every position at or after the earliest one open to it.
      const from = Math.min(...positions);
      for (let at = from; at <= runes.length; at += 1) next.add(at);
    } else if (token.kind === 'alternation') {
      for (const option of token.options) {
        for (const end of advance(option, runes, positions)) next.add(end);
      }
    } else {
      for (const at of positions) {
        const rune = runes[at];
        if (rune !== undefined && accepts(token, rune)) next.add(at + 1);
      }
    }
    positions = next;
  }
  return positions;
}

function accepts(token: PatternToken, rune: string): boolean {
  if (token.kind === 'any') return true;
  if (token.kind === 'literal') return token.rune === rune;
  if (token.kind !== 'class') return false;
  const code = rune.codePointAt(0) as number;
  const inside = token.ranges.some(
    (range) => code >= range.lo && code <= range.hi,
  );
  return token.negated ? !inside : inside;
}

/** Reads one `[...]` class, or null if the pattern gobwas would reject. */
function parseClass(
  runes: string[],
  start: number,
): { token: PatternToken; end: number } | null {
  let index = start + 1;
  const negated = runes[index] === '!';
  if (negated) index += 1;
  const entries: { rune: string; escaped: boolean }[] = [];
  for (; index < runes.length; index += 1) {
    const rune = runes[index] as string;
    if (rune === ']') {
      // gobwas requires a non-empty class.
      if (entries.length === 0) return null;
      return { token: buildClass(negated, entries), end: index };
    }
    if (rune === '\\') {
      if (index + 1 >= runes.length) return null;
      index += 1;
      entries.push({ rune: runes[index] as string, escaped: true });
      continue;
    }
    entries.push({ rune, escaped: false });
  }
  return null;
}

function buildClass(
  negated: boolean,
  entries: { rune: string; escaped: boolean }[],
): PatternToken {
  const ranges: ClassRange[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const lo = entries[index] as (typeof entries)[number];
    const dash = entries[index + 1];
    const hi = entries[index + 2];
    // A bare `-` between two members is a range; at either edge it is a member
    // in its own right, which is what gobwas does there too.
    if (dash && !dash.escaped && dash.rune === '-' && hi) {
      ranges.push({ lo: codeOf(lo.rune), hi: codeOf(hi.rune) });
      index += 2;
      continue;
    }
    ranges.push({ lo: codeOf(lo.rune), hi: codeOf(lo.rune) });
  }
  return { kind: 'class', negated, ranges };
}

function codeOf(rune: string): number {
  return rune.codePointAt(0) as number;
}

function latestStatuses(input: ApiStatus[]): NormalizedStatus[] {
  const latest = new Map<string, { status: ApiStatus; index: number }>();
  input.forEach((status, index) => {
    const context = status.context ?? '';
    if (!context) return;
    const previous = latest.get(context);
    if (
      !previous ||
      isNewerStatus(status, index, previous.status, previous.index)
    ) {
      latest.set(context, { status, index });
    }
  });
  return [...latest.entries()]
    .map(([context, { status }]) => ({
      context,
      state: normalizeStatus(status.status),
      description: status.description ?? null,
      target_url: status.target_url ?? null,
      updated_at: status.updated_at ?? null,
    }))
    .sort((left, right) => left.context.localeCompare(right.context));
}

function isNewerStatus(
  candidate: ApiStatus,
  candidateIndex: number,
  previous: ApiStatus,
  previousIndex: number,
): boolean {
  const candidateTime = Date.parse(candidate.updated_at ?? '');
  const previousTime = Date.parse(previous.updated_at ?? '');
  if (Number.isFinite(candidateTime) && Number.isFinite(previousTime)) {
    return candidateTime > previousTime;
  }
  if (candidate.id !== undefined && previous.id !== undefined) {
    return candidate.id > previous.id;
  }
  // Last resort for rows carrying neither a parseable timestamp nor an id.
  // ForgejoService.checksForPull requests sort=recentupdate, and Forgejo also
  // answers newest-first without one, so earlier entries are newer either way.
  return candidateIndex < previousIndex;
}

function normalizeStatus(
  state: string | undefined,
): Exclude<CheckState, 'none'> {
  if (state === 'success') return 'success';
  if (state === 'pending') return 'pending';
  return 'failure';
}

function worstState(
  states: Array<Exclude<CheckState, 'none'>>,
): Exclude<CheckState, 'none'> {
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  return 'success';
}

function worstRequired(
  states: Array<Exclude<RequiredState, 'not_required'>>,
): Exclude<RequiredState, 'not_required'> {
  if (states.includes('failure')) return 'failure';
  if (states.includes('missing')) return 'missing';
  if (states.includes('pending')) return 'pending';
  return 'success';
}
