import { minimatch } from 'minimatch';
import { appendPath, type ConnectionConfig } from './config.js';
import { ForgejoAxiError, usageError } from './errors.js';
import {
  ForgejoHttpClient,
  type Paginated,
  type HttpResponse,
} from './http.js';

interface ApiUser {
  login?: string;
}

interface ApiBranchInfo {
  ref?: string;
  sha?: string;
}

interface ApiPullRequest {
  number?: number;
  state?: string;
  draft?: boolean;
  title?: string;
  body?: string;
  head?: ApiBranchInfo;
  base?: ApiBranchInfo;
  mergeable?: boolean;
  merged?: boolean;
  merge_commit_sha?: string;
  merged_at?: string;
  merged_by?: ApiUser;
}

interface ApiRepository {
  full_name?: string;
  description?: string;
  private?: boolean;
  archived?: boolean;
  default_branch?: string;
  has_actions?: boolean;
  has_pull_requests?: boolean;
  open_pr_counter?: number;
}

interface ApiStatus {
  id?: number;
  context?: string;
  status?: string;
  target_url?: string;
  description?: string;
  updated_at?: string;
}

interface ApiBranch {
  name?: string;
  protected?: boolean;
  effective_branch_protection_name?: string;
  enable_status_check?: boolean;
  status_check_contexts?: string[];
}

interface ApiLabel {
  id?: number;
  name?: string;
  color?: string;
  description?: string;
}

export interface RepositoryRef {
  owner: string;
  name: string;
  fullName: string;
}

export interface PullRequestIdentity {
  number: number;
  url: string;
  api_url: string;
  state: string;
  draft: boolean;
  title: string;
  head: string;
  base: string;
  head_sha: string;
  mergeable: boolean | null;
  merged: boolean;
  merge_commit_sha: string | null;
  merged_at: string | null;
  merged_by: string | null;
}

export interface LabelIdentity {
  id: number;
  name: string;
  color: string;
  description: string;
  api_url: string;
}

export interface LabelInput {
  color?: string;
  description?: string;
}

type CheckState = 'none' | 'pending' | 'failure' | 'success';
type RequiredState =
  | 'not_required'
  | 'missing'
  | 'pending'
  | 'failure'
  | 'success';

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

export interface MergedProof {
  merged: boolean;
  number: number;
  url: string;
  head_sha: string;
  merge_commit_sha: string | null;
  merged_at: string | null;
  merged_by: string | null;
}

interface PullSearchInfo {
  complete: boolean;
  pages: number;
  fetched: number;
  total: number | null;
}

interface PullFindResult {
  pull_request: PullRequestIdentity | null;
  search_info: PullSearchInfo;
}

export interface PageInfo {
  complete: boolean;
  pages: number;
  fetched: number;
  total: number | null;
  displayed: number;
  truncated: boolean;
}

export class ForgejoService {
  readonly http: ForgejoHttpClient;

  constructor(readonly config: ConnectionConfig) {
    this.http = new ForgejoHttpClient(config);
  }

  async status(): Promise<Record<string, unknown>> {
    const versionResponse = await this.http.api<{ version?: string }>({
      path: 'version',
    });
    const auth = await this.probeAuth();
    const capabilities = await this.probeCapabilities();
    return {
      host: {
        url: this.config.baseUrl.toString().replace(/\/$/, ''),
        api_url: this.config.apiUrl.toString().replace(/\/$/, ''),
      },
      auth,
      server: { version: versionResponse.data.version ?? 'unknown' },
      capabilities,
    };
  }

  async repoView(repo: RepositoryRef): Promise<Record<string, unknown>> {
    const response = await this.http.api<ApiRepository>({
      path: repoPath(repo),
    });
    const data = response.data;
    return {
      full_name: data.full_name ?? repo.fullName,
      url: canonicalRepoUrl(this.config, repo),
      api_url: canonicalRepoApiUrl(this.config, repo),
      description: data.description ?? '',
      private: data.private ?? false,
      archived: data.archived ?? false,
      default_branch: data.default_branch ?? '',
      has_actions: data.has_actions ?? false,
      has_pull_requests: data.has_pull_requests ?? false,
      open_pull_requests: data.open_pr_counter ?? 0,
    };
  }

  async rawApi(
    method: string,
    path: string,
    body: unknown,
  ): Promise<HttpResponse<unknown>> {
    return this.http.api({
      method,
      path,
      ...(body === undefined ? {} : { body }),
    });
  }

