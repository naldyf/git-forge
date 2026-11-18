// MCP over streamable HTTP: server/discover (modern 2026-07-28) + legacy
// initialize fallback, tools/list, tools/call. Results read from
// structuredContent first, else JSON in text blocks.

import { VIEWER, type Store } from './store.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'git-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const TOOL_ALIASES: Record<string, string> = {
  createrepository: 'create_repo',
  getrepository: 'get_repo',
  issuecreate: 'create_issue',
  issueslist: 'list_issues',
  createpr: 'create_pull_request',
  prcreate: 'create_pull_request',
  mergepr: 'merge_pull_request',
  prmerge: 'merge_pull_request',
  githubcreateissue: 'create_issue',
  githubcreaterepo: 'create_repo',
  githubgetrepo: 'get_repo',
  githublistissues: 'list_issues',
  githubcreatepullrequest: 'create_pull_request',
  githubmergepullrequest: 'merge_pull_request',
};

function canonicalTool(name: string): string | null {
  const norm = normalizeToolName(name);
  for (const tool of MCP_TOOLS) if (normalizeToolName(tool.name) === norm) return tool.name;
  return TOOL_ALIASES[norm] ?? null;
}

function pickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined) return args[n];
  return undefined;
}

function ownerOf(args: Record<string, unknown>): string {
  const v = pickArg(args, 'owner', 'owner_login', 'org', 'login');
  if (typeof v === 'string' && v !== '') return v;
  const full = pickArg(args, 'full_name');
  if (typeof full === 'string' && full.includes('/')) return full.split('/')[0] as string;
  return VIEWER.login;
}

function repoOf(args: Record<string, unknown>): string {
  const v = pickArg(args, 'repo', 'repository', 'repo_name');
  if (typeof v === 'string' && v !== '') return v;
  const full = pickArg(args, 'full_name');
  if (typeof full === 'string' && full.includes('/')) return full.split('/')[1] as string;
  return '';
}

