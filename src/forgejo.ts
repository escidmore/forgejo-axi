import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  evaluateChecks,
  type ApiBranch,
  type ApiStatus,
  type ChecksResult,
} from './checks.js';
import { appendPath, type ConnectionConfig } from './config.js';
import { positiveInteger } from './args.js';
import { ForgejoAxiError, usageError } from './errors.js';
import {
  ForgejoHttpClient,
  redact,
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

interface ApiLabel {
  id?: number;
  name?: string;
  color?: string;
  description?: string;
  is_archived?: boolean;
}

interface ApiMilestone {
  id?: number;
  title?: string;
  state?: string;
}

interface ApiIssue {
  number?: number;
  state?: string;
  title?: string;
  body?: string;
  labels?: ApiLabel[];
  assignees?: ApiUser[];
  milestone?: ApiMilestone | null;
  comments?: number;
  user?: ApiUser;
  pull_request?: unknown;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
}

interface ApiComment {
  id?: number;
  body?: string;
  user?: ApiUser;
  created_at?: string;
  updated_at?: string;
}

interface ApiPullReview {
  id?: number;
  body?: string;
  state?: string;
  commit_id?: string;
  stale?: boolean;
  official?: boolean;
  dismissed?: boolean;
  comments_count?: number;
  submitted_at?: string;
  updated_at?: string;
  user?: ApiUser;
  team?: { name?: string };
}

interface ApiPullReviewComment {
  id?: number;
  body?: string;
  path?: string;
  position?: number;
  original_position?: number;
  commit_id?: string;
  original_commit_id?: string;
  diff_hunk?: string;
  user?: ApiUser;
  resolver?: ApiUser;
  created_at?: string;
  updated_at?: string;
}

interface ApiActionRun {
  id?: number;
  title?: string;
  event?: string;
  prettyref?: string;
  commit_sha?: string;
  index_in_repo?: number;
  status?: string;
  started?: string;
  stopped?: string;
}

interface ApiActionRunJob {
  id?: number;
  run_id?: number;
  name?: string;
  status?: string;
}

interface ApiActionArtifact {
  id?: number;
  name?: string;
  size_in_bytes?: number;
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
  is_archived: boolean;
  api_url: string;
}

export interface LabelInput {
  color?: string;
  description?: string;
}

export interface MilestoneIdentity {
  id: number;
  name: string;
  state: string;
}

export interface IssueIdentity {
  number: number;
  url: string;
  api_url: string;
  state: string;
  title: string;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  comments: number;
  is_pull_request: boolean;
  user: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
}

/** A body rendered as a preview or in full, with the measurement that says which. */
interface BodyPreview {
  body: string;
  body_length: number;
  body_truncated: boolean;
}

export interface CommentIdentity extends BodyPreview {
  id: number;
  api_url: string;
  user: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** One inline review comment, anchored to the file and diff position it marks. */
export interface ReviewCommentIdentity extends BodyPreview {
  id: number;
  api_url: string;
  path: string | null;
  position: number | null;
  original_position: number | null;
  commit_id: string | null;
  original_commit_id: string | null;
  diff_hunk: string;
  diff_hunk_length: number;
  diff_hunk_truncated: boolean;
  user: string | null;
  resolved_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * One review record: who was asked or reviewed, the verdict, and any comments
 * left. Not every record is a submission — a review requested from a user or a
 * team is reported here too, with a null submitted_at.
 */
export interface ReviewIdentity extends BodyPreview {
  id: number;
  api_url: string;
  user: string | null;
  team: string | null;
  state: string | null;
  stale: boolean;
  official: boolean;
  dismissed: boolean;
  commit_id: string | null;
  submitted_at: string | null;
  updated_at: string | null;
  comments: ReviewCommentIdentity[];
}

export interface IssueFilters {
  state: string;
  labels?: string[];
  assignee?: string;
  milestone?: string;
}

export interface IssueInput {
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: string;
  state?: string;
}

export interface RunIdentity {
  id: number;
  url: string;
  api_url: string;
  title: string;
  event: string;
  branch: string;
  head_sha: string;
  run_number: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface JobIdentity {
  id: number;
  run_id: number;
  name: string;
  status: string;
  log?: string | null;
}

export interface RunFilters {
  status?: string;
  branch?: string;
}

export interface ArtifactDownload {
  name: string;
  size_in_bytes: number;
  path: string;
}

/** Run states Forgejo will no longer act on; a cancel of one is skipped, not sent. */
const DONE_RUN_STATUSES = new Set([
  'success',
  'failure',
  'cancelled',
  'skipped',
]);

export type { ChecksResult };

export type MergedProof = {
  merged: boolean;
  number: number;
  url: string;
  head_sha: string;
  merge_commit_sha: string | null;
  merged_at: string | null;
  merged_by: string | null;
};

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
        url: canonical(this.config.baseUrl),
        api_url: canonical(this.config.apiUrl),
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
    return {
      ...normalizePull(this.config, repo, response),
      ...previewBody(response.body, full),
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
    return mergedProof(pull);
  }

  async listReviews(
    repo: RepositoryRef,
    number: number,
    full: boolean,
  ): Promise<Paginated<ReviewIdentity>> {
    const page = await this.http.paginate<ApiPullReview>(
      `${repoPath(repo)}/pulls/${number}/reviews`,
    );
    const reviews: ReviewIdentity[] = [];
    for (const review of page.items) {
      const id = requireReviewId(review);
      // A review that reports no inline comments needs no second request; an
      // absent count is treated as unknown and fetched. The remaining fetches
      // are serial, so a pull request with many commented reviews costs one
      // round trip each. Parallelising them would need a concurrency cap to
      // stay polite to the forge, which no observed pull request has needed.
      const comments =
        review.comments_count === 0
          ? []
          : await this.reviewComments(repo, number, id, full);
      reviews.push(
        normalizeReview(this.config, repo, review, {
          id,
          pull: number,
          comments,
          full,
        }),
      );
    }
    return { ...page, items: reviews };
  }

  async diffPull(repo: RepositoryRef, number: number): Promise<string> {
    // The route produces text/plain, so the body arrives verbatim. Leaving it
    // unraw keeps the client's token redaction on the response.
    const response = await this.http.api<string>({
      path: `${repoPath(repo)}/pulls/${number}.diff`,
      accept: 'text/plain',
    });
    // An empty diff arrives as an empty body, which the client reports as null.
    // Anything else non-textual is a malformed response, not an empty diff.
    if (response.data === null) return '';
    if (typeof response.data !== 'string') {
      throw new ForgejoAxiError(
        'Forgejo returned a non-text diff response',
        'INVALID_RESPONSE',
      );
    }
    return response.data;
  }

  /** Forgejo serves a review's comments in one response; the route declares no paging. */
  private async reviewComments(
    repo: RepositoryRef,
    pull: number,
    review: number,
    full: boolean,
  ): Promise<ReviewCommentIdentity[]> {
    const response = await this.http.api<ApiPullReviewComment[]>({
      path: `${repoPath(repo)}/pulls/${pull}/reviews/${review}/comments`,
    });
    if (!Array.isArray(response.data)) {
      throw new ForgejoAxiError(
        'Forgejo returned a non-array review comment response',
        'INVALID_RESPONSE',
      );
    }
    return response.data.map((comment) =>
      normalizeReviewComment(this.config, repo, comment, {
        pull,
        review,
        full,
      }),
    );
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
    return requireNamed(await this.listLabels(repo), name, labelLookup(repo));
  }

  async createLabel(
    repo: RepositoryRef,
    name: string,
    input: LabelInput,
  ): Promise<Record<string, unknown>> {
    const page = await this.listLabels(repo);
    const existing = matchNamed(page, name, labelLookup(repo));
    if (!page.complete) throw namedSearchIncomplete(page, labelLookup(repo));
    if (existing) {
      return {
        created: false,
        ...(await this.applyLabel(repo, existing, input)),
      };
    }
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
    const label = requireNamed(page, name, labelLookup(repo));
    if (
      input.name !== undefined &&
      input.name !== label.name &&
      page.items.some((other) => other.name === input.name)
    ) {
      throw new ForgejoAxiError(
        `Repository already has a label named ${input.name}`,
        'LABEL_EXISTS',
        {
          details: { name: input.name },
          suggestions: [labelLookup(repo).hint],
          usage: true,
        },
      );
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

  /** Resolve every requested label name in one label fetch. */
  async resolveLabels(
    repo: RepositoryRef,
    names: readonly string[],
  ): Promise<LabelIdentity[]> {
    if (names.length === 0) return [];
    const page = await this.listLabels(repo);
    const lookup = labelLookup(repo);
    return names.map((name) => requireNamed(page, name, lookup));
  }

  async resolveMilestone(
    repo: RepositoryRef,
    name: string,
  ): Promise<MilestoneIdentity> {
    const page = await this.http.paginate<ApiMilestone>(
      `${repoPath(repo)}/milestones`,
      { state: 'all' },
    );
    return requireNamed(
      { ...page, items: page.items.map(normalizeMilestone) },
      name,
      milestoneLookup(repo),
    );
  }

  async listIssues(
    repo: RepositoryRef,
    filters: IssueFilters,
  ): Promise<Paginated<IssueIdentity>> {
    // `type` keeps pull requests out of a list an agent asked issues for.
    const query: Record<string, string> = {
      state: filters.state,
      type: 'issues',
    };
    if (filters.labels && filters.labels.length > 0) {
      // Forgejo silently discards unknown filter names, so resolution is what
      // stops an unfiltered result from reading like a filtered one.
      const labels = await this.resolveLabels(repo, filters.labels);
      query['labels'] = labels.map((label) => label.name).join(',');
    }
    if (filters.milestone !== undefined) {
      const milestone = await this.resolveMilestone(repo, filters.milestone);
      query['milestones'] = String(milestone.id);
    }
    if (filters.assignee !== undefined) query['assigned_by'] = filters.assignee;
    const page = await this.http.paginate<ApiIssue>(
      `${repoPath(repo)}/issues`,
      query,
    );
    return {
      ...page,
      items: page.items.map((item) => normalizeIssue(this.config, repo, item)),
    };
  }

  async viewIssue(
    repo: RepositoryRef,
    number: number,
    full: boolean,
  ): Promise<{ issue: Record<string, unknown>; comments: CommentIdentity[] }> {
    const raw = await this.getIssueRaw(repo, number);
    // Forgejo serves the whole thread in one response and ignores page/limit
    // here, so paginating it would refetch the same rows.
    const response = await this.http.api<ApiComment[]>({
      path: `${repoPath(repo)}/issues/${number}/comments`,
    });
    if (!Array.isArray(response.data)) {
      throw new ForgejoAxiError(
        'Forgejo returned a non-array comment response',
        'INVALID_RESPONSE',
      );
    }
    return {
      issue: {
        ...normalizeIssue(this.config, repo, raw),
        ...previewBody(raw.body, full),
      },
      comments: response.data.map((comment) =>
        normalizeComment(this.config, repo, comment, full),
      ),
    };
  }

  async createIssue(
    repo: RepositoryRef,
    input: IssueInput & { title: string },
  ): Promise<Record<string, unknown>> {
    const labels = await this.resolveLabels(repo, input.labels ?? []);
    const milestone = await this.resolveOptionalMilestone(
      repo,
      input.milestone,
    );
    const response = await this.http.api<ApiIssue>({
      method: 'POST',
      path: `${repoPath(repo)}/issues`,
      body: {
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(labels.length === 0
          ? {}
          : { labels: labels.map((label) => label.id) }),
        ...(input.assignees === undefined
          ? {}
          : { assignees: input.assignees }),
        ...(milestone === null ? {} : { milestone: milestone.id }),
      },
    });
    return { issue: normalizeIssue(this.config, repo, response.data) };
  }

  async editIssue(
    repo: RepositoryRef,
    number: number,
    input: IssueInput,
  ): Promise<Record<string, unknown>> {
    const raw = await this.getIssueRaw(repo, number);
    const current = normalizeIssue(this.config, repo, raw);
    // Every name resolves before the first mutation so an unknown label or
    // milestone cannot leave the issue half-edited.
    const labels =
      input.labels === undefined
        ? undefined
        : await this.resolveLabels(repo, input.labels);
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined && input.title !== current.title)
      patch['title'] = input.title;
    if (input.body !== undefined && input.body !== (raw.body ?? ''))
      patch['body'] = input.body;
    if (input.state !== undefined && input.state !== current.state)
      patch['state'] = input.state;
    if (
      input.assignees !== undefined &&
      !sameNames(input.assignees, current.assignees)
    ) {
      patch['assignees'] = input.assignees;
    }
    if (input.milestone !== undefined) {
      const milestone = await this.resolveOptionalMilestone(
        repo,
        input.milestone,
      );
      const desired = milestone === null ? null : milestone.name;
      // Forgejo clears the milestone from id 0, not from an absent field.
      if (desired !== current.milestone)
        patch['milestone'] = milestone === null ? 0 : milestone.id;
    }
    const relabel =
      labels !== undefined &&
      !sameNames(
        labels.map((label) => label.name),
        current.labels,
      );
    if (Object.keys(patch).length > 0) {
      await this.http.api({
        method: 'PATCH',
        path: `${repoPath(repo)}/issues/${number}`,
        body: patch,
      });
    }
    if (relabel) {
      // Issue labels are not part of the issue patch body in Forgejo.
      await this.http.api({
        method: 'PUT',
        path: `${repoPath(repo)}/issues/${number}/labels`,
        body: { labels: labels.map((label) => label.id) },
      });
    }
    const updated = Object.keys(patch).length > 0 || relabel;
    return {
      updated,
      issue: updated ? await this.getIssue(repo, number) : current,
    };
  }

  async setIssueState(
    repo: RepositoryRef,
    number: number,
    state: 'open' | 'closed',
    comment: string | undefined,
  ): Promise<Record<string, unknown>> {
    const posted =
      comment === undefined
        ? undefined
        : await this.commentIssue(repo, number, comment);
    return { ...(await this.editIssue(repo, number, { state })), ...posted };
  }

  async commentIssue(
    repo: RepositoryRef,
    number: number,
    body: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.http.api<ApiComment>({
      method: 'POST',
      path: `${repoPath(repo)}/issues/${number}/comments`,
      body: { body },
    });
    return {
      comment: normalizeComment(this.config, repo, response.data, true),
    };
  }

  /** Probed once per invocation; the CLI seam decides whether to render Unsupported. */
  async runCapabilities(): Promise<{
    runs: boolean;
    run_jobs: boolean;
    run_cancel: boolean;
    run_artifacts: boolean;
    job_logs: boolean;
  }> {
    const capabilities = await this.probeCapabilities();
    return {
      runs: capabilities.runs,
      run_jobs: capabilities.run_jobs,
      run_cancel: capabilities.run_cancel,
      run_artifacts: capabilities.run_artifacts,
      job_logs: capabilities.actions_job_logs,
    };
  }

  async listRuns(
    repo: RepositoryRef,
    filters: RunFilters,
  ): Promise<Paginated<RunIdentity>> {
    const query: Record<string, string> = {};
    if (filters.status !== undefined) query['status'] = filters.status;
    if (filters.branch !== undefined) {
      query['ref'] = filters.branch.startsWith('refs/')
        ? filters.branch
        : `refs/heads/${filters.branch}`;
    }
    const page = await this.http.paginateEnvelope<ApiActionRun>(
      `${repoPath(repo)}/actions/runs`,
      query,
    );
    return {
      ...page,
      items: page.items.map((item) => normalizeRun(this.config, repo, item)),
    };
  }

  async viewRun(
    repo: RepositoryRef,
    runId: number,
    log: 'none' | 'all' | 'failed',
    includeJobs: boolean,
  ): Promise<{ run: RunIdentity; jobs: JobIdentity[] }> {
    const run = normalizeRun(
      this.config,
      repo,
      await this.getRunRaw(repo, runId),
    );
    if (!includeJobs) return { run, jobs: [] };
    const jobsResponse = await this.http.api<ApiActionRunJob[]>({
      path: `${repoPath(repo)}/actions/runs/${runId}/jobs`,
    });
    if (!Array.isArray(jobsResponse.data)) {
      throw new ForgejoAxiError(
        'Forgejo returned a non-array job response',
        'INVALID_RESPONSE',
      );
    }
    const jobs = jobsResponse.data.map((job) => normalizeJob(job));
    if (log === 'none') return { run, jobs };
    const withLogs: JobIdentity[] = [];
    for (const job of jobs) {
      if (log === 'failed' && job.status !== 'failure') {
        withLogs.push(job);
        continue;
      }
      withLogs.push({ ...job, log: await this.getJobLog(repo, job.id) });
    }
    return { run, jobs: withLogs };
  }

  async cancelRun(
    repo: RepositoryRef,
    runId: number,
  ): Promise<Record<string, unknown>> {
    const before = await this.getRunRaw(repo, runId);
    // A finished run is reported unchanged without asking Forgejo to cancel it.
    // Sending the request anyway would make the contracted no-op depend on the
    // host tolerating a redundant cancel.
    if (DONE_RUN_STATUSES.has(before.status ?? '')) {
      return { cancelled: false, run: normalizeRun(this.config, repo, before) };
    }
    await this.http.api({
      method: 'POST',
      path: `${repoPath(repo)}/actions/runs/${runId}/cancel`,
    });
    const after = await this.getRunRaw(repo, runId);
    return {
      cancelled: true,
      run: normalizeRun(this.config, repo, after),
    };
  }

  async downloadRunArtifacts(
    repo: RepositoryRef,
    runId: number,
    name: string | undefined,
    dir: string,
  ): Promise<{ run_id: number; dir: string; downloaded: ArtifactDownload[] }> {
    const query: Record<string, string> = {};
    if (name !== undefined) query['name'] = name;
    const page = await this.http.paginate<ApiActionArtifact>(
      `${repoPath(repo)}/actions/runs/${runId}/artifacts`,
      query,
    );
    if (!page.complete) {
      throw new ForgejoAxiError(
        'Artifact search reached the pagination safety ceiling',
        'PAGINATION_INCOMPLETE',
        {
          details: { pages: page.pages, fetched: page.items.length },
          suggestions: ['Narrow the artifact name and retry'],
        },
      );
    }
    await mkdir(dir, { recursive: true });
    const downloaded: ArtifactDownload[] = [];
    for (const artifact of page.items) {
      const artifactName = requireSafeArtifactName(artifact.name);
      const artifactId = requireArtifactId(artifact.id);
      const path = join(dir, `${artifactName}.zip`);
      let written: number;
      try {
        const response = await this.http.api<number>({
          path: `${repoPath(repo)}/actions/artifacts/${artifactId}/zip`,
          accept: 'application/octet-stream',
          raw: true,
          file: path,
        });
        written = response.data;
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          throw new ForgejoAxiError(
            `Artifact file already exists: ${path}`,
            'ARTIFACT_EXISTS',
            { details: { path } },
          );
        }
        throw error;
      }
      downloaded.push({
        name: artifactName,
        size_in_bytes: artifact.size_in_bytes ?? written,
        path,
      });
    }
    return { run_id: runId, dir, downloaded };
  }

  private async getRunRaw(
    repo: RepositoryRef,
    runId: number,
  ): Promise<ApiActionRun> {
    const response = await this.http.api<ApiActionRun>({
      path: `${repoPath(repo)}/actions/runs/${runId}`,
    });
    return response.data;
  }

  private async getJobLog(repo: RepositoryRef, jobId: number): Promise<string> {
    const response = await this.http.api<Buffer>({
      path: `${repoPath(repo)}/actions/jobs/${jobId}/logs`,
      accept: 'text/plain',
      raw: true,
    });
    return redact(response.data.toString('utf8'), this.config.token) ?? '';
  }

  private async getIssue(
    repo: RepositoryRef,
    number: number,
  ): Promise<IssueIdentity> {
    return normalizeIssue(
      this.config,
      repo,
      await this.getIssueRaw(repo, number),
    );
  }

  private async getIssueRaw(
    repo: RepositoryRef,
    number: number,
  ): Promise<ApiIssue> {
    const response = await this.http.api<ApiIssue>({
      path: `${repoPath(repo)}/issues/${number}`,
    });
    return response.data;
  }

  /** An empty name clears the milestone; an absent one leaves it alone. */
  private async resolveOptionalMilestone(
    repo: RepositoryRef,
    name: string | undefined,
  ): Promise<MilestoneIdentity | null> {
    if (name === undefined || name.trim() === '') return null;
    return this.resolveMilestone(repo, name);
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
    // Forgejo archives from the absence of is_archived, so every patch must resend it.
    patch['is_archived'] = label.is_archived;
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
    const branchResponse = await this.http.api<ApiBranch>({
      path: `${repoPath(repo)}/branches/${encodeURIComponent(pull.base)}`,
      allowEncodedSlash: true,
    });
    return evaluateChecks(headSha, statusesPage.items, branchResponse.data);
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

  private async probeCapabilities(): Promise<CapabilityReport> {
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
      runs: hasPath('/repos/{owner}/{repo}/actions/runs'),
      run_jobs: hasPath('/repos/{owner}/{repo}/actions/runs/{run_id}/jobs'),
      run_cancel: hasPath('/repos/{owner}/{repo}/actions/runs/{run_id}/cancel'),
      run_artifacts: hasPath(
        '/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts',
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
  return positiveInteger(raw, 'Pull request number');
}

export function parseIssueNumber(raw: string): number {
  return positiveInteger(raw, 'Issue number');
}

export function parseRunId(raw: string): number {
  return positiveInteger(raw, 'Run id');
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

/** A canonical URL is emitted without its trailing slash. */
function canonical(url: URL): string {
  return url.toString().replace(/\/$/, '');
}

/** Forgejo ids and numbers are positive integers; anything else is a malformed response. */
function requireId(value: number | undefined, message: string): number {
  if (!Number.isSafeInteger(value) || !value || value < 1) {
    throw new ForgejoAxiError(message, 'INVALID_RESPONSE');
  }
  return value;
}

function canonicalRepoUrl(
  config: ConnectionConfig,
  repo: RepositoryRef,
): string {
  return canonical(
    appendPath(
      config.baseUrl,
      `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
    ),
  );
}

function canonicalRepoApiUrl(
  config: ConnectionConfig,
  repo: RepositoryRef,
): string {
  return canonical(appendPath(config.apiUrl, repoPath(repo)));
}

function normalizePull(
  config: ConnectionConfig,
  repo: RepositoryRef,
  pull: ApiPullRequest,
): PullRequestIdentity {
  const number = requireId(
    pull.number,
    'Forgejo pull response omitted a valid number',
  );
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
  const id = requireId(label.id, 'Forgejo label response omitted a valid id');
  return {
    id,
    name: label.name ?? '',
    color: normalizeLabelColor(label.color),
    description: label.description ?? '',
    is_archived: label.is_archived ?? false,
    api_url: `${canonicalRepoApiUrl(config, repo)}/labels/${label.id}`,
  };
}

export function normalizeLabelColor(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  return /^#?[0-9a-f]{6}$/i.test(value)
    ? `#${value.replace(/^#/, '').toLowerCase()}`
    : value;
}

function normalizeIssue(
  config: ConnectionConfig,
  repo: RepositoryRef,
  issue: ApiIssue,
): IssueIdentity {
  const number = requireId(
    issue.number,
    'Forgejo issue response omitted a valid number',
  );
  return {
    number,
    url: `${canonicalRepoUrl(config, repo)}/issues/${number}`,
    api_url: `${canonicalRepoApiUrl(config, repo)}/issues/${number}`,
    state: issue.state ?? 'unknown',
    title: issue.title ?? '',
    labels: (issue.labels ?? []).map((label) => label.name ?? ''),
    assignees: (issue.assignees ?? []).map((user) => user.login ?? ''),
    milestone: issue.milestone?.title ?? null,
    comments: issue.comments ?? 0,
    is_pull_request: Boolean(issue.pull_request),
    user: issue.user?.login ?? null,
    created_at: issue.created_at ?? null,
    updated_at: issue.updated_at ?? null,
    closed_at: issue.closed_at ?? null,
  };
}

function normalizeComment(
  config: ConnectionConfig,
  repo: RepositoryRef,
  comment: ApiComment,
  full: boolean,
): CommentIdentity {
  const id = requireId(
    comment.id,
    'Forgejo comment response omitted a valid id',
  );
  return {
    id,
    api_url: `${canonicalRepoApiUrl(config, repo)}/issues/comments/${comment.id}`,
    user: comment.user?.login ?? null,
    created_at: comment.created_at ?? null,
    updated_at: comment.updated_at ?? null,
    ...previewBody(comment.body, full),
  };
}

function requireReviewId(review: ApiPullReview): number {
  return requireId(review.id, 'Forgejo review response omitted a valid id');
}

function normalizeReview(
  config: ConnectionConfig,
  repo: RepositoryRef,
  review: ApiPullReview,
  context: {
    id: number;
    pull: number;
    comments: ReviewCommentIdentity[];
    full: boolean;
  },
): ReviewIdentity {
  const base = `${canonicalRepoApiUrl(config, repo)}/pulls/${context.pull}`;
  return {
    id: context.id,
    api_url: `${base}/reviews/${context.id}`,
    user: review.user?.login ?? null,
    // A review requested from a team names the team and leaves user unset, so
    // reporting only user would leave that record with nobody on it.
    team: review.team?.name ?? null,
    // Forgejo reports an unmapped verdict as an empty string rather than
    // omitting it, so the absent case has to be matched on falsiness. Any
    // other value passes through: nulling a verdict this version does not
    // recognise would conflate "no verdict" with "a verdict we cannot name".
    state: review.state || null,
    stale: review.stale ?? false,
    official: review.official ?? false,
    dismissed: review.dismissed ?? false,
    commit_id: review.commit_id || null,
    submitted_at: timestampOrNull(review.submitted_at),
    updated_at: timestampOrNull(review.updated_at),
    comments: context.comments,
    ...previewBody(review.body, context.full),
  };
}

function normalizeReviewComment(
  config: ConnectionConfig,
  repo: RepositoryRef,
  comment: ApiPullReviewComment,
  context: { pull: number; review: number; full: boolean },
): ReviewCommentIdentity {
  const id = requireId(
    comment.id,
    'Forgejo review comment response omitted a valid id',
  );
  const base = `${canonicalRepoApiUrl(config, repo)}/pulls/${context.pull}`;
  const hunkPreview = previewBody(comment.diff_hunk, context.full);
  // Forgejo never omits these keys; it sends an empty string or a zero for an
  // anchor it does not have, so `||` is what turns "not reported" into null.
  // A comment on a removed line carries only the original_ anchor, which is
  // why both sides are reported rather than collapsed into one position.
  return {
    id,
    api_url: `${base}/reviews/${context.review}/comments/${id}`,
    path: comment.path || null,
    position: comment.position || null,
    original_position: comment.original_position || null,
    commit_id: comment.commit_id || null,
    original_commit_id: comment.original_commit_id || null,
    // The hunk is free text like a body, so it observes the same ceiling.
    // Uncapped, a review carrying many large hunks would let the capped view
    // emit an unbounded payload while page_info still reported no truncation.
    // The hunk reports the same measurement too, so a consumer can tell a
    // capped hunk from a whole one.
    diff_hunk: hunkPreview.body,
    diff_hunk_length: hunkPreview.body_length,
    diff_hunk_truncated: hunkPreview.body_truncated,
    user: comment.user?.login ?? null,
    resolved_by: comment.resolver?.login ?? null,
    created_at: timestampOrNull(comment.created_at),
    updated_at: timestampOrNull(comment.updated_at),
    ...previewBody(comment.body, context.full),
  };
}

function normalizeMilestone(milestone: ApiMilestone): MilestoneIdentity {
  return {
    id: requireId(
      milestone.id,
      'Forgejo milestone response omitted a valid id',
    ),
    name: milestone.title ?? '',
    state: milestone.state ?? 'unknown',
  };
}

function normalizeRun(
  config: ConnectionConfig,
  repo: RepositoryRef,
  run: ApiActionRun,
): RunIdentity {
  const id = requireId(run.id, 'Forgejo run response omitted a valid id');
  return {
    id,
    url: `${canonicalRepoUrl(config, repo)}/actions/runs/${id}`,
    api_url: `${canonicalRepoApiUrl(config, repo)}/actions/runs/${id}`,
    title: run.title ?? '',
    event: run.event ?? '',
    branch: run.prettyref ?? '',
    head_sha: run.commit_sha ?? '',
    run_number: run.index_in_repo ?? 0,
    status: run.status ?? 'unknown',
    started_at: timestampOrNull(run.started),
    completed_at: timestampOrNull(run.stopped),
  };
}

/** Forgejo serialises an unset time as Go's zero value rather than omitting it. */
function timestampOrNull(raw: string | undefined): string | null {
  if (!raw || raw.startsWith('0001-01-01')) return null;
  return raw;
}

function normalizeJob(job: ApiActionRunJob): JobIdentity {
  return {
    id: requireId(job.id, 'Forgejo job response omitted a valid id'),
    run_id: job.run_id ?? 0,
    name: job.name ?? '',
    status: job.status ?? 'unknown',
  };
}

/** Rejects path-traversal-shaped artifact names before they become a filesystem path. */
function requireSafeArtifactName(raw: string | undefined): string {
  const name = raw ?? '';
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new ForgejoAxiError(
      'Forgejo artifact response carried an unsafe name',
      'INVALID_RESPONSE',
      { details: { name } },
    );
  }
  return name;
}

function requireArtifactId(id: number | undefined): number {
  return requireId(id, 'Forgejo artifact response omitted a valid id');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function previewBody(raw: string | undefined, full: boolean): BodyPreview {
  const body = raw ?? '';
  const characters = [...body];
  const previewLimit = 500;
  const truncated = !full && characters.length > previewLimit;
  return {
    body: truncated
      ? `${characters.slice(0, previewLimit - 3).join('')}...`
      : body,
    body_length: characters.length,
    body_truncated: truncated,
  };
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sorted = [...right].sort();
  return [...left].sort().every((value, index) => value === sorted[index]);
}

interface NamedIdentity {
  id: number;
  name: string;
}

/** How one kind of name-addressed entity reports a failed lookup. */
interface NameLookup {
  code: 'LABEL' | 'MILESTONE';
  noun: string;
  hint: string;
}

function labelLookup(repo: RepositoryRef): NameLookup {
  return {
    code: 'LABEL',
    noun: 'label',
    hint: `Run \`forgejo-axi label list --repo ${repo.fullName}\``,
  };
}

function milestoneLookup(repo: RepositoryRef): NameLookup {
  return {
    code: 'MILESTONE',
    noun: 'milestone',
    hint: `Run \`forgejo-axi api GET repos/${repo.fullName}/milestones\``,
  };
}

function matchNamed<T extends NamedIdentity>(
  page: Paginated<T>,
  name: string,
  lookup: NameLookup,
): T | null {
  const matches = page.items.filter((item) => item.name === name);
  if (matches.length > 1) {
    throw new ForgejoAxiError(
      `Repository has ${matches.length} ${lookup.noun}s named ${name}`,
      `${lookup.code}_AMBIGUOUS`,
      {
        details: { name, ids: matches.map((item) => item.id) },
        suggestions: [lookup.hint],
        usage: true,
      },
    );
  }
  return matches[0] ?? null;
}

function requireNamed<T extends NamedIdentity>(
  page: Paginated<T>,
  name: string,
  lookup: NameLookup,
): T {
  const match = matchNamed(page, name, lookup);
  // An incomplete search cannot prove the match is the only one carrying the name.
  if (!page.complete) throw namedSearchIncomplete(page, lookup);
  if (match) return match;
  throw new ForgejoAxiError(
    `Repository has no ${lookup.noun} named ${name}`,
    `${lookup.code}_NOT_FOUND`,
    { details: { name }, suggestions: [lookup.hint], usage: true },
  );
}

function namedSearchIncomplete(
  page: Paginated<unknown>,
  lookup: NameLookup,
): ForgejoAxiError {
  return new ForgejoAxiError(
    `Repository ${lookup.noun} search reached the pagination safety ceiling`,
    'PAGINATION_INCOMPLETE',
    {
      details: { pages: page.pages, fetched: page.items.length },
      suggestions: [`Reduce the repository ${lookup.noun} count and retry`],
    },
  );
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
  runs?: boolean;
  run_jobs?: boolean;
  run_cancel?: boolean;
  run_artifacts?: boolean;
}

type CapabilityReport = Record<keyof ProbedCapabilities, boolean> & {
  probe: { source: string; complete: boolean };
};

function capabilityObject(
  capabilities: ProbedCapabilities,
  source: string,
  complete: boolean,
): CapabilityReport {
  return {
    pull_requests: capabilities.pull_requests ?? false,
    commit_statuses: capabilities.commit_statuses ?? false,
    branch_protection: capabilities.branch_protection ?? false,
    expected_head_merge: capabilities.expected_head_merge ?? false,
    actions_job_logs: capabilities.actions_job_logs ?? false,
    runs: capabilities.runs ?? false,
    run_jobs: capabilities.run_jobs ?? false,
    run_cancel: capabilities.run_cancel ?? false,
    run_artifacts: capabilities.run_artifacts ?? false,
    probe: { source, complete },
  };
}
