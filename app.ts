// The forge server: one process, stdlib only. Routes:
//   GET  /healthz
//   POST /mcp                     MCP streamable HTTP
//   POST /api/graphql             GraphQL v4
//   /api/v3/*                     REST v3
//   /{owner}/{repo}.git/*         git smart HTTP

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  VIEWER,
  Store,
  buildTree,
  createCommit,
  isAncestor,
  parseCommit,
  treeToFiles,
  type Repo,
} from './store.ts';
import {
  handleLsRefsV2,
  handleReceivePack,
  handleUploadPackV0,
  handleUploadPackV2,
  framePushReport,
  pktLine,
  pktFlush,
  sidebandPack,
  v0Advertisement,
  v2Advertisement,
  writePack,
  type RefInfo,
} from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const store = new Store();

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

function err(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { message }, headers);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ') && auth.slice(7).trim() !== '') return auth.slice(7).trim();
  return null;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function hostOf(req: IncomingMessage): string {
  return req.headers.host ?? '127.0.0.1';
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
  };
}

function issueJson(repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullJson(repo: Repo, pr: Repo['pulls'][number]): Record<string, unknown> {
  return {
    id: pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id },
  };
}

function commitList(repo: Repo, startOid: string): { sha: string; commit: { message: string; author: { name: string; email: string } } }[] {
  const out: { sha: string; commit: { message: string; author: { name: string; email: string } } }[] = [];
  const seen = new Set<string>();
  const queue = [startOid];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    const authorName = parsed.author.split('<')[0]?.trim() ?? VIEWER.name;
    const authorEmail = parsed.author.match(/<([^>]*)>/)?.[1] ?? VIEWER.email;
    out.push({ sha: oid, commit: { message: parsed.message.replace(/\n$/, ''), author: { name: authorName, email: authorEmail } } });
    for (const p of parsed.parents) queue.push(p);
  }
  return out;
}