function textResult(text: string, structured?: unknown): Record<string, unknown> {
  const content = [{ type: 'text', text }];
  const out: Record<string, unknown> = { content, isError: false };
  if (structured !== undefined) out.structuredContent = structured;
  return out;
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Execute a tool call against the store. Returns the tool result object. */
export function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { result: Record<string, unknown>; rpcError?: { code: number; message: string } } {
  const canonical = canonicalTool(name);
  if (!canonical) return { result: {}, rpcError: { code: -32602, message: `unknown tool ${name}` } };
  const owner = ownerOf(args);
  const repoName = repoOf(args);
  switch (canonical) {
    case 'create_repo': {
      const repoNameArg = String(pickArg(args, 'name') ?? '');
      if (!repoNameArg) return { result: errorResult('missing required argument: name') };
      const existing = store.getRepo(owner, repoNameArg);
      if (existing) {
        const structured = { id: existing.id, name: existing.name, full_name: `${owner}/${repoNameArg}`, private: existing.isPrivate, default_branch: existing.defaultBranch };
        return { result: textResult(JSON.stringify(structured), structured) };
      }
      const repo = store.createRepo(repoNameArg, owner, pickArg(args, 'private') === true, String(pickArg(args, 'description') ?? ''));
      const structured = { id: repo.id, name: repo.name, full_name: `${owner}/${repoNameArg}`, private: repo.isPrivate, default_branch: repo.defaultBranch };
      return { result: textResult(JSON.stringify(structured), structured) };
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { result: errorResult(`repository ${owner}/${repoName} not found`) };
      const structured = { id: repo.id, name: repo.name, full_name: `${owner}/${repoName}`, private: repo.isPrivate, default_branch: repo.defaultBranch, description: repo.description };
      return { result: textResult(JSON.stringify(structured), structured) };
    }
    case 'create_issue': {
      const title = pickArg(args, 'title');
      if (title === undefined || title === '') return { result: errorResult('missing required argument: title') };
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { result: errorResult(`repository ${owner}/${repoName} not found`) };
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const issue = {
        id: number,
        number,
        title: String(title),
        body: String(pickArg(args, 'body') ?? ''),
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as { id: number; body: string }[],
        nextCommentId: 1,
      };
      repo.issues.push(issue);
      const structured = { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: 'open' };
      return { result: textResult(JSON.stringify(structured), structured) };
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { result: errorResult(`repository ${owner}/${repoName} not found`) };
      const state = pickArg(args, 'state');
      let list = [...repo.issues];
      if (typeof state === 'string' && state !== 'all') list = list.filter((i) => i.state === state.toLowerCase());
      const structured = list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return { result: textResult(JSON.stringify(structured), structured) };
    }
    case 'create_pull_request': {
      const title = pickArg(args, 'title');
      const head = String(pickArg(args, 'head', 'head_ref', 'source_branch') ?? '');
      const base = String(pickArg(args, 'base', 'base_ref', 'target_branch') ?? '');
      if (!title || !head || !base) return { result: errorResult('missing required argument: title, head or base') };
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { result: errorResult(`repository ${owner}/${repoName} not found`) };
      const headSha = repo.refs.get(`refs/heads/${head}`) ?? '';
      const baseSha = repo.refs.get(`refs/heads/${base}`) ?? '';
      const number = repo.nextPull;
      repo.nextPull += 1;
      const pr = {
        number,
        title: String(title),
        body: String(pickArg(args, 'body') ?? ''),
        state: 'open' as const,
        merged: false,
        merged_at: null as string | null,
        merge_commit_sha: null as string | null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        files: [] as { filename: string; status: string; additions: number; deletions: number; changes: number }[],
      };
      repo.pulls.push(pr);
      const structured = { id: number, number, title: pr.title, state: 'open', head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha } };
      return { result: textResult(JSON.stringify(structured), structured) };
    }
    case 'merge_pull_request': {
      const num = Number(pickArg(args, 'pull_number', 'pr_number', 'number'));
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { result: errorResult(`repository ${owner}/${repoName} not found`) };
      const pr = repo.pulls.find((p) => p.number === num);
      if (!pr) return { result: errorResult(`pull request ${num} not found`) };
      pr.merged = true;
      pr.state = 'closed';
      const structured = { number: pr.number, merged: true, state: 'closed' };
      return { result: textResult(JSON.stringify(structured), structured) };
    }
    default:
      return { result: {}, rpcError: { code: -32602, message: `unknown tool ${name}` } };
  }
}

export interface McpResponse {
  status: number;
  body: string | null; // null = empty body (notification)
  contentType: string;
}

/** Handle one MCP JSON-RPC request body (already parsed JSON or raw text). */
export function handleMcp(store: Store, rawBody: string, headers: Record<string, string | undefined>): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
    };
  }
  const msg = parsed as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const id = msg.id ?? null;
  const method = msg.method ?? '';
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const result = (value: unknown): McpResponse => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jsonrpc: '2.0', id, result: value }),
  });
  const error = (code: number, message: string, status = 200): McpResponse => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });
  if (method.startsWith('notifications/')) {
    return { status: 202, contentType: 'application/json', body: null };
  }
  switch (method) {
    case 'server/discover': {
      const serverInfo = { ...SERVER_INFO };
      return result({
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const requested = String((params as { protocolVersion?: unknown }).protocolVersion ?? '2025-11-25');
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return result({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: MCP_TOOLS });
    case 'tools/call': {
      const toolName = String((params as { name?: unknown }).name ?? '');
      const args = ((params as { arguments?: unknown }).arguments ?? {}) as Record<string, unknown>;
      const { result: toolResult, rpcError } = callTool(store, toolName, args);
      if (rpcError) return error(rpcError.code, rpcError.message);
      return result(toolResult);
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
  void headers;
}
