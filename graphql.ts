// GraphQL v4: a small recursive-descent parser + executor for the exact
// documents the suite sends (gh / github-mcp-server shapes). No schema file;
// fields are resolved against the store.

import { VIEWER, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selection: FieldNode[] | null;
  fragment: string | null; // inline fragment type condition
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  fields: FieldNode[];
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string }
  | { kind: 'variable'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j += 1;
      const raw = src.slice(i, j);
      tokens.push(raw.includes('.') ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token {
    const t = this.tokens[this.pos] as Token;
    this.pos += 1;
    return t;
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
  }
  isPunct(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.value === v;
  }
  skipPunct(v: string): boolean {
    if (this.isPunct(v)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(variables: Record<string, unknown>): Operation {
    // Optional operation header: query|mutation [Name] [( $var: Type ... )] { ... }
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const n = this.peek();
      if (n?.kind === 'name') name = this.next().value;
    }
    // Variable definitions ($x: Type) — skip them.
    if (this.isPunct('(')) {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const t = this.next();
        if (t.kind === 'punct' && t.value === '(') depth += 1;
        else if (t.kind === 'punct' && t.value === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
    const fields = this.parseSelectionSet(variables);
    return { kind, name, variables, fields };
  }

  parseSelectionSet(variables: Record<string, unknown>): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.isPunct('}')) {
      const t = this.peek();
      if (t === undefined) throw new Error('unexpected end of query');
      if (t.kind === 'spread') {
        this.next();
        const on = this.peek();
        let fragment: string | null = null;
        if (on?.kind === 'name' && on.value === 'on') {
          this.next();
          fragment = this.next().value;
        }
        const sub = this.parseSelectionSet(variables);
        for (const f of sub) fields.push({ ...f, fragment });
        continue;
      }
      fields.push(this.parseField(variables));
    }
    this.expectPunct('}');
    return fields;
  }

  parseField(variables: Record<string, unknown>): FieldNode {
    let name = this.next().value;
    let alias: string | null = null;
    if (this.isPunct(':')) {
      alias = name;
      this.next();
      name = this.next().value;
    }
    const args: Record<string, unknown> = {};
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.next().value;
        this.expectPunct(':');
        args[argName] = this.parseValue(variables);
      }
      this.expectPunct(')');
    }
    let selection: FieldNode[] | null = null;
    if (this.isPunct('{')) selection = this.parseSelectionSet(variables);
    return { alias, name, args, selection, fragment: null };
  }

  parseValue(variables: Record<string, unknown>): unknown {
    const t = this.next();
    if (t.kind === 'variable') {
      const value = variables[t.value];
      return value === undefined ? null : value;
    }
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return parseInt(t.value, 10);
    if (t.kind === 'float') return parseFloat(t.value);
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value; // enum value as string
    }
    if (t.kind === 'punct' && t.value === '[') {
      const arr: unknown[] = [];
      while (!this.isPunct(']')) arr.push(this.parseValue(variables));
      this.expectPunct(']');
      return arr;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!this.isPunct('}')) {
        const key = this.next().value;
        this.expectPunct(':');
        obj[key] = this.parseValue(variables);
      }
      this.expectPunct('}');
      return obj;
    }
    if (t.kind === 'punct' && t.value === '$') {
      const name = this.next().value;
      const value = variables[name];
      return value === undefined ? null : value;
    }
    throw new Error(`unexpected token ${t.value}`);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class GraphQLError extends Error {
  readonly path?: string[];
  constructor(message: string, path?: string[]) {
    super(message);
    this.path = path;
  }
}

function globalId(kind: string, repoId: number, num: number): string {
  // Opaque, stable, distinct from numeric ids: base64 of "kind:repoId:num".
  return Buffer.from(`${kind}:${repoId}:${num}`).toString('base64');
}

function decodeGlobalId(id: string): { kind: string; repoId: number; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, repoId, num] = text.split(':');
    if (!kind || repoId === undefined || num === undefined) return null;
    return { kind, repoId: Number(repoId), num: Number(num) };
  } catch {
    return null;
  }
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PR_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPO_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
];

interface Ctx {
  store: Store;
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  for (const repo of store.repos.values()) if (repo.id === decoded.repoId) return repo;
  return null;
}