function diffFiles(
  repo: Repo,
  baseFiles: Map<string, string>,
  headFiles: Map<string, string>,
): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const baseOid = baseFiles.get(path);
    const headOid = headFiles.get(path);
    if (baseOid === headOid) continue;
    const countLines = (oid: string | undefined): number => {
      if (!oid) return 0;
      const obj = repo.getObject(oid);
      if (!obj) return 0;
      const text = obj.data.toString('utf8');
      return text === '' ? 0 : text.split('\n').length;
    };
    if (baseOid === undefined) {
      const additions = countLines(headOid);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (headOid === undefined) {
      const deletions = countLines(baseOid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const additions = countLines(headOid);
      const deletions = countLines(baseOid);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// REST handler
// ---------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const segments = path.split('/').filter((s) => s !== '');
  // segments[0]='api', segments[1]='v3', rest follows.
  const rest = segments.slice(2);
  const token = bearerToken(req);

  // API root and meta are unauthenticated (starter behaviour).
  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }
  if (token === null) {
    err(res, 401, 'Requires authentication');
    return;
  }

  const rawBody = await readBody(req);
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) {
    err(res, 400, 'Problems parsing JSON');
    return;
  }
  const body = asObject(parsed.value);

  // GET /user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return;
  }
  // POST /user/repos
  if (method === 'POST' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    const name = String(body.name ?? '');
    if (!name) {
      err(res, 422, 'name is required');
      return;
    }
    if (store.getRepo(VIEWER.login, name)) {
      err(res, 422, 'Repository already exists');
      return;
    }
    const repo = store.createRepo(name, VIEWER.login, body.private === true, String(body.description ?? ''));
    sendJson(res, 201, repoJson(repo));
    return;
  }
  // GET /user/repos (paginated)
  if (method === 'GET' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
    const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
    const all = store.reposForOwner(VIEWER.login);
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    const headers: Record<string, string> = {};
    const base = `http://${hostOf(req)}/api/v3/user/repos?per_page=${perPage}`;
    const links: string[] = [];
    const totalPages = Math.max(1, Math.ceil(all.length / perPage));
    if (page < totalPages) links.push(`<${base}&page=${page + 1}>; rel="next"`);
    if (page > 1) links.push(`<${base}&page=${page - 1}>; rel="prev"`);
    links.push(`<${base}&page=1>; rel="first"`);
    links.push(`<${base}&page=${totalPages}>; rel="last"`);
    if (links.length > 0) headers.link = links.join(', ');
    sendJson(res, 200, slice.map((r) => repoJson(r)), headers);
    return;
  }

  // /repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1] as string);
    const repoName = decodeURIComponent(rest[2] as string);
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      err(res, 404, 'Not Found');
      return;
    }
    if (repo.isPrivate && token === null) {
      err(res, 401, 'Requires authentication');
      return;
    }
    const tail = rest.slice(3);

    // GET /repos/{o}/{r}
    if (method === 'GET' && tail.length === 0) {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    // PATCH /repos/{o}/{r}
    if (method === 'PATCH' && tail.length === 0) {
      if (typeof body.description === 'string') repo.description = body.description;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    // DELETE /repos/{o}/{r}
    if (method === 'DELETE' && tail.length === 0) {
      store.deleteRepo(owner, repoName);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    // GET /repos/{o}/{r}/branches and /branches/{branch}
    if (method === 'GET' && tail.length === 1 && tail[0] === 'branches') {
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) as string } }));
      sendJson(res, 200, list);
      return;
    }
    if (method === 'GET' && tail.length === 2 && tail[0] === 'branches') {
      const branch = decodeURIComponent(tail[1] as string);
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) {
        err(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: oid } });
      return;
    }
    // GET /repos/{o}/{r}/commits
    if (method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
      const shaParam = query.get('sha');
      let start = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (shaParam) {
        if (repo.refs.has(`refs/heads/${shaParam}`)) start = repo.refs.get(`refs/heads/${shaParam}`);
        else if (repo.getObject(shaParam)) start = shaParam;
        else start = undefined;
      }
      if (!start) {
        sendJson(res, 200, []);
        return;
      }
      sendJson(res, 200, commitList(repo, start));
      return;
    }
    // POST /repos/{o}/{r}/git/refs
    if (method === 'POST' && tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
      const ref = String(body.ref ?? '');
      const sha = String(body.sha ?? '');
      if (!ref.startsWith('refs/') || !repo.getObject(sha)) {
        err(res, 422, 'Invalid ref or sha');
        return;
      }
      repo.refs.set(ref, sha);
      const obj = repo.getObject(sha);
      if (obj && obj.type === 'commit') repo.refFiles.set(ref, treeToFiles(repo, parseCommit(obj.data).tree));
      sendJson(res, 201, { ref, object: { sha } });
      return;
    }
    // GET /repos/{o}/{r}/git/refs and /git/refs/heads/{branch}
    if (method === 'GET' && tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2) {
        const list = [...repo.refs.keys()].sort().map((r) => ({ ref: r, object: { sha: repo.refs.get(r) as string } }));
        sendJson(res, 200, list);
        return;
      }
      const refName = tail.slice(2).map((s) => decodeURIComponent(s)).join('/');
      const oid = repo.refs.get(refName);
      if (!oid) {
        err(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref: refName, object: { sha: oid } });
      return;
    }
    // POST /repos/{o}/{r}/labels
    if (method === 'POST' && tail.length === 1 && tail[0] === 'labels') {
      const name = String(body.name ?? '');
      const color = String(body.color ?? 'ededed');
      if (!name) {
        err(res, 422, 'name is required');
        return;
      }
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color });
      return;
    }
    // GET /repos/{o}/{r}/labels
    if (method === 'GET' && tail.length === 1 && tail[0] === 'labels') {
      sendJson(res, 200, [...repo.labels.values()]);
      return;
    }
    // Contents: PUT/GET/DELETE /repos/{o}/{r}/contents/{path...}
    if (tail.length >= 2 && tail[0] === 'contents') {
      const filePath = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const branchParam = query.get('branch') ?? (typeof body.branch === 'string' ? body.branch : undefined);
      const branch = branchParam ?? repo.defaultBranch;
      const refName = `refs/heads/${branch}`;
      if (method === 'PUT') {
        const message = String(body.message ?? '');
        const contentB64 = String(body.content ?? '');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          err(res, 422, 'content is not valid base64');
          return;
        }
        const currentFiles = new Map(repo.refFiles.get(refName) ?? new Map());
        const existingBlob = currentFiles.get(filePath);
        if (typeof body.sha === 'string' && body.sha !== '' && existingBlob !== undefined && body.sha !== existingBlob) {
          err(res, 409, 'sha does not match the current blob');
          return;
        }
        const isNew = existingBlob === undefined;
        const blobOid = repo.storeObject('blob', content);
        currentFiles.set(filePath, blobOid);
        const parents: string[] = [];
        const tip = repo.refs.get(refName);
        if (tip) parents.push(tip);
        const commitOid = createCommit(repo, currentFiles, parents, message);
        repo.refs.set(refName, commitOid);
        repo.refFiles.set(refName, currentFiles);
        sendJson(res, isNew ? 201 : 200, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobOid, encoding: 'base64', size: content.length, type: 'file' },
          commit: { sha: commitOid, message },
        });
        return;
      }
      if (method === 'GET') {
        const refParam = query.get('ref');
        let files: Map<string, string> | undefined;
        if (refParam) {
          const refKey = refParam.startsWith('refs/') ? refParam : `refs/heads/${refParam}`;
          files = repo.refFiles.get(refKey);
          if (!files && repo.refs.has(refKey)) {
            const tipObj = repo.getObject(repo.refs.get(refKey) as string);
            if (tipObj && tipObj.type === 'commit') files = treeToFiles(repo, parseCommit(tipObj.data).tree);
          }
        } else {
          files = repo.refFiles.get(refName);
        }
        if (!files) {
          err(res, 404, 'Not Found');
          return;
        }
        const blobOid = files.get(filePath);
        if (blobOid !== undefined) {
          const blob = repo.getObject(blobOid);
          const data = blob ? blob.data : Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            content: data.toString('base64'),
            sha: blobOid,
          });
          return;
        }
        // Directory listing.
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const entries: Record<string, unknown>[] = [];
        const seenDirs = new Set<string>();
        for (const p of [...files.keys()].sort()) {
          if (prefix !== '' && !p.startsWith(prefix)) continue;
          const restPath = prefix === '' ? p : p.slice(prefix.length);
          const slash = restPath.indexOf('/');
          if (slash < 0) {
            entries.push({ type: 'file', name: restPath, path: p, sha: files.get(p) as string });
          } else {
            const dir = restPath.slice(0, slash);
            if (!seenDirs.has(dir)) {
              seenDirs.add(dir);
              const subFiles = new Map<string, string>();
              for (const [k, v] of files) if (k.startsWith(`${prefix}${dir}/`)) subFiles.set(k.slice(prefix.length + dir.length + 1), v);
              entries.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: buildTree(repo, subFiles) });
            }
          }
        }
        if (entries.length === 0) {
          err(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, entries);
        return;
      }
      if (method === 'DELETE') {
        const sha = String(body.sha ?? '');
        const currentFiles = new Map(repo.refFiles.get(refName) ?? new Map());
        const existingBlob = currentFiles.get(filePath);
        if (existingBlob === undefined) {
          err(res, 404, 'Not Found');
          return;
        }
        if (sha !== '' && sha !== existingBlob) {
          err(res, 409, 'sha does not match the current blob');
          return;
        }
        currentFiles.delete(filePath);
        const parents: string[] = [];
        const tip = repo.refs.get(refName);
        if (tip) parents.push(tip);
        const commitOid = createCommit(repo, currentFiles, parents, String(body.message ?? ''));
        repo.refs.set(refName, commitOid);
        repo.refFiles.set(refName, currentFiles);
        sendJson(res, 200, { commit: { sha: commitOid } });
        return;
      }
    }
    // Issues
    if (tail.length >= 1 && tail[0] === 'issues') {
      // POST /issues
      if (method === 'POST' && tail.length === 1) {
        const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).map(String) : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            err(res, 422, `label ${label} does not exist`);
            return;
          }
        }
        const number = repo.nextIssue;
        repo.nextIssue += 1;
        const issue = {
          id: number,
          number,
          title: String(body.title ?? ''),
          body: String(body.body ?? ''),
          state: 'open' as const,
          labels,
          comments: [] as { id: number; body: string }[],
          nextCommentId: 1,
        };
        repo.issues.push(issue);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      // GET /issues (list)
      if (method === 'GET' && tail.length === 1) {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
        const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const start = (page - 1) * perPage;
        sendJson(res, 200, list.slice(start, start + perPage).map((i) => issueJson(repo, i)));
        return;
      }
      const issueNum = Number(tail[1]);
      const issue = repo.issues.find((i) => i.number === issueNum);
      // GET /issues/{n}
      if (method === 'GET' && tail.length === 2) {
        if (!issue) {
          err(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      // PATCH /issues/{n}
      if (method === 'PATCH' && tail.length === 2) {
        if (!issue) {
          err(res, 404, 'Not Found');
          return;
        }
        if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      // POST /issues/{n}/comments
      if (method === 'POST' && tail.length === 3 && tail[2] === 'comments') {
        if (!issue) {
          err(res, 404, 'Not Found');
          return;
        }
        const comment = { id: issue.nextCommentId, body: String(body.body ?? '') };
        issue.nextCommentId += 1;
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id } });
        return;
      }
      // GET /issues/{n}/comments
      if (method === 'GET' && tail.length === 3 && tail[2] === 'comments') {
        if (!issue) {
          err(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id } })));
        return;
      }
    }
    // Pulls
    if (tail.length >= 1 && tail[0] === 'pulls') {
      // POST /pulls
      if (method === 'POST' && tail.length === 1) {
        const headRef = String(body.head ?? '');
        const baseRef = String(body.base ?? repo.defaultBranch);
        const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
        const number = repo.nextPull;
        repo.nextPull += 1;
        const baseFiles = repo.refFiles.get(`refs/heads/${baseRef}`) ?? new Map();
        const headFiles = repo.refFiles.get(`refs/heads/${headRef}`) ?? new Map();
        const pr = {
          number,
          title: String(body.title ?? ''),
          body: String(body.body ?? ''),
          state: 'open' as const,
          merged: false,
          merged_at: null as string | null,
          merge_commit_sha: null as string | null,
          headRef,
          baseRef,
          headSha,
          baseSha,
          files: diffFiles(repo, baseFiles, headFiles),
        };
        repo.pulls.push(pr);
        sendJson(res, 201, pullJson(repo, pr));
        return;
      }
      // GET /pulls (list)
      if (method === 'GET' && tail.length === 1) {
        const state = query.get('state');
        let list = [...repo.pulls];
        if (state === 'all') {
          // keep all
        } else if (state === 'closed') {
          list = list.filter((p) => p.state === 'closed');
        } else {
          list = list.filter((p) => p.state === 'open');
        }
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
        const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
        const start = (page - 1) * perPage;
        sendJson(res, 200, list.slice(start, start + perPage).map((p) => pullJson(repo, p)));
        return;
      }
      const pullNum = Number(tail[1]);
      const pr = repo.pulls.find((p) => p.number === pullNum);
      // GET /pulls/{n}
      if (method === 'GET' && tail.length === 2) {
        if (!pr) {
          err(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, pullJson(repo, pr));
        return;
      }
      // GET /pulls/{n}/files
      if (method === 'GET' && tail.length === 3 && tail[2] === 'files') {
        if (!pr) {
          err(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, pr.files);
        return;
      }
      // PUT /pulls/{n}/merge
      if (method === 'PUT' && tail.length === 3 && tail[2] === 'merge') {
        if (!pr) {
          err(res, 404, 'Not Found');
          return;
        }
        if (pr.merged) {
          sendJson(res, 200, { merged: true, sha: pr.merge_commit_sha, message: 'Pull request already merged' });
          return;
        }
        const baseRefName = `refs/heads/${pr.baseRef}`;
        const baseTip = repo.refs.get(baseRefName) ?? '';
        const headFiles = repo.refFiles.get(`refs/heads/${pr.headRef}`) ?? new Map();
        const baseFilesNow = repo.refFiles.get(baseRefName) ?? new Map();
        const baseFilesAtPr = (() => {
          const tipObj = repo.getObject(pr.baseSha);
          if (tipObj && tipObj.type === 'commit') return treeToFiles(repo, parseCommit(tipObj.data).tree);
          return new Map<string, string>();
        })();
        // Conflict: a file changed on the head side was also changed on the base side
        // since the PR was opened, to different content.
        let conflict = false;
        for (const [path, headBlob] of headFiles) {
          const atPr = baseFilesAtPr.get(path);
          const now = baseFilesNow.get(path);
          if (atPr !== headBlob && now !== undefined && now !== atPr && now !== headBlob) {
            conflict = true;
            break;
          }
        }
        if (conflict) {
          err(res, 405, 'Merge conflict');
          return;
        }
        const epoch = repo.nextEpoch();
        const mergeMessage = `Merge pull request #${pr.number} from ${pr.headRef}`;
        const mergeOid = createCommit(repo, new Map(headFiles), baseTip ? [baseTip] : [], mergeMessage, epoch);
        repo.refs.set(baseRefName, mergeOid);
        repo.refFiles.set(baseRefName, new Map(headFiles));
        pr.merged = true;
        pr.state = 'closed';
        pr.merged_at = new Date(epoch * 1000).toISOString();
        pr.merge_commit_sha = mergeOid;
        sendJson(res, 200, { merged: true, sha: mergeOid, message: mergeMessage });
        return;
      }
    }
  }

  // Unknown route under /api/v3.
  err(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Git smart HTTP handler
// ---------------------------------------------------------------------------

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET';
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!match) {
    err(res, 404, 'Not Found');
    return;
  }
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const suffix = match[3] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    err(res, 404, 'Not Found');
    return;
  }
  const query = queryOf(req);
  if (method === 'GET' && suffix === '/info/refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      err(res, 400, 'Bad Request');
      return;
    }
    const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    const contentType = `application/x-${service}-advertisement`;
    sendRaw(res, 200, body, contentType);
    return;
  }
  if (method === 'POST' && suffix === '/git-upload-pack') {
    const rawBody = await readBody(req);
    try {
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const out = isV2 ? handleUploadPackV2(repo, rawBody) : handleUploadPackV0(repo, rawBody);
      sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
    } catch {
      err(res, 400, 'Bad Request');
    }
    return;
  }
  if (method === 'POST' && suffix === '/git-receive-pack') {
    const rawBody = await readBody(req);
    try {
      const result = handleReceivePack(repo, rawBody);
      const framed = framePushReport(result);
      sendRaw(res, 200, framed, 'application/x-git-receive-pack-result');
    } catch {
      err(res, 400, 'Bad Request');
    }
    return;
  }
  err(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(200, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          if (method !== 'POST') {
            err(res, 405, 'Method Not Allowed');
            return;
          }
          if (bearerToken(req) === null) {
            err(res, 401, 'Requires authentication');
            return;
          }
          const rawBody = await readBody(req);
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
          const out = handleMcp(store, rawBody.toString('utf8'), headers);
          if (out.body === null) {
            res.writeHead(out.status, { 'x-github-request-id': nextRequestId() });
            res.end();
          } else {
            sendJson(res, out.status, JSON.parse(out.body));
          }
          return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            err(res, 405, 'Method Not Allowed');
            return;
          }
          if (bearerToken(req) === null) {
            err(res, 401, 'Requires authentication');
            return;
          }
          const rawBody = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((op) => {
              const o = asObject(op);
              return executeGraphQL(store, String(o.query ?? ''), asObject(o.variables));
            });
            sendJson(res, 200, results);
            return;
          }
          const op = asObject(parsed);
          const result = executeGraphQL(store, String(op.query ?? ''), asObject(op.variables));
          sendJson(res, 200, result);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, path);
          return;
        }
        if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
          await handleGit(req, res, path);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        try {
          err(res, 500, e instanceof Error ? e.message : 'Internal Server Error');
        } catch {
          // response already gone
        }
      }
    })();
  });
}
