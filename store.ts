// In-memory store for the forge: git objects, refs, repos, issues, pulls.
// Deterministic: no Date.now(), no Math.random() anywhere in this file.
// Commit epochs come from a fixed base plus a per-repo counter.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});
/** Fixed epoch base for server-created commits (2025-01-01T00:00:00Z). */
export const EPOCH_BASE = 1_735_689_600;

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Git object id: SHA-1 over "<type> <size>\0" + content. */
export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string }[];
  nextCommentId: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string; // base tip at creation
  files: { filename: string; status: string; additions: number; deletions: number; changes: number }[];
}

export class Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch = 'main';
  refs = new Map<string, string>(); // ref name -> commit oid
  refFiles = new Map<string, Map<string, string>>(); // ref name -> path -> blob oid
  objects = new Map<string, GitObject>();
  labels = new Map<string, { name: string; color: string }>();
  issues: Issue[] = [];
  nextIssue = 1;
  pulls: Pull[] = [];
  nextPull = 1;
  seq = 0; // deterministic counter for server-created commits

  constructor(id: number, name: string, owner: string, isPrivate: boolean, description: string) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.isPrivate = isPrivate;
    this.description = description;
  }

  nextEpoch(): number {
    this.seq += 1;
    return EPOCH_BASE + this.seq * 60;
  }

  storeObject(type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  requestSeq = 0;

  key(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  createRepo(name: string, owner: string, isPrivate: boolean, description: string): Repo {
    const repo = new Repo(this.nextRepoId, name, owner, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  reposForOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }
}

// ---------------------------------------------------------------------------
// Commit / tree encoding (byte-exact git formats)
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const head = text.split('\n\n', 1)[0] ?? '';
  const message = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function encodeCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${author}\ncommitter ${committer}\n\n${message}\n`;
  return Buffer.from(out, 'utf8');
}

export function authorLine(epochSec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
}

/** Build a tree object from a path -> blob oid map. Returns the root tree oid. */
export function buildTree(repo: Repo, files: Map<string, string>): string {
  // Group by first path segment.
  const build = (prefix: string, paths: string[]): string => {
    interface Entry {
      name: string;
      mode: string;
      oid: string;
      isDir: boolean;
    }
    const entries: Entry[] = [];
    const dirs = new Map<string, string[]>();
    for (const path of paths) {
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ name: rest, mode: '100644', oid: files.get(path) ?? '', isDir: false });
      } else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, []);
        dirs.get(dir)?.push(path);
      }
    }
    for (const [dir, sub] of [...dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const subOid = build(`${prefix}${dir}/`, sub);
      entries.push({ name: dir, mode: '40000', oid: subOid, isDir: true });
    }
    // Git tree order: byte order, directories compared as name + '/'.
    entries.sort((a, b) => {
      const an = a.isDir ? `${a.name}/` : a.name;
      const bn = b.isDir ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const chunks: Buffer[] = [];
    for (const e of entries) {
      chunks.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      chunks.push(Buffer.from(e.oid, 'hex'));
    }
    return repo.storeObject('tree', Buffer.concat(chunks));
  };
  return build('', [...files.keys()].sort());
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0, space);
    if (space < 0 || nul < 0) break;
    const mode = data.subarray(i, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

/** Flatten a tree oid into path -> blob oid (files only). */
export function treeToFiles(repo: Repo, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.getObject(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else out.set(`${prefix}${e.name}`, e.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** Create a commit on a repo and store it; returns the commit oid. */
export function createCommit(
  repo: Repo,
  files: Map<string, string>,
  parents: string[],
  message: string,
  epochSec?: number,
): string {
  const tree = buildTree(repo, files);
  const epoch = epochSec ?? repo.nextEpoch();
  const line = authorLine(epoch);
  const data = encodeCommit(tree, parents, line, line, message);
  return repo.storeObject('commit', data);
}

/** All ancestors of a commit (including itself), in BFS order. */
export function commitClosure(repo: Repo, tips: string[]): Map<string, ParsedCommit> {
  const out = new Map<string, ParsedCommit>();
  const queue = [...tips];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (out.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    out.set(oid, parsed);
    for (const p of parsed.parents) queue.push(p);
  }
  return out;
}

/** Is `ancestor` an ancestor of (or equal to) `tip`? */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === ZERO_OID) return true;
  if (ancestor === tip) return true;
  const closure = commitClosure(repo, [tip]);
  return closure.has(ancestor);
}

/**
 * Objects reachable from `wants`, excluding anything reachable from `haves`.
 * Returns { objects: Map<oid, GitObject>, shallow: string[], unshallow: string[] }
 * where shallow lists included commits whose parent exists but is not included,
 * and unshallow lists client shallow boundaries whose parent is now included.
 * With depthLimit, only commits at depth < depthLimit from a want are included
 * (depth 1 = tip commit only).
 */
export function reachableObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depthLimit?: number,
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  // Held commits: haves that are NOT shallow boundaries. A shallow boundary
  // is held itself, but its ancestors are not — deepen relies on that, so it
  // must not prune the walk.
  const shallowSet = new Set(clientShallow);
  const heldCommits = haves.filter((h) => !shallowSet.has(h));
  const haveClosure = commitClosure(repo, heldCommits);
  // Every object reachable from a held commit is already on the client.
  const heldObjects = new Set<string>();
  const collectTreeInto = (treeOid: string, into: Set<string>): void => {
    const seenTrees = new Set<string>();
    const walk = (oid: string): void => {
      if (seenTrees.has(oid)) return;
      seenTrees.add(oid);
      const obj = repo.getObject(oid);
      if (!obj || obj.type !== 'tree') return;
      into.add(oid);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000') walk(e.oid);
        else into.add(e.oid);
      }
    };
    walk(treeOid);
  };
  for (const c of haveClosure) {
    heldObjects.add(c);
    const obj = repo.getObject(c);
    if (obj && obj.type === 'commit') collectTreeInto(parseCommit(obj.data).tree, heldObjects);
  }
  // The client also holds each have commit's own tree outright (even a
  // shallow boundary), so never re-send those trees/blobs either.
  const haveTipObjects = new Set<string>();
  for (const h of haves) {
    haveTipObjects.add(h);
    const obj = repo.getObject(h);
    if (obj && obj.type === 'commit') collectTreeInto(parseCommit(obj.data).tree, haveTipObjects);
  }
  const alreadyHeld = (oid: string): boolean => heldObjects.has(oid) || haveTipObjects.has(oid);

  const objects = new Map<string, GitObject>();
  const includedCommits = new Map<string, ParsedCommit>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  // BFS with depth. Haves prune the walk only via haveClosure (non-shallow
  // haves); the depth limit, not the haves, decides what a deepen includes.
  const queue: { oid: string; depth: number }[] = wants.map((oid) => ({ oid, depth: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (seen.has(oid) || oid === ZERO_OID) continue;
    seen.add(oid);
    if (haveClosure.has(oid)) continue; // held: exclude it and its ancestors
    const obj = repo.getObject(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      if (depthLimit !== undefined && depth >= depthLimit) continue;
      const parsed = parseCommit(obj.data);
      includedCommits.set(oid, parsed);
      for (const p of parsed.parents) queue.push({ oid: p, depth: depth + 1 });
    }
    if (!alreadyHeld(oid)) objects.set(oid, obj);
  }
  // Trees and blobs reachable from included commits, minus held objects.
  const addTree = (treeOid: string): void => {
    const obj = repo.getObject(treeOid);
    if (!obj || obj.type !== 'tree' || objects.has(treeOid) || alreadyHeld(treeOid)) return;
    objects.set(treeOid, obj);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') addTree(e.oid);
      else if (!alreadyHeld(e.oid)) {
        const blob = repo.getObject(e.oid);
        if (blob && !objects.has(e.oid)) objects.set(e.oid, blob);
      }
    }
  };
  for (const parsed of includedCommits.values()) addTree(parsed.tree);
  // Non-commit wants (e.g. tag objects): include the object and its target chain.
  for (const want of wants) {
    const obj = repo.getObject(want);
    if (!obj || objects.has(want)) continue;
    if (obj.type === 'tag') {
      objects.set(want, obj);
      const target = obj.data.toString('utf8').split('\n')[0]?.slice(7).trim() ?? '';
      if (target && target !== ZERO_OID) {
        const sub = reachableObjects(repo, [target], haves, [], depthLimit);
        for (const [k, v] of sub.objects) objects.set(k, v);
      }
    }
  }
  // Shallow / unshallow boundary computation.
  for (const [oid, parsed] of includedCommits) {
    for (const p of parsed.parents) {
      if (p === ZERO_OID) continue;
      if (!includedCommits.has(p) && !haveClosure.has(p) && repo.getObject(p)) {
        if (!shallow.includes(oid)) shallow.push(oid);
      }
    }
  }
  for (const boundary of clientShallow) {
    const obj = repo.getObject(boundary);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    const parentIncluded = parsed.parents.length === 0 || parsed.parents.every((p) => includedCommits.has(p));
    if (parentIncluded && includedCommits.has(boundary)) unshallow.push(boundary);
  }
  return { objects, shallow, unshallow };
}
