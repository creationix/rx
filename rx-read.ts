///////////////////////////////////////////////////////////////////
//
// RX Reader — decoder for the paired-delimiter RX format.
//
// Top-level API:
//   decode(data)  — main entry; returns native or lazy-proxy values
//   parse(text)   — same, from a string
//   open(data)    — alias for decode (for symmetry with the encoder API)
//
// Decoding strategy:
//   - Containers WITHOUT an index → eager decode to a native JS object/array
//   - Containers WITH an index    → lazy Proxy that defers child decoding
//                                    until property access (uses the index
//                                    for O(1) array element / O(log n) object
//                                    key lookup)
//
//////////////////////////////////////////////////////////////////

import { isB64, fromZigZag, b64decodeTable } from "./rx.ts";

const td = new TextDecoder();
const te = new TextEncoder();

// ── Tag bytes ──────────────────────────────────────────────────
const T_PLUS = 43;     // +
const T_STAR = 42;     // *
const T_COMMA = 44;    // ,
const T_QUOTE = 39;    // '
const T_CARET = 94;    // ^
const T_HASH = 35;     // #
const T_DOT = 46;      // .
const T_AT = 64;       // @
const T_LBRACK = 91;   // [
const T_RBRACK = 93;   // ]
const T_LBRACE = 123;  // {
const T_RBRACE = 125;  // }
const T_LANGLE = 60;   // <
const T_RANGLE = 62;   // >

// ── b64 helpers ────────────────────────────────────────────────

function readB64(data: Uint8Array, start: number, end: number): number {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 64 + b64decodeTable[data[i]!]!;
  return v;
}

// Find the tag for the value whose right edge is at `right` (exclusive).
function findTag(data: Uint8Array, right: number): { tag: number; tagPos: number } {
  let p = right;
  while (--p >= 0 && isB64(data[p]!));
  return { tag: data[p]!, tagPos: p };
}

// Read an index header ending at `right`. Returns null if no `#`-tagged node ends here.
interface IndexInfo {
  count: number;
  width: number;
  entriesStart: number;
  entriesEnd: number;
  base: number;       // delta reference point = entriesStart
  leftEdge: number;
}

function tryReadIndex(data: Uint8Array, right: number): IndexInfo | null {
  const { tag, tagPos } = findTag(data, right);
  if (tag !== T_HASH) return null;
  const packed = readB64(data, tagPos + 1, right);
  const width = (packed & 7) + 1;
  const count = packed >>> 3;
  const entriesEnd = tagPos;
  const entriesStart = entriesEnd - count * width;
  return { count, width, entriesStart, entriesEnd, base: entriesStart, leftEdge: entriesStart };
}

// Read entry i (natural order) of an index — returns the byte position of the
// right edge of the value/key being indexed.
function indexEntryTarget(data: Uint8Array, idx: IndexInfo, i: number): number {
  // Entries are stored in REVERSE natural order; entry[i] sits at L-to-R
  // position (count - 1 - i) in the entries region.
  const off = idx.entriesStart + (idx.count - 1 - i) * idx.width;
  const delta = readB64(data, off, off + idx.width);
  return idx.base - delta;
}

// ── Refs ───────────────────────────────────────────────────────

function decodeRefName(name: string): unknown {
  switch (name) {
    case "t": return true;
    case "f": return false;
    case "n": return null;
    case "u": return undefined;
    case "inf": return Infinity;
    case "nif": return -Infinity;
    case "nan": return NaN;
    default: return Symbol.for(name);
  }
}

// ── Bytes ──────────────────────────────────────────────────────

function decodeBytesBody(data: Uint8Array, bodyStart: number, bodyEnd: number): Uint8Array {
  const L = bodyEnd - bodyStart;
  if (L === 0) return new Uint8Array(0);
  const m = L & 3;
  let outLen: number;
  if (m === 0) outLen = (L * 3) >> 2;
  else if (m === 2) outLen = (3 * L - 2) >> 2;
  else if (m === 3) outLen = (3 * L - 1) >> 2;
  else throw new SyntaxError(`Bytes body length ${L} (mod 4 = 1) is invalid`);
  const out = new Uint8Array(outLen);
  let oi = 0;
  let bits = 0;
  let buf = 0;
  for (let i = bodyStart; i < bodyEnd; i++) {
    const v = b64decodeTable[data[i]!]!;
    if (v === 0xff) throw new SyntaxError(`Invalid b64 char in bytes body at ${i}`);
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[oi++] = (buf >>> bits) & 0xff;
    }
  }
  return out;
}