  rawPaginate(path: string): Promise<Paginated<unknown>> {
    return this.http.paginate(path);
  }

  async listPulls(
    repo: RepositoryRef,
    state: string,
  ): Promise<Paginated<PullRequestIdentity>> {
    const page = await this.http.paginate<ApiPullRequest>(
      `${repoPath(repo)}/pulls`,
      {
        state,
      },
    );
    return {
      ...page,
      items: page.items.map((item) => normalizePull(this.config, repo, item)),
    };
  }

  async findPull(
    repo: RepositoryRef,
    head: string,
    base: string | undefined,
    state: string,
  ): Promise<PullFindResult> {
    const pulls = await this.listPulls(repo, state);
    const pullRequest =
      pulls.items.find(
        (pull) =>
          pull.head === head && (base === undefined || pull.base === base),
      ) ?? null;
    return {
      pull_request: pullRequest,
      search_info: {
        complete: pulls.complete,
        pages: pulls.pages,
        fetched: pulls.items.length,
        total: pulls.total,
      },
    };
  }

  async getPull(
    repo: RepositoryRef,
    number: number,
  ): Promise<PullRequestIdentity> {
    const response = await this.getPullRaw(repo, number);
    return normalizePull(this.config, repo, response);
  }

  async viewPull(
    repo: RepositoryRef,
    number: number,
    full: boolean,
  ): Promise<Record<string, unknown>> {
    const response = await this.getPullRaw(repo, number);
    const body = response.body ?? '';
    const bodyCharacters = [...body];
    const previewLimit = 500;
    const truncated = !full && bodyCharacters.length > previewLimit;
    return {
      ...normalizePull(this.config, repo, response),
      body: truncated
        ? `${bodyCharacters.slice(0, previewLimit - 3).join('')}...`
        : body,
      body_length: bodyCharacters.length,
      body_truncated: truncated,
    };
  }

  async createPull(
    repo: RepositoryRef,
    input: {
      title: string;
      head: string;
      base: string;
      body?: string;
      draft: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const existing = await this.findPull(repo, input.head, input.base, 'open');
    const title = input.draft ? draftTitle(input.title) : input.title;
    if (existing.pull_request) {
      return this.reconcilePull(
        repo,
        existing.pull_request.number,
        title,
        input.body,
      );
    }
    if (!existing.search_info.complete) {
      throw new ForgejoAxiError(
        'Pull request search reached the pagination safety ceiling',
        'PAGINATION_INCOMPLETE',
        {
          details: { ...existing.search_info },
          suggestions: ['Narrow the repository pull request set and retry'],
        },
      );
    }

    try {
      const response = await this.http.api<ApiPullRequest>({
        method: 'POST',
        path: `${repoPath(repo)}/pulls`,
        body: {
          title,
          head: input.head,
          base: input.base,
          ...(input.body === undefined ? {} : { body: input.body }),
        },
      });
      return {
        created: true,
        updated: false,
        pull_request: normalizePull(this.config, repo, response.data),
      };
    } catch (error) {
      if (!(error instanceof ForgejoAxiError) || error.code !== 'CONFLICT') {
        throw error;
      }
      const raced = await this.findPull(repo, input.head, input.base, 'open');
      if (!raced.pull_request) {
        if (!raced.search_info.complete) {
          throw new ForgejoAxiError(
            'Pull request search reached the pagination safety ceiling',
            'PAGINATION_INCOMPLETE',
            {
              details: { ...raced.search_info },
              suggestions: ['Narrow the repository pull request set and retry'],
            },
          );
        }
        throw error;
      }
      return this.reconcilePull(
        repo,
        raced.pull_request.number,
        title,
        input.body,
      );
    }
  }

  async updatePull(
    repo: RepositoryRef,
    number: number,
    input: { title?: string; body?: string; base?: string; state?: string },
  ): Promise<Record<string, unknown>> {
    const raw = await this.getPullRaw(repo, number);
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined && input.title !== (raw.title ?? ''))
      patch['title'] = input.title;
    if (input.body !== undefined && input.body !== (raw.body ?? ''))
      patch['body'] = input.body;
    if (input.base !== undefined && input.base !== (raw.base?.ref ?? ''))
      patch['base'] = input.base;
    if (input.state !== undefined && input.state !== (raw.state ?? ''))
      patch['state'] = input.state;
    const updated = Object.keys(patch).length > 0;
    if (updated) await this.patchPull(repo, number, patch);
    return { updated, pull_request: await this.getPull(repo, number) };
  }

