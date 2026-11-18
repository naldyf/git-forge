// Git smart HTTP: pkt-line framing, packfile read/write, v0/v2 upload-pack,
// ls-refs, receive-pack. Stdlib only (node:zlib, node:crypto via store).

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  type GitObject,
  type ObjectType,
  type Repo,
  commitClosure,
  isAncestor,
  objectId,
  parseCommit,
  reachableObjects,
  treeToFiles,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Decode a whole buffer of pkt-lines. Malformed input throws. */
export function decodePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') {
      out.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (hex === '0001') {
      out.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (hex === '0002') {
      out.push({ kind: 'response-end' });
      i += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

export function pktTextLines(pkts: Pkt[]): string[] {
  const out: string[] = [];
  for (const p of pkts) if (p.kind === 'data') out.push(p.payload.toString('utf8'));
  return out;
}

// ---------------------------------------------------------------------------
// packfile write (plain objects, no deltas) and read (with deltas)
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePack(objects: { type: ObjectType; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const obj of objects) {
    const typeCode = TYPE_CODES[obj.type];
    const size = obj.data.length;
    // varint header: low 4 bits size, bits 4-6 type, MSB continuation, then 7-bit groups.
    const bytes: number[] = [];
    let s = size;
    let first = (s & 0x0f) | (typeCode << 4);
    s >>= 4;
    if (s > 0) first |= 0x80;
    bytes.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>= 7;
      if (s > 0) b |= 0x80;
      bytes.push(b);
    }
    chunks.push(Buffer.from(bytes));
    chunks.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = buf[pos] ?? 0;
  let next = pos + 1;
  let shift = 7;
  while ((buf[next - 1] ?? 0) & 0x80) {
    value |= (buf[next] ?? 0) << shift;
    shift += 7;
    next += 1;
  }
  return { value, next };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaVarint = (): number => {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = delta[pos] as number;
      pos += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return v;
  };
  const srcSize = readDeltaVarint();
  const tgtSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (outLen !== tgtSize || result.length !== tgtSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ParsedPack {
  objects: Map<string, GitObject>;
}

/** Parse a packfile, resolving OFS/REF deltas (thin-pack bases via haveObjects). */
export function readPack(pack: Buffer, haveObjects?: Map<string, GitObject>): ParsedPack {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  // First pass: raw entries with their offsets.
  interface RawEntry {
    offset: number;
    type: ObjectType | 'ofs-delta' | 'ref-delta';
    size: number;
    data: Buffer; // inflated (delta bytes for delta entries)
    baseOffset?: number;
    baseOid?: string;
  }
  const entries: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let b = pack[pos] as number;
    pos += 1;
    const typeCode = (b >> 4) & 0x7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[pos] as number;
      pos += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    let type: ObjectType | 'ofs-delta' | 'ref-delta';
    if (typeCode === 6) {
      type = 'ofs-delta';
      b = pack[pos] as number;
      pos += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - offset;
    } else if (typeCode === 7) {
      type = 'ref-delta';
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else {
      type = CODE_TYPES[typeCode] as ObjectType;
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(pos));
    // inflateSync consumes the whole remaining buffer; find the consumed length by
    // re-inflating with a streaming approach is complex — instead use zlib inflate with
    // explicit end: Node's inflateSync returns only the inflated data; to advance pos we
    // use a manual decompress via `zlib` inflate with dictionary? Simpler: use
    // `inflateSync` on a slice is impossible to know the boundary. Use the sync
    // decompress through `node:zlib`'s `inflateSync` with a trick: decompress
    // incrementally by trying lengths is O(n^2). Instead, use `zlib.createInflateRaw`?
    // Pack entries are zlib streams (with header). We compute consumed bytes by
    // inflating with `inflateSync` over the whole tail and measuring via a second
    // approach: use `zlib`'s `inflate` with `finished` callback is async.
    // Practical approach: use `zlib.inflateSync` on the tail and find the end by
    // scanning: a zlib stream ends with an Adler-32; the deflate stream's last block
    // ends at a bit boundary. We instead use `Brotli`? No.
    // Fallback: use Node's `zlib` synchronous inflate via `inflateSync` on progressively
    // larger slices is too slow for large packs, but our packs are small (suite pushes
    // are <= ~100 files). We use a streaming inflate synchronously with a custom
    // implementation: `zlib.createInflate()` is async-only. So we do the slice search
    // with binary search on the end position.
    const end = findZlibEnd(pack, pos);
    entries.push({ offset: start, type, size, data: inflated, baseOffset, baseOid });
    pos = end;
    void end;
  }
  // Resolve entries.
  const resolve = (entry: RawEntry, depth = 0): GitObject => {
    if (depth > 64) throw new Error('delta chain too deep');
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      if (entry.type === 'ofs-delta') {
        const baseEntry = entries.find((e) => e.offset === entry.baseOffset);
        if (!baseEntry) throw new Error('ofs-delta base not in pack');
        base = resolve(baseEntry, depth + 1);
      } else {
        const oid = entry.baseOid as string;
        base = objects.get(oid) ?? haveObjects?.get(oid);
        if (!base) {
          const baseEntry = entries.find((e) => objectIdForEntry(e, resolve, depth) === oid);
          if (baseEntry) base = resolve(baseEntry, depth + 1);
        }
        if (!base) throw new Error(`ref-delta base ${oid} not found`);
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    return { type: entry.type as ObjectType, data: entry.data };
  };
  for (const entry of entries) {
    const obj = resolve(entry);
    objects.set(objectId(obj.type, obj.data), obj);
  }
  return { objects };
}

/** Find the end offset of a zlib stream starting at pos (binary search on inflate). */
function findZlibEnd(buf: Buffer, pos: number): number {
  // A zlib stream's end is the smallest end such that inflateSync(buf[pos:end]) succeeds
  // and the stream is complete. Binary search over [pos+2, buf.length].
  let lo = pos + 2;
  let hi = buf.length;
  let best = hi;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(pos, mid));
      best = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  return best;
}

function objectIdForEntry(entry: { type: string; data: Buffer }, resolve: (e: never, d?: number) => GitObject, depth: number): string {
  const obj = resolve(entry as never, depth + 1);
  return objectId(obj.type, obj.data);
}

// ---------------------------------------------------------------------------
// Ref listing helpers
// ---------------------------------------------------------------------------

export interface RefInfo {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

export function listRefs(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  const names = [...repo.refs.keys()].sort();
  // HEAD first (as a ref pointing at the default branch).
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(defaultRef) ?? ZERO_OID;
  out.push({ name: 'HEAD', oid: headOid, symrefTarget: defaultRef, unborn: headOid === ZERO_OID });
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const info: RefInfo = { name, oid };
    // Peeled tag: if ref is an annotated tag, peel to the commit.
    const obj = repo.getObject(oid);
    if (obj && obj.type === 'tag') {
      const target = obj.data.toString('utf8').split('\n')[0]?.slice(7).trim() ?? '';
      if (target) info.peeled = target;
    }
    out.push(info);
  }
  return out;
}

export const UPLOAD_CAPS_V0 =
  'multi_ack_detailed side-band-64k thin-pack ofs-delta report-status agent=git-forge/1.0 object-format=sha1 symref=HEAD:refs/heads/main delete-refs shallow';
export const RECEIVE_CAPS_V0 =
  'report-status side-band-64k ofs-delta delete-refs agent=git-forge/1.0 object-format=sha1';

/** v0 advertisement body for a service. */
export function v0Advertisement(repo: Repo, service: string): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(pktLine(`# service=${service}\n`));
  chunks.push(pktFlush());
  const refs = listRefs(repo);
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const nonHead = refs.filter((r) => r.name !== 'HEAD');
  if (nonHead.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      const line = `${ref.oid} ${ref.name}${first ? `\0${caps}` : ''}\n`;
      chunks.push(pktLine(line));
      first = false;
      if (ref.peeled) chunks.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** v2 capability advertisement body (upload-pack only). */
export function v2Advertisement(): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(pktLine('# service=git-upload-pack\n'));
  chunks.push(pktFlush());
  const lines = [
    'version 2',
    'agent=git-forge/1.0',
    'ls-refs=unborn',
    'fetch=shallow filter',
    'object-format=sha1',
  ];
  for (const line of lines) chunks.push(pktLine(`${line}\n`));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** Sideband-framed pack bytes: pkt-lines with a 1-byte band prefix (band 1). */
export function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const MAX = 60000;
  for (let i = 0; i < pack.length; i += MAX) {
    const slice = pack.subarray(i, Math.min(pack.length, i + MAX));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// upload-pack (v2 and v0) and ls-refs
// ---------------------------------------------------------------------------

export interface FetchParams {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot?: string[];
  filter?: string;
}

export function computeFetch(repo: Repo, params: FetchParams): {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
} {
  const { objects, shallow, unshallow } = reachableObjects(repo, params.wants, params.haves, params.shallow, params.depth);
  return { objects, shallow, unshallow };
}

export function packFromObjects(objects: Map<string, GitObject>): Buffer | null {
  if (objects.size === 0) return null;
  // Deterministic order: commits, tags, trees, blobs, each sorted by oid.
  const order: ObjectType[] = ['commit', 'tag', 'tree', 'blob'];
  const list: { type: ObjectType; data: Buffer }[] = [];
  for (const type of order) {
    const oids = [...objects.keys()].filter((oid) => objects.get(oid)?.type === type).sort();
    for (const oid of oids) {
      const obj = objects.get(oid) as GitObject;
      list.push({ type: obj.type, data: obj.data });
    }
  }
  return writePack(list);
}

/** Handle POST /git-upload-pack with a v2 request body. Returns response bytes. */
export function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const pkts = decodePkts(body);
  const lines = pktTextLines(pkts);
  const params: FetchParams = { wants: [], haves: [], shallow: [] };
  let section = 'command';
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'command=fetch') continue;
    if (text === 'command=ls-refs') return handleLsRefsV2(repo, body);
    if (text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    if (text === 'thin-pack' || text === 'no-progress' || text === 'ofs-delta') continue;
    if (text.startsWith('filter ')) {
      params.filter = text.slice(7);
      continue;
    }
    if (text.startsWith('want ')) params.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) params.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) params.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) params.depth = parseInt(text.slice(7), 10);
    else if (text.startsWith('deepen-since ')) params.deepenSince = parseInt(text.slice(13), 10);
    else if (text.startsWith('deepen-not ')) {
      params.deepenNot = [...(params.deepenNot ?? []), text.slice(11).trim()];
    }
    void section;
  }
  const { objects, shallow, unshallow } = computeFetch(repo, params);
  const pack = packFromObjects(objects);
  const chunks: Buffer[] = [];
  // acknowledgments
  chunks.push(pktLine('acknowledgments\n'));
  if (params.haves.length > 0) {
    for (const have of params.haves) {
      if (repo.getObject(have)) chunks.push(pktLine(`ACK ${have}\n`));
    }
    chunks.push(pktLine('ready\n'));
  } else {
    chunks.push(pktLine('NAK\n'));
  }
  chunks.push(pktFlush());
  // shallow-info
  if (shallow.length > 0 || unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(pktFlush());
  }
  // wanted-refs
  const refs = listRefs(repo);
  const wanted = refs.filter((r) => params.wants.includes(r.oid) && r.name !== 'HEAD');
  if (wanted.length > 0) {
    chunks.push(pktLine('wanted-refs\n'));
    for (const r of wanted) chunks.push(pktLine(`${r.oid} ${r.name}\n`));
    chunks.push(pktFlush());
  }
  // packfile
  if (pack !== null) {
    chunks.push(pktLine('packfile\n'));
    chunks.push(sidebandPack(pack));
    chunks.push(pktFlush());
  }
  return Buffer.concat(chunks);
}

/** Handle POST /git-upload-pack with a v2 ls-refs request body. */
export function handleLsRefsV2(repo: Repo, body: Buffer): Buffer {
  const lines = pktTextLines(decodePkts(body));
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice(11));
  }
  const chunks: Buffer[] = [];
  const refs = listRefs(repo);
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;
    if (ref.unborn) {
      const extra = symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
      chunks.push(pktLine(`unborn ${ref.name}${extra}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** Handle POST /git-upload-pack with a v0 request body. Returns response bytes. */
export function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const pkts = decodePkts(body);
  const params: FetchParams = { wants: [], haves: [], shallow: [] };
  let inSecondSection = false;
  for (const p of pkts) {
    if (p.kind === 'flush') {
      inSecondSection = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    // First want line may carry capabilities after a space: "want <oid> <caps>".
    if (text.startsWith('want ')) {
      params.wants.push(text.slice(5).split(' ')[0] as string);
    } else if (text.startsWith('have ')) params.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) params.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) params.depth = parseInt(text.slice(7), 10);
    else if (text.startsWith('deepen-since ')) params.deepenSince = parseInt(text.slice(13), 10);
    else if (text.startsWith('deepen-not ')) {
      params.deepenNot = [...(params.deepenNot ?? []), text.slice(11).trim()];
    }
    void inSecondSection;
  }
  const { objects, shallow, unshallow } = computeFetch(repo, params);
  const pack = packFromObjects(objects);
  const chunks: Buffer[] = [];
  // Bare ACK/NAK/shallow lines (not sideband).
  if (params.haves.length > 0) {
    for (const have of params.haves) {
      if (repo.getObject(have)) chunks.push(pktLine(`ACK ${have}\n`));
    }
  } else {
    chunks.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  if (pack !== null) chunks.push(sidebandPack(pack));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushResult {
  unpackOk: boolean;
  results: { ref: string; ok: boolean; reason: string }[];
}

/** Apply a receive-pack request. Returns the report text (without framing). */
export function handleReceivePack(repo: Repo, body: Buffer): PushResult {
  const commands: PushCommand[] = [];
  let packStart = body.length;
  // Parse pkt-lines only until the flush packet; everything after it is the
  // raw packfile, not pkt-line framed, so never decode it as pkt-lines.
  let i = 0;
  let flushEnd = -1;
  while (i + 4 <= body.length) {
    const hex = body.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') {
      flushEnd = i + 4;
      break;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > body.length) break;
    const payload = body.subarray(i + 4, i + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const cmdText = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = cmdText.split(' ');
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0] as string) && /^[0-9a-f]{40}$/.test(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
    i += len;
  }
  if (flushEnd >= 0) packStart = flushEnd;
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes);
      for (const [oid, obj] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
    }
  }
  const results: PushResult['results'] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    // Old-oid must match the current tip (unless creating).
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    } else if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      repo.refs.delete(cmd.ref);
      repo.refFiles.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    // New tip must exist and descend from old (fast-forward), unless old is zero.
    const obj = repo.getObject(cmd.newOid);
    if (!obj || (obj.type !== 'commit' && obj.type !== 'tag')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.oldOid !== ZERO_OID && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    // Recompute the ref's file map from the new tip's tree.
    const tipObj = repo.getObject(cmd.newOid);
    if (tipObj && tipObj.type === 'tag') {
      const target = tipObj.data.toString('utf8').split('\n')[0]?.slice(7).trim() ?? '';
      const commit = repo.getObject(target);
      if (commit && commit.type === 'commit') {
        repo.refFiles.set(cmd.ref, treeToFiles(repo, parseCommit(commit.data).tree));
      }
    } else if (tipObj && tipObj.type === 'commit') {
      repo.refFiles.set(cmd.ref, treeToFiles(repo, parseCommit(tipObj.data).tree));
    }
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  void commitClosure;
  return { unpackOk, results };
}

/** Frame a push report as sideband band-1 pkt-lines (report-status stream). */
export function framePushReport(result: PushResult): Buffer {
  let text = result.unpackOk ? 'unpack ok\n' : 'unpack error\n';
  for (const r of result.results) {
    text += r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`;
  }
  const inner = pktLine(text);
  return pktLine(Buffer.concat([Buffer.from([1]), inner]));
}