// ── Decode ─────────────────────────────────────────────────────

interface DecodeResult {
  value: unknown;
  leftEdge: number;
}

function decodeNode(data: Uint8Array, right: number): DecodeResult {
  const { tag, tagPos } = findTag(data, right);
  const vStart = tagPos + 1;

  switch (tag) {
    case T_PLUS:
      return { value: fromZigZag(readB64(data, vStart, right)), leftEdge: tagPos };

    case T_STAR: {
      const exp = fromZigZag(readB64(data, vStart, right));
      const base = decodeNode(data, tagPos);
      return { value: (base.value as number) * Math.pow(10, exp), leftEdge: base.leftEdge };
    }

    case T_COMMA: {
      const len = readB64(data, vStart, right);
      const bodyStart = tagPos - len;
      return { value: td.decode(data.subarray(bodyStart, tagPos)), leftEdge: bodyStart };
    }

    case T_QUOTE: {
      const name = td.decode(data.subarray(vStart, right));
      return { value: decodeRefName(name), leftEdge: tagPos };
    }

    case T_CARET: {
      const delta = readB64(data, vStart, right);
      const target = tagPos - delta;
      // Resolve transparently: pointer span is [tagPos, right), but value is
      // whatever sits at target.
      return { value: decodeNode(data, target).value, leftEdge: tagPos };
    }

    case T_AT: {
      const len = readB64(data, vStart, right);
      const bodyStart = tagPos - len;
      return { value: decodeBytesBody(data, bodyStart, tagPos), leftEdge: bodyStart };
    }

    case T_RBRACK:
      return decodeArray(data, tagPos);

    case T_RBRACE:
      return decodeObject(data, tagPos);

    case T_RANGLE:
      return decodeChain(data, tagPos);

    default:
      throw new SyntaxError(`Unknown tag ${String.fromCharCode(tag)} (0x${tag.toString(16)}) at ${tagPos}`);
  }
}

// ── Array decoding ─────────────────────────────────────────────

function decodeArray(data: Uint8Array, closerPos: number): DecodeResult {
  // closerPos points at `]`. Body is to the left, may end with an index.
  const idx = tryReadIndex(data, closerPos);
  if (idx) return decodeIndexedArray(data, idx);

  // Non-indexed: eagerly decode all children R-to-L (which yields natural order).
  const children: unknown[] = [];
  let cursor = closerPos;
  while (true) {
    if (cursor <= 0) throw new SyntaxError("Array opener not found");
    const peek = findTag(data, cursor);
    if (peek.tag === T_LBRACK) {
      return { value: children, leftEdge: peek.tagPos };
    }
    const res = decodeNode(data, cursor);
    children.push(res.value);
    cursor = res.leftEdge;
  }
}

function decodeIndexedArray(data: Uint8Array, idx: IndexInfo): DecodeResult {
  // To find the container's left edge: the leftmost-in-byte-order child has the
  // largest delta = entries[count-1] in natural order = the entry stored at
  // L-to-R position 0 in the entries region.
  let leftEdge: number;
  if (idx.count === 0) {
    leftEdge = idx.leftEdge - 1;
  } else {
    const lastEntry = readB64(data, idx.entriesStart, idx.entriesStart + idx.width);
    const leftmostChildRight = idx.base - lastEntry;
    const leftmost = decodeNode(data, leftmostChildRight);
    leftEdge = leftmost.leftEdge - 1;
  }
  if (data[leftEdge] !== T_LBRACK) {
    throw new SyntaxError(`Array opener missing at ${leftEdge}`);
  }
  return { value: makeLazyArray(data, idx), leftEdge };
}