function repoNode(store: Store, repo: Repo, fields: FieldNode[], path: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    const p = [...path, f.name];
    switch (f.name) {
      case 'id':
        out[key] = globalId('Repository', repo.id, repo.id);
        break;
      case 'databaseId':
        out[key] = repo.id;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner':
        out[key] = f.selection ? { login: repo.owner } : { login: repo.owner };
        break;
      case 'defaultBranchRef':
        out[key] = f.selection ? { name: repo.defaultBranch } : { name: repo.defaultBranch };
        break;
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'issue': {
        const num = Number(f.args.number);
        const issue = repo.issues.find((i) => i.number === num);
        out[key] = issue ? issueNode(repo, issue, f.selection ?? [], p) : null;
        break;
      }
      case 'issues': {
        const first = f.args.first !== undefined ? Number(f.args.first) : undefined;
        const states = f.args.states as string[] | undefined;
        const after = f.args.after as string | null | undefined;
        const orderBy = f.args.orderBy as { field?: string; direction?: string } | undefined;
        let list = [...repo.issues];
        if (states && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        if (orderBy?.field === 'CREATED_AT') {
          list.sort((a, b) => (orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number));
        } else {
          list.sort((a, b) => a.number - b.number);
        }
        let start = 0;
        if (after) {
          const decoded = decodeGlobalId(after);
          if (decoded) {
            const idx = list.findIndex((i) => i.number === decoded.num);
            if (idx >= 0) start = idx + 1;
          }
        }
        const page = first !== undefined ? list.slice(start, start + first) : list.slice(start);
        const endCursor = page.length > 0 ? globalId('IssueCursor', repo.id, page[page.length - 1]?.number ?? 0) : null;
        const hasNext = first !== undefined && start + first < list.length;
        out[key] = connectionNode(
          page.map((i) => issueNode(repo, i, connectionItemFields(f.selection, 'nodes') ?? [], p)),
          hasNext,
          endCursor,
          f.selection ?? [],
        );
        break;
      }
      case 'pullRequests': {
        const first = f.args.first !== undefined ? Number(f.args.first) : undefined;
        const list = first !== undefined ? repo.pulls.slice(0, first) : [...repo.pulls];
        out[key] = connectionNode(
          list.map((pr) => pullNode(repo, pr, connectionItemFields(f.selection, 'nodes') ?? [], p)),
          false,
          null,
          f.selection ?? [],
        );
        break;
      }
      case 'pullRequest': {
        const num = Number(f.args.number);
        const pr = repo.pulls.find((x) => x.number === num);
        out[key] = pr ? pullNode(repo, pr, f.selection ?? [], p) : null;
        break;
      }
      default:
        throw new GraphQLError(`Cannot query field "${f.name}" on type "Repository".`, p);
    }
  }
  return out;
}

function connectionItemFields(selection: FieldNode[] | null, name: string): FieldNode[] | null {
  if (!selection) return null;
  const f = selection.find((x) => x.name === name);
  return f?.selection ?? null;
}

function connectionNode(
  nodes: unknown[],
  hasNextPage: boolean,
  endCursor: string | null,
  selection: FieldNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of selection) {
    const key = f.alias ?? f.name;
    if (f.name === 'nodes') out[key] = nodes;
    else if (f.name === 'pageInfo') {
      const pi: Record<string, unknown> = {};
      for (const sub of f.selection ?? []) {
        if (sub.name === 'hasNextPage') pi[sub.alias ?? sub.name] = hasNextPage;
        else if (sub.name === 'endCursor') pi[sub.alias ?? sub.name] = endCursor;
      }
      out[key] = pi;
    } else if (f.name === 'edges') {
      out[key] = nodes.map((n) => ({ node: n, cursor: endCursor }));
    }
  }
  return out;
}

function issueNode(repo: Repo, issue: Repo['issues'][number], fields: FieldNode[], path: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id':
        out[key] = globalId('Issue', repo.id, issue.number);
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'state':
        out[key] = issue.state.toUpperCase();
        break;
      case 'body':
        out[key] = issue.body;
        break;
      default:
        throw new GraphQLError(`Cannot query field "${f.name}" on type "Issue".`, [...path, f.name]);
    }
  }
  return out;
}

function pullNode(repo: Repo, pr: Repo['pulls'][number], fields: FieldNode[], path: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id':
        out[key] = globalId('PullRequest', repo.id, pr.number);
        break;
      case 'number':
        out[key] = pr.number;
        break;
      case 'state':
        out[key] = pr.merged ? 'MERGED' : pr.state.toUpperCase();
        break;
      case 'merged':
        out[key] = pr.merged;
        break;
      case 'headRefName':
        out[key] = pr.headRef;
        break;
      case 'baseRefName':
        out[key] = pr.baseRef;
        break;
      case 'mergeable':
        out[key] = 'MERGEABLE';
        break;
      case 'files': {
        const first = f.args.first !== undefined ? Number(f.args.first) : undefined;
        const files = first !== undefined ? pr.files.slice(0, first) : pr.files;
        const itemFields = connectionItemFields(f.selection, 'nodes') ?? [];
        out[key] = connectionNode(
          files.map((file) => {
            const node: Record<string, unknown> = {};
            for (const sub of itemFields) node[sub.alias ?? sub.name] = file.filename;
            return node;
          }),
          false,
          null,
          f.selection ?? [],
        );
        break;
      }
      default:
        throw new GraphQLError(`Cannot query field "${f.name}" on type "PullRequest".`, [...path, f.name]);
    }
  }
  return out;
}