  async checks(repo: RepositoryRef, number: number): Promise<ChecksResult> {
    return this.checksForPull(repo, await this.getPull(repo, number));
  }

  async mergeability(
    repo: RepositoryRef,
    number: number,
  ): Promise<Record<string, unknown>> {
    const pull = await this.getPull(repo, number);
    const checks = await this.checksForPull(repo, pull);
    if (pull.merged) {
      return {
        number,
        url: pull.url,
        head_sha: pull.head_sha,
        forgejo_mergeable: pull.mergeable,
        checks_pass: checks.passes,
        mergeable: false,
        reasons: ['already_merged'],
      };
    }
    const reasons: string[] = [];
    if (pull.mergeable !== true) reasons.push('forgejo_not_mergeable');
    if (!checks.passes) {
      reasons.push(
        checks.required_state === 'not_required'
          ? `checks_${checks.state}`
          : `checks_${checks.required_state}`,
      );
    }
    return {
      number,
      url: pull.url,
      head_sha: pull.head_sha,
      forgejo_mergeable: pull.mergeable,
      checks_pass: checks.passes,
      mergeable: pull.mergeable === true && checks.passes,
      reasons,
    };
  }

  async merge(
    repo: RepositoryRef,
    number: number,
    expectedHead: string,
    method: 'merge' | 'squash' | 'rebase',
  ): Promise<MergedProof> {
    const before = await this.getPull(repo, number);
    requireHeadSha(before);
    assertExpectedHead(before, expectedHead);
    if (before.merged) return mergedProof(before);
    try {
      await this.http.api({
        method: 'POST',
        path: `${repoPath(repo)}/pulls/${number}/merge`,
        body: { Do: method, head_commit_id: expectedHead },
      });
    } catch (error) {
      if (!(error instanceof ForgejoAxiError) || error.code === 'HEAD_CHANGED')
        throw error;
      const afterError = await this.getPull(repo, number);
      if (afterError.merged) {
        assertExpectedHead(afterError, expectedHead);
        return mergedProof(afterError);
      }
      throw error;
    }
    const after = await this.getPull(repo, number);
    if (!after.merged) {
      throw new ForgejoAxiError(
        'Forgejo accepted the merge but did not report merged state',
        'MERGE_NOT_PROVEN',
      );
    }
    assertExpectedHead(after, expectedHead);
    return mergedProof(after);
  }

  async merged(
    repo: RepositoryRef,
    number: number,
  ): Promise<Record<string, unknown>> {
    const pull = await this.getPull(repo, number);
    return { ...mergedProof(pull) };
  }

  async listLabels(repo: RepositoryRef): Promise<Paginated<LabelIdentity>> {
    const page = await this.http.paginate<ApiLabel>(`${repoPath(repo)}/labels`);
    return {
      ...page,
      items: page.items.map((item) => normalizeLabel(this.config, repo, item)),
    };
  }

  /** Resolve a repository label by name; shared by every name-addressed command. */
  async resolveLabel(
    repo: RepositoryRef,
    name: string,
  ): Promise<LabelIdentity> {
    return requireLabel(await this.listLabels(repo), repo, name);
  }

  async createLabel(
    repo: RepositoryRef,
    name: string,
    input: LabelInput,
  ): Promise<Record<string, unknown>> {
    const page = await this.listLabels(repo);
    const existing = matchLabel(page, repo, name);
    if (existing) {
      return {
        created: false,
        ...(await this.applyLabel(repo, existing, input)),
      };
    }
    if (!page.complete) throw labelSearchIncomplete(page);
    const response = await this.http.api<ApiLabel>({
      method: 'POST',
      path: `${repoPath(repo)}/labels`,
      body: {
        name,
        color: input.color ?? '#ededed',
        description: input.description ?? '',
      },
    });
    return {
      created: true,
      updated: false,
      label: normalizeLabel(this.config, repo, response.data),
    };
  }

  async editLabel(
    repo: RepositoryRef,
    name: string,
    input: LabelInput & { name?: string },
  ): Promise<Record<string, unknown>> {
    const page = await this.listLabels(repo);
    const label = requireLabel(page, repo, name);
    if (input.name !== undefined && input.name !== label.name) {
      if (page.items.some((other) => other.name === input.name)) {
        throw new ForgejoAxiError(
          `Repository already has a label named ${input.name}`,
          'LABEL_EXISTS',
          {
            details: { name: input.name },
            suggestions: [labelListHint(repo)],
            usage: true,
          },
        );
      }
      if (!page.complete) throw labelSearchIncomplete(page);
    }
    return this.applyLabel(repo, label, input);
  }