function makeLazyArray(data: Uint8Array, idx: IndexInfo): unknown[] {
  const cache: Map<number, unknown> = new Map();
  const target: any[] = [];
  return new Proxy(target, {
    get(t, prop, recv) {
      if (prop === "length") return idx.count;
      if (prop === Symbol.iterator) {
        return function* () {
          for (let i = 0; i < idx.count; i++) yield (recv as any)[i];
        };
      }
      if (typeof prop === "string") {
        const i = +prop;
        if (Number.isInteger(i) && i >= 0 && i < idx.count) {
          if (cache.has(i)) return cache.get(i);
          const childRight = indexEntryTarget(data, idx, i);
          const v = decodeNode(data, childRight).value;
          cache.set(i, v);
          return v;
        }
      }
      return Reflect.get(t, prop, recv);
    },
    has(_, prop) {
      if (typeof prop === "string") {
        const i = +prop;
        return Number.isInteger(i) && i >= 0 && i < idx.count;
      }
      return false;
    },
    ownKeys() {
      const keys: string[] = [];
      for (let i = 0; i < idx.count; i++) keys.push(String(i));
      keys.push("length");
      return keys;
    },
    getOwnPropertyDescriptor(_, prop) {
      if (prop === "length") {
        return { value: idx.count, writable: false, enumerable: false, configurable: true };
      }
      if (typeof prop === "string") {
        const i = +prop;
        if (Number.isInteger(i) && i >= 0 && i < idx.count) {
          return { value: undefined, writable: false, enumerable: true, configurable: true };
        }
      }
      return undefined;
    },
  });
}

// ── Object decoding ────────────────────────────────────────────

function decodeObject(data: Uint8Array, closerPos: number): DecodeResult {
  // closerPos points at `}`. Body may have a schema OR an index at the right end.
  let cursor = closerPos;
  const peek1 = findTag(data, cursor);

  // Schema check: rightmost child can be inline `.` or `^` pointing to one.
  if (peek1.tag === T_DOT || peek1.tag === T_CARET) {
    let keys: string[] | null = null;

    if (peek1.tag === T_DOT) {
      const len = readB64(data, peek1.tagPos + 1, cursor);
      const bodyStart = peek1.tagPos - len;
      const body = td.decode(data.subarray(bodyStart, peek1.tagPos));
      keys = body === "" ? [] : body.split(",").reverse();
      cursor = bodyStart;
    } else {
      // Pointer — peek to see if it resolves to a schema node
      const delta = readB64(data, peek1.tagPos + 1, cursor);
      const target = peek1.tagPos - delta;
      const targetTag = findTag(data, target);
      if (targetTag.tag === T_DOT) {
        const len = readB64(data, targetTag.tagPos + 1, target);
        const bodyStart = targetTag.tagPos - len;
        const body = td.decode(data.subarray(bodyStart, targetTag.tagPos));
        keys = body === "" ? [] : body.split(",").reverse();
        cursor = peek1.tagPos;
      }
    }

    if (keys !== null) {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < keys.length; i++) {
        if (cursor <= 0) throw new SyntaxError("Object opener not found in schema object");
        const valRes = decodeNode(data, cursor);
        obj[keys[i]!] = valRes.value;
        cursor = valRes.leftEdge;
      }
      const opener = findTag(data, cursor);
      if (opener.tag !== T_LBRACE) {
        throw new SyntaxError(`Object opener not at expected position (got ${String.fromCharCode(opener.tag)})`);
      }
      return { value: obj, leftEdge: opener.tagPos };
    }
  }

  // No schema — check for index
  const idx = tryReadIndex(data, cursor);
  if (idx) return decodeIndexedObject(data, idx);

  // Plain object: eager (key, value pairs R-to-L)
  const obj: Record<string, unknown> = {};
  while (true) {
    if (cursor <= 0) throw new SyntaxError("Object opener not found");
    const peek = findTag(data, cursor);
    if (peek.tag === T_LBRACE) {
      return { value: obj, leftEdge: peek.tagPos };
    }
    const keyRes = decodeNode(data, cursor);
    const key = keyRes.value;
    if (typeof key !== "string") {
      throw new SyntaxError(`Object key must be a string, got ${typeof key}`);
    }
    cursor = keyRes.leftEdge;
    const valRes = decodeNode(data, cursor);
    obj[key] = valRes.value;
    cursor = valRes.leftEdge;
  }
}