function typeNode(name: string, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fieldList: Record<string, string[]> = {
    Issue: ISSUE_FIELDS,
    PullRequest: PR_FIELDS,
    Repository: REPO_FIELDS,
    User: ['login', 'id'],
    IssueConnection: ['nodes', 'pageInfo'],
    PullRequestConnection: ['nodes', 'pageInfo'],
  };
  const enumValues: Record<string, string[]> = {
    SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
    IssueState: ['OPEN', 'CLOSED'],
    PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
    MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
    RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  };
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === 'fields') {
      const names = fieldList[name] ?? [];
      out[key] = names.map((n) => ({ name: n }));
    } else if (f.name === 'enumValues') {
      const values = enumValues[name] ?? [];
      out[key] = values.map((n) => ({ name: n }));
    } else if (f.name === 'name') {
      out[key] = name;
    } else {
      out[key] = null;
    }
  }
  return out;
}

/** Execute one GraphQL operation. Returns { data, errors? }. Throws only on transport-level issues. */
export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string; path?: string[] }[] } {
  const ctx: Ctx = { store };
  let op: Operation;
  try {
    const parser = new Parser(tokenize(query));
    op = parser.parseDocument(variables);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const data: Record<string, unknown> = {};
  const errors: { message: string; path?: string[] }[] = [];
  if (op.kind === 'mutation') {
    for (const field of op.fields) {
      const key = field.alias ?? field.name;
      try {
        data[key] = executeMutation(ctx, field);
      } catch (err) {
        if (err instanceof GraphQLError) {
          data[key] = null;
          errors.push({ message: err.message, path: err.path });
        } else {
          data[key] = null;
          errors.push({ message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return errors.length > 0 ? { data, errors } : { data };
  }
  for (const field of op.fields) {
    const key = field.alias ?? field.name;
    try {
      data[key] = executeQueryField(ctx, field);
    } catch (err) {
      if (err instanceof GraphQLError) {
        data[key] = null;
        errors.push({ message: err.message, path: err.path });
      } else {
        data[key] = null;
        errors.push({ message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return errors.length > 0 ? { data, errors } : { data };
}

function executeQueryField(ctx: Ctx, field: FieldNode): unknown {
  const path = [field.name];
  switch (field.name) {
    case 'viewer': {
      const out: Record<string, unknown> = {};
      for (const f of field.selection ?? []) {
        if (f.name === 'login') out[f.alias ?? f.name] = VIEWER.login;
        else if (f.name === 'id') out[f.alias ?? f.name] = globalId('User', VIEWER.id, VIEWER.id);
        else throw new GraphQLError(`Cannot query field "${f.name}" on type "User".`, [...path, f.name]);
      }
      return out;
    }
    case 'repository': {
      const owner = String(field.args.owner ?? '');
      const name = String(field.args.name ?? '');
      const repo = ctx.store.getRepo(owner, name);
      if (!repo) return null;
      return repoNode(ctx.store, repo, field.selection ?? [], path);
    }
    case 'node': {
      const id = String(field.args.id ?? '');
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoByGlobalId(ctx.store, id);
        if (!repo) return null;
        const out: Record<string, unknown> = { id };
        for (const f of field.selection ?? []) {
          if (f.fragment === 'Repository') {
            const sub = repoNode(ctx.store, repo, [f], path);
            Object.assign(out, sub);
          } else if (f.name === 'id') {
            out[f.alias ?? f.name] = id;
          }
        }
        return out;
      }
      if (decoded.kind === 'Issue') {
        const repo = findRepoByGlobalId(ctx.store, id);
        if (!repo) return null;
        const issue = repo.issues.find((i) => i.number === decoded.num);
        if (!issue) return null;
        const out: Record<string, unknown> = { id };
        for (const f of field.selection ?? []) {
          if (f.fragment === 'Issue') {
            Object.assign(out, issueNode(repo, issue, [f], path));
          } else if (f.name === 'id') {
            out[f.alias ?? f.name] = id;
          }
        }
        return out;
      }
      return null;
    }
    case '__type': {
      const name = String(field.args.name ?? '');
      return typeNode(name, field.selection ?? []);
    }
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`, path);
  }
}

function executeMutation(ctx: Ctx, field: FieldNode): unknown {
  const input = (field.args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repoId = String(input.repositoryId ?? '');
      const repo = findRepoByGlobalId(ctx.store, repoId);
      if (!repo) throw new GraphQLError('repository not found');
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const issue = {
        id: number,
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as { id: number; body: string }[],
        nextCommentId: 1,
      };
      repo.issues.push(issue);
      return mutationPayload(field, { issue: issueNode(repo, issue, field.selection?.find((f) => f.name === 'issue')?.selection ?? [], ['createIssue']) });
    }
    case 'closeIssue': {
      const issueId = String(input.issueId ?? '');
      const decoded = decodeGlobalId(issueId);
      const repo = decoded ? findRepoByGlobalId(ctx.store, issueId) : null;
      if (!repo || !decoded) throw new GraphQLError('issue not found');
      const issue = repo.issues.find((i) => i.number === decoded.num);
      if (!issue) throw new GraphQLError('issue not found');
      issue.state = 'closed';
      const sel = field.selection?.find((f) => f.name === 'issue')?.selection ?? [];
      return mutationPayload(field, { issue: issueNode(repo, issue, sel, ['closeIssue']) });
    }
    case 'createPullRequest': {
      const repoId = String(input.repositoryId ?? '');
      const repo = findRepoByGlobalId(ctx.store, repoId);
      if (!repo) throw new GraphQLError('repository not found');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
      const number = repo.nextPull;
      repo.nextPull += 1;
      const pr = {
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open' as const,
        merged: false,
        merged_at: null as string | null,
        merge_commit_sha: null as string | null,
        headRef,
        baseRef,
        headSha,
        baseSha,
        files: [] as { filename: string; status: string; additions: number; deletions: number; changes: number }[],
      };
      repo.pulls.push(pr);
      const sel = field.selection?.find((f) => f.name === 'pullRequest')?.selection ?? [];
      return mutationPayload(field, { pullRequest: pullNode(repo, pr, sel, ['createPullRequest']) });
    }
    case 'mergePullRequest': {
      const prId = String(input.pullRequestId ?? '');
      const decoded = decodeGlobalId(prId);
      const repo = decoded ? findRepoByGlobalId(ctx.store, prId) : null;
      if (!repo || !decoded) throw new GraphQLError('pull request not found');
      const pr = repo.pulls.find((x) => x.number === decoded.num);
      if (!pr) throw new GraphQLError('pull request not found');
      pr.merged = true;
      pr.state = 'closed';
      const sel = field.selection?.find((f) => f.name === 'pullRequest')?.selection ?? [];
      return mutationPayload(field, { pullRequest: pullNode(repo, pr, sel, ['mergePullRequest']) });
    }
    case 'addComment': {
      const subjectId = String(input.subjectId ?? '');
      const decoded = decodeGlobalId(subjectId);
      const repo = decoded ? findRepoByGlobalId(ctx.store, subjectId) : null;
      if (!repo || !decoded) throw new GraphQLError('subject not found');
      const issue = repo.issues.find((i) => i.number === decoded.num);
      if (!issue) throw new GraphQLError('subject not found');
      const comment = { id: issue.nextCommentId, body: String(input.body ?? '') };
      issue.nextCommentId += 1;
      issue.comments.push(comment);
      const edgeSel = field.selection?.find((f) => f.name === 'commentEdge')?.selection ?? [];
      const nodeSel = edgeSel.find((f) => f.name === 'node')?.selection ?? [];
      const node: Record<string, unknown> = {};
      for (const f of nodeSel) {
        if (f.name === 'id') node[f.alias ?? f.name] = globalId('IssueComment', repo.id, comment.id);
        else if (f.name === 'body') node[f.alias ?? f.name] = comment.body;
      }
      const edge: Record<string, unknown> = {};
      for (const f of edgeSel) {
        if (f.name === 'node') edge[f.alias ?? f.name] = node;
        else if (f.name === 'cursor') edge[f.alias ?? f.name] = null;
      }
      return mutationPayload(field, { commentEdge: edge });
    }
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`, [field.name]);
  }
}

function mutationPayload(field: FieldNode, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of field.selection ?? []) {
    const key = f.alias ?? f.name;
    out[key] = values[f.name] ?? null;
  }
  return out;
}