  async deleteLabel(
    repo: RepositoryRef,
    name: string,
  ): Promise<Record<string, unknown>> {
    const label = await this.resolveLabel(repo, name);
    await this.http.api({
      method: 'DELETE',
      path: `${repoPath(repo)}/labels/${label.id}`,
    });
    return { deleted: true, label };
  }

  private async applyLabel(
    repo: RepositoryRef,
    label: LabelIdentity,
    input: LabelInput & { name?: string },
  ): Promise<Record<string, unknown>> {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined && input.name !== label.name)
      patch['name'] = input.name;
    if (input.color !== undefined && input.color !== label.color)
      patch['color'] = input.color;
    if (
      input.description !== undefined &&
      input.description !== label.description
    )
      patch['description'] = input.description;
    if (Object.keys(patch).length === 0) return { updated: false, label };
    const response = await this.http.api<ApiLabel>({
      method: 'PATCH',
      path: `${repoPath(repo)}/labels/${label.id}`,
      body: patch,
    });
    return {
      updated: true,
      label: normalizeLabel(this.config, repo, response.data),
    };
  }

  private async checksForPull(
    repo: RepositoryRef,
    pull: PullRequestIdentity,
  ): Promise<ChecksResult> {
    const headSha = requireHeadSha(pull);
    const statusesPage = await this.http.paginate<ApiStatus>(
      `${repoPath(repo)}/statuses/${encodeURIComponent(headSha)}`,
      { sort: 'recentupdate' },
    );
    const statuses = latestStatuses(statusesPage.items);
    const branchResponse = await this.http.api<ApiBranch>({
      path: `${repoPath(repo)}/branches/${encodeURIComponent(pull.base)}`,
      allowEncodedSlash: true,
    });
    return evaluateChecks(headSha, statuses, branchResponse.data);
  }

  private async getPullRaw(
    repo: RepositoryRef,
    number: number,
  ): Promise<ApiPullRequest> {
    const response = await this.http.api<ApiPullRequest>({
      path: `${repoPath(repo)}/pulls/${number}`,
    });
    return response.data;
  }

  private async reconcilePull(
    repo: RepositoryRef,
    number: number,
    title: string,
    body: string | undefined,
  ): Promise<Record<string, unknown>> {
    const raw = await this.getPullRaw(repo, number);
    const patch: Record<string, unknown> = {};
    if ((raw.title ?? '') !== title) patch['title'] = title;
    if (body !== undefined && (raw.body ?? '') !== body) patch['body'] = body;
    const updated = Object.keys(patch).length > 0;
    if (updated) await this.patchPull(repo, number, patch);
    return {
      created: false,
      updated,
      pull_request: await this.getPull(repo, number),
    };
  }

  private async patchPull(
    repo: RepositoryRef,
    number: number,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await this.http.api({
      method: 'PATCH',
      path: `${repoPath(repo)}/pulls/${number}`,
      body: patch,
    });
  }

  private async probeAuth(): Promise<Record<string, unknown>> {
    if (!this.config.token)
      return { configured: false, authenticated: false, source: null };
    try {
      await this.http.api({ path: 'user' });
      return {
        configured: true,
        authenticated: true,
        source: this.config.tokenSource,
      };
    } catch (error) {
      if (
        error instanceof ForgejoAxiError &&
        (error.code === 'AUTH_REQUIRED' || error.code === 'FORBIDDEN')
      ) {
        return {
          configured: true,
          authenticated: false,
          source: this.config.tokenSource,
        };
      }
      throw error;
    }
  }

  private async probeCapabilities(): Promise<Record<string, unknown>> {
    let document: unknown;
    try {
      const response = await this.http.root<unknown>({
        path: 'swagger.v1.json',
      });
      document = response.data;
    } catch (error) {
      if (
        error instanceof ForgejoAxiError &&
        [
          'NOT_FOUND',
          'AUTH_REQUIRED',
          'FORBIDDEN',
          'RATE_LIMITED',
          'API_ERROR',
          'TIMEOUT',
          'NETWORK_ERROR',
          'INVALID_RESPONSE',
        ].includes(error.code)
      ) {
        return capabilityObject({}, 'swagger_unavailable', false);
      }
      throw error;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      return capabilityObject({}, 'swagger_invalid', false);
    }
    const paths = (document as Record<string, unknown>)['paths'];
    if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
      return capabilityObject({}, 'swagger_invalid', false);
    }
    const definitions = (document as Record<string, unknown>)['definitions'];
    const mergeOption =
      definitions &&
      typeof definitions === 'object' &&
      !Array.isArray(definitions)
        ? (definitions as Record<string, unknown>)['MergePullRequestOption']
        : undefined;
    const mergeProperties =
      mergeOption &&
      typeof mergeOption === 'object' &&
      !Array.isArray(mergeOption)
        ? (mergeOption as Record<string, unknown>)['properties']
        : undefined;
    const hasPath = (path: string): boolean => Object.hasOwn(paths, path);
    const capabilities = {
      pull_requests: hasPath('/repos/{owner}/{repo}/pulls'),
      commit_statuses: hasPath('/repos/{owner}/{repo}/statuses/{sha}'),
      branch_protection:
        hasPath('/repos/{owner}/{repo}/branches/{branch}') ||
        hasPath('/repos/{owner}/{repo}/branches/{branch_name}'),
      expected_head_merge:
        hasPath('/repos/{owner}/{repo}/pulls/{index}/merge') &&
        Boolean(
          mergeProperties &&
          typeof mergeProperties === 'object' &&
          !Array.isArray(mergeProperties) &&
          Object.hasOwn(mergeProperties, 'head_commit_id'),
        ),
      actions_job_logs: hasPath(
        '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
      ),
    };
    return capabilityObject(capabilities, 'swagger', true);
  }
}

