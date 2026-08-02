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
    const glob = compileContextPattern(pattern);
    const matched = statuses.filter((status) => glob.test(status.context));
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
 * Forgejo logs and drops a pattern gobwas rejects, so a malformed rule cannot
 * block a merge there. Here it matches nothing and reads `missing`, which
 * blocks. That is the fail-closed direction and it surfaces the broken rule
 * rather than ignoring it.
 */
function compileContextPattern(pattern: string): RegExp {
  const NEVER = /(?!)/;
  let source = '';
  let depth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '\\') {
      if (index + 1 >= pattern.length) return NEVER;
      index += 1;
      source += escapeLiteral(pattern[index] as string);
    } else if (char === '*') {
      // Without a separator gobwas treats `**` exactly as `*`; collapsing the
      // run also keeps the expression from backtracking over itself.
      while (pattern[index + 1] === '*') index += 1;
      source += '[\\s\\S]*';
    } else if (char === '?') {
      source += '[\\s\\S]';
    } else if (char === '{') {
      depth += 1;
      source += '(?:';
    } else if (char === ',' && depth > 0) {
      source += '|';
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      source += ')';
    } else if (char === '[') {
      const compiled = compileClass(pattern, index);
      if (!compiled) return NEVER;
      source += compiled.source;
      index = compiled.end;
    } else {
      source += escapeLiteral(char);
    }
  }
  if (depth > 0) return NEVER;
  return new RegExp(`^${source}$`);
}

/** Reads one `[...]` class, or null if the pattern gobwas would reject. */
function compileClass(
  pattern: string,
  start: number,
): { source: string; end: number } | null {
  let index = start + 1;
  const negated = pattern[index] === '!';
  if (negated) index += 1;
  let body = '';
  for (; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === ']') {
      // gobwas requires a non-empty class.
      return body
        ? { source: `[${negated ? '^' : ''}${body}]`, end: index }
        : null;
    }
    if (char === '\\') {
      if (index + 1 >= pattern.length) return null;
      index += 1;
      body += escapeClassChar(pattern[index] as string);
      continue;
    }
    // `-` stays bare so `a-z` is a range; at either edge JS reads it as a
    // literal, which is what gobwas does there too.
    body += char === '-' ? '-' : escapeClassChar(char);
  }
  return null;
}

function escapeLiteral(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function escapeClassChar(char: string): string {
  return /[\\\]^]/.test(char) ? `\\${char}` : char;
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