function decodeIndexedObject(data: Uint8Array, idx: IndexInfo): DecodeResult {
  // Object index entries are sorted by UTF-8 key (not by insertion order), so
  // the leftmost-in-byte-order child corresponds to the entry with the LARGEST
  // delta. Scan all entries to find it.
  let leftEdge: number;
  if (idx.count === 0) {
    leftEdge = idx.leftEdge - 1;
  } else {
    let maxDelta = 0;
    for (let i = 0; i < idx.count; i++) {
      const off = idx.entriesStart + i * idx.width;
      const d = readB64(data, off, off + idx.width);
      if (d > maxDelta) maxDelta = d;
    }
    const leftmostKeyRight = idx.base - maxDelta;
    const leftmostKey = decodeNode(data, leftmostKeyRight);
    const leftmostValue = decodeNode(data, leftmostKey.leftEdge);
    leftEdge = leftmostValue.leftEdge - 1;
  }
  if (data[leftEdge] !== T_LBRACE) {
    throw new SyntaxError(`Object opener missing at ${leftEdge}`);
  }
  return { value: makeLazyObject(data, idx), leftEdge };
}

function makeLazyObject(data: Uint8Array, idx: IndexInfo): Record<string, unknown> {
  // Index entries point to KEY right edges, sorted by UTF-8 key order.
  const cache: Map<string, unknown> = new Map();
  let keysList: string[] | null = null;
  let keyToValueRight: Map<string, number> | null = null;

  function resolve(): { keys: string[]; map: Map<string, number> } {
    if (keysList && keyToValueRight) return { keys: keysList, map: keyToValueRight };
    keysList = [];
    keyToValueRight = new Map();
    for (let i = 0; i < idx.count; i++) {
      const keyRight = indexEntryTarget(data, idx, i);
      const keyRes = decodeNode(data, keyRight);
      const k = keyRes.value as string;
      keysList.push(k);
      keyToValueRight.set(k, keyRes.leftEdge);
    }
    return { keys: keysList, map: keyToValueRight };
  }

  return new Proxy({} as Record<string, unknown>, {
    get(_, prop) {
      if (typeof prop !== "string") return undefined;
      if (cache.has(prop)) return cache.get(prop);
      const { map } = resolve();
      const valueRight = map.get(prop);
      if (valueRight === undefined) return undefined;
      const v = decodeNode(data, valueRight).value;
      cache.set(prop, v);
      return v;
    },
    has(_, prop) {
      if (typeof prop !== "string") return false;
      const { map } = resolve();
      return map.has(prop);
    },
    ownKeys() {
      const { keys } = resolve();
      return keys.slice();
    },
    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop !== "string") return undefined;
      const { map } = resolve();
      if (!map.has(prop)) return undefined;
      return { value: undefined, writable: false, enumerable: true, configurable: true };
    },
  });
}

// ── Chain decoding ─────────────────────────────────────────────

function decodeChain(data: Uint8Array, closerPos: number): DecodeResult {
  // Chains concatenate string (or bytes) segments. Walk R-to-L collecting
  // segments into a list (which is in natural forward order via unshift).
  let cursor = closerPos;
  const parts: unknown[] = [];
  while (true) {
    if (cursor <= 0) throw new SyntaxError("Chain opener not found");
    const peek = findTag(data, cursor);
    if (peek.tag === T_LANGLE) {
      let anyBytes = false;
      for (const p of parts) if (p instanceof Uint8Array) { anyBytes = true; break; }
      if (anyBytes) {
        let total = 0;
        for (const p of parts) {
          total += p instanceof Uint8Array ? p.length : te.encode(p as string).length;
        }
        const out = new Uint8Array(total);
        let oi = 0;
        for (const p of parts) {
          const b = p instanceof Uint8Array ? p : te.encode(p as string);
          out.set(b, oi);
          oi += b.length;
        }
        return { value: out, leftEdge: peek.tagPos };
      }
      return { value: (parts as string[]).join(""), leftEdge: peek.tagPos };
    }
    const res = decodeNode(data, cursor);
    parts.push(res.value);
    cursor = res.leftEdge;
  }
}

// ── Public API ─────────────────────────────────────────────────

export function decode(data: Uint8Array): unknown {
  if (data.length === 0) throw new SyntaxError("Empty input");
  return decodeNode(data, data.length).value;
}

export function parse(text: string): unknown {
  return decode(te.encode(text));
}