export function parseRepository(raw: string): RepositoryRef {
  if (/%(?:2e|2f|5c)/i.test(raw))
    throw usageError('Repository contains an encoded path hazard');
  const parts = raw.split('/');
  if (
    parts.length !== 2 ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw usageError('Repository must have the form OWNER/REPO');
  }
  const [owner, name] = parts;
  if (!owner || !name)
    throw usageError('Repository must have the form OWNER/REPO');
  return { owner, name, fullName: `${owner}/${name}` };
}

export function parsePullNumber(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw))
    throw usageError('Pull request number must be a positive integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    throw usageError('Pull request number is too large');
  return value;
}

export function pageInfo<T>(page: Paginated<T>, displayed: number): PageInfo {
  return {
    complete: page.complete,
    pages: page.pages,
    fetched: page.items.length,
    total: page.total,
    displayed,
    truncated: displayed < page.items.length || !page.complete,
  };
}

function repoPath(repo: RepositoryRef): string {
  return `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function canonicalRepoUrl(
  config: ConnectionConfig,
  repo: RepositoryRef,
): string {
  return appendPath(
    config.baseUrl,
    `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
  )
    .toString()
    .replace(/\/$/, '');
}

function canonicalRepoApiUrl(
  config: ConnectionConfig,
  repo: RepositoryRef,
): string {
  return appendPath(config.apiUrl, repoPath(repo))
    .toString()
    .replace(/\/$/, '');
}

function normalizePull(
  config: ConnectionConfig,
  repo: RepositoryRef,
  pull: ApiPullRequest,
): PullRequestIdentity {
  if (!Number.isSafeInteger(pull.number) || !pull.number || pull.number < 1) {
    throw new ForgejoAxiError(
      'Forgejo pull response omitted a valid number',
      'INVALID_RESPONSE',
    );
  }
  const number = pull.number;
  return {
    number,
    url: `${canonicalRepoUrl(config, repo)}/pulls/${number}`,
    api_url: `${canonicalRepoApiUrl(config, repo)}/pulls/${number}`,
    state: pull.state ?? 'unknown',
    draft: pull.draft ?? isDraftTitle(pull.title ?? ''),
    title: pull.title ?? '',
    head: pull.head?.ref ?? '',
    base: pull.base?.ref ?? '',
    head_sha: pull.head?.sha ?? '',
    mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : null,
    merged: pull.merged ?? false,
    merge_commit_sha: pull.merge_commit_sha ?? null,
    merged_at: pull.merged_at ?? null,
    merged_by: pull.merged_by?.login ?? null,
  };
}

function normalizeLabel(
  config: ConnectionConfig,
  repo: RepositoryRef,
  label: ApiLabel,
): LabelIdentity {
  if (!Number.isSafeInteger(label.id) || !label.id || label.id < 1) {
    throw new ForgejoAxiError(
      'Forgejo label response omitted a valid id',
      'INVALID_RESPONSE',
    );
  }
  return {
    id: label.id,
    name: label.name ?? '',
    color: normalizeLabelColor(label.color),
    description: label.description ?? '',
    api_url: `${canonicalRepoApiUrl(config, repo)}/labels/${label.id}`,
  };
}

export function normalizeLabelColor(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  return /^#?[0-9a-f]{6}$/i.test(value)
    ? `#${value.replace(/^#/, '').toLowerCase()}`
    : value;
}

function matchLabel(
  page: Paginated<LabelIdentity>,
  repo: RepositoryRef,
  name: string,
): LabelIdentity | null {
  const matches = page.items.filter((label) => label.name === name);
  if (matches.length > 1) {
    throw new ForgejoAxiError(
      `Repository has ${matches.length} labels named ${name}`,
      'LABEL_AMBIGUOUS',
      {
        details: { name, ids: matches.map((label) => label.id) },
        suggestions: [labelListHint(repo)],
        usage: true,
      },
    );
  }
  return matches[0] ?? null;
}

function requireLabel(
  page: Paginated<LabelIdentity>,
  repo: RepositoryRef,
  name: string,
): LabelIdentity {
  const label = matchLabel(page, repo, name);
  if (label) return label;
  if (!page.complete) throw labelSearchIncomplete(page);
  throw new ForgejoAxiError(
    `Repository has no label named ${name}`,
    'LABEL_NOT_FOUND',
    {
      details: { name },
      suggestions: [labelListHint(repo)],
      usage: true,
    },
  );
}

function labelSearchIncomplete(
  page: Paginated<LabelIdentity>,
): ForgejoAxiError {
  return new ForgejoAxiError(
    'Label search reached the pagination safety ceiling',
    'PAGINATION_INCOMPLETE',
    {
      details: { pages: page.pages, fetched: page.items.length },
      suggestions: ['Reduce the repository label count and retry'],
    },
  );
}

function labelListHint(repo: RepositoryRef): string {
  return `Run \`forgejo-axi label list --repo ${repo.fullName}\``;
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
  // Forgejo returns commit statuses newest-first when no explicit sort is supplied.
  return candidateIndex < previousIndex;
}

function normalizeStatus(
  state: string | undefined,
): Exclude<CheckState, 'none'> {
  if (state === 'success') return 'success';
  if (state === 'pending') return 'pending';
  return 'failure';
}

function evaluateChecks(
  sha: string,
  statuses: NormalizedStatus[],
  branch: ApiBranch,
): ChecksResult {
  const statusChecksEnabled = branch.enable_status_check === true;
  const patterns = statusChecksEnabled
    ? (branch.status_check_contexts ?? [])
    : [];
  const required: RequiredCheck[] = patterns.map((pattern) => {
    const matched = statuses.filter((status) =>
      minimatch(status.context, pattern, { nonegate: true, nocomment: true }),
    );
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

function draftTitle(title: string): string {
  return isDraftTitle(title) ? title : `WIP: ${title}`;
}

function isDraftTitle(title: string): boolean {
  return /^(?:WIP:|\[WIP\]|Draft:|\[Draft\])\s*/i.test(title);
}

function requireHeadSha(pull: PullRequestIdentity): string {
  if (!pull.head_sha) {
    throw new ForgejoAxiError(
      'Forgejo pull response omitted the head commit SHA',
      'INVALID_RESPONSE',
    );
  }
  return pull.head_sha;
}

function assertExpectedHead(
  pull: PullRequestIdentity,
  expectedHead: string,
): void {
  if (pull.head_sha !== expectedHead) {
    throw new ForgejoAxiError('Pull request head changed', 'HEAD_CHANGED', {
      details: { expected: expectedHead, actual: pull.head_sha },
    });
  }
}

function mergedProof(pull: PullRequestIdentity): MergedProof {
  return {
    merged: pull.merged,
    number: pull.number,
    url: pull.url,
    head_sha: requireHeadSha(pull),
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
    merged_by: pull.merged_by,
  };
}

interface ProbedCapabilities {
  pull_requests?: boolean;
  commit_statuses?: boolean;
  branch_protection?: boolean;
  expected_head_merge?: boolean;
  actions_job_logs?: boolean;
}

function capabilityObject(
  capabilities: ProbedCapabilities,
  source: string,
  complete: boolean,
): Record<string, unknown> {
  return {
    pull_requests: capabilities.pull_requests ?? false,
    commit_statuses: capabilities.commit_statuses ?? false,
    branch_protection: capabilities.branch_protection ?? false,
    expected_head_merge: capabilities.expected_head_merge ?? false,
    actions_job_logs: capabilities.actions_job_logs ?? false,
    probe: { source, complete },
  };
}
