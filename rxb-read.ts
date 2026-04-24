///////////////////////////////////////////////////////////////////
//
// RXB Reader — cursor-based decoder and Proxy API for RXB binary data.
//
// Provides zero-copy random access into RXB-encoded buffers:
//   read()      — parse one node at a byte offset
//   findKey()   — O(log n) key lookup on indexed objects
//   open()      — returns a read-only Proxy that looks like plain JS
//   decode()    — alias for open()
//
// Import the encoder from "./rxb.ts".
//
///////////////////////////////////////////////////////////////////

import {
  tagVarintRead,
  hexDecode,
  b64sDecode,
  TAG_INT,
  TAG_DECIMAL,
  TAG_STRING,
  TAG_HEXSTR,
  TAG_B64STR,
  TAG_REF,
  TAG_LIST,
  TAG_MAP,
  TAG_POINTER,
  TAG_CHAIN,
  TAG_INDEX,
  REF_NULL,
  REF_TRUE,
  REF_FALSE,
  REF_UNDEF,
  REF_INF,
  REF_NINF,
  REF_NAN,
  REF_EXTERNAL_BASE,
} from "./rxb.ts";

import { fromZigZag } from "./rx.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ── Tags (semantic) ──

export type Tag =
  | "int"
  | "float"
  | "str"
  | "hexstr"
  | "b64str"
  | "ref"
  | "true"
  | "false"
  | "null"
  | "undef"
  | "array"
  | "object"
  | "ptr"
  | "chain";

// ── Cursor ──

export interface Cursor {
  data: Uint8Array;
  left: number;
  right: number;
  tag: Tag;
  val: number;
  ixWidth: number;
  ixCount: number;
  schema: number;
}

export function makeCursor(data: Uint8Array): Cursor {
  return {
    data,
    left: 0,
    right: data.length,
    tag: "null",
    val: 0,
    ixWidth: 0,
    ixCount: 0,
    schema: 0,
  };
}

// Internal scratch cursors
const _empty = new Uint8Array(0);
const _k: Cursor = makeCursor(_empty);
const _s: Cursor = makeCursor(_empty);
const _cc: Cursor = makeCursor(_empty);
const _cmp: Cursor = makeCursor(_empty);

// ── Core parsing ──

/** Unpack index metadata: low 3 bits = width-1, rest = count */
function unpackIndex(c: Cursor, packed: number): void {
  c.ixWidth = (packed & 0b111) + 1;
  c.ixCount = packed >> 3;
}

/** Read one node ending at c.right. Fills all cursor fields. Returns the tag. */
export function read(c: Cursor): Tag {
  const { data } = c;

  // Reset container fields
  c.ixWidth = 0;
  c.ixCount = 0;
  c.schema = 0;

  const { tag, value, left } = tagVarintRead(data, c.right);
  c.left = left;

  switch (tag) {
    case TAG_INT:
      c.val = fromZigZag(value);
      return c.tag = "int";

    case TAG_DECIMAL: {
      const exp = fromZigZag(value);
      const savedRight = c.right;
      c.right = left;
      read(c);
      c.val = parseFloat(`${c.val}e${exp}`);
      c.right = savedRight;
      return c.tag = "float";
    }

    case TAG_STRING:
      c.left = left - value;
      c.val = value;
      return c.tag = "str";

    case TAG_HEXSTR:
      c.left = left - Math.ceil(value / 2);
      c.val = value;
      return c.tag = "hexstr";

    case TAG_B64STR:
      c.left = left - Math.ceil(value * 6 / 8);
      c.val = value;
      return c.tag = "b64str";

    case TAG_REF: {
      if (value === REF_TRUE) { c.val = 0; return c.tag = "true"; }
      if (value === REF_FALSE) { c.val = 0; return c.tag = "false"; }
      if (value === REF_NULL) { c.val = 0; return c.tag = "null"; }
      if (value === REF_UNDEF) { c.val = 0; return c.tag = "undef"; }
      if (value === REF_INF) { c.val = Infinity; return c.tag = "float"; }
      if (value === REF_NINF) { c.val = -Infinity; return c.tag = "float"; }
      if (value === REF_NAN) { c.val = NaN; return c.tag = "float"; }
      c.val = value - REF_EXTERNAL_BASE;
      return c.tag = "ref";
    }

    case TAG_MAP: {
      let content = left;
      c.left = left - value;
      if (content > c.left) {
        const { tag: innerTag, value: innerVal, left: innerLeft } = tagVarintRead(data, content);
        if (innerTag === TAG_REF || innerTag === TAG_POINTER) {
          let isSchema = true;
          if (innerTag === TAG_POINTER) {
            const target = innerLeft - innerVal;
            const { tag: targetTag } = tagVarintRead(data, target);
            isSchema = targetTag === TAG_LIST || targetTag === TAG_MAP;
          }
          if (isSchema) {
            c.schema = content;
            content = innerLeft;
          }
        }
        if (content > c.left) {
          const { tag: ixTag, value: ixVal, left: ixLeft } = tagVarintRead(data, content);
          if (ixTag === TAG_INDEX) {
            unpackIndex(c, ixVal);
            content = ixLeft - c.ixWidth * c.ixCount;
          }
        }
      }
      c.val = content;
      return c.tag = "object";
    }

    case TAG_LIST: {
      let content = left;
      c.left = left - value;
      if (content > c.left) {
        const { tag: ixTag, value: ixVal, left: ixLeft } = tagVarintRead(data, content);
        if (ixTag === TAG_INDEX) {
          unpackIndex(c, ixVal);
          content = ixLeft - c.ixWidth * c.ixCount;
        }
      }
      c.val = content;
      return c.tag = "array";
    }

    case TAG_POINTER:
      c.val = left - value;
      return c.tag = "ptr";

    case TAG_CHAIN:
      c.left = left - value;
      c.val = left;
      return c.tag = "chain";

    default:
      throw new SyntaxError(`Unknown tag: 0x${tag.toString(16)}`);
  }
}

// ── String handling ──

/** Decode the string at cursor position to a JS string. */
export function readStr(c: Cursor): string {
  if (c.tag === "hexstr") {
    const byteLen = Math.ceil(c.val / 2);
    return hexDecode(c.data, c.left, byteLen, c.val);
  }
  if (c.tag === "b64str") {
    const byteLen = Math.ceil(c.val * 6 / 8);
    return b64sDecode(c.data, c.left, byteLen, c.val);
  }
  return textDecoder.decode(c.data.subarray(c.left, c.left + c.val));
}

/** Resolve a node to a string, following pointers and concatenating chains. */
export function resolveStr(c: Cursor): string {
  const savedLeft = c.left, savedRight = c.right, savedTag = c.tag, savedVal = c.val;
  const result = _resolveStr(c);
  c.left = savedLeft; c.right = savedRight; c.tag = savedTag; c.val = savedVal;
  return result;
}

function _resolveStr(c: Cursor): string {
  while (c.tag === "ptr") { c.right = c.val; read(c); }
  if (c.tag === "str" || c.tag === "hexstr" || c.tag === "b64str") return readStr(c);
  if (c.tag === "chain") {
    const parts: string[] = [];
    let right = c.val;
    const left = c.left;
    while (right > left) {
      c.right = right;
      read(c);
      right = c.left;
      parts.push(_resolveStr(c));
    }
    return parts.join("");
  }
  throw new TypeError(`resolveStr: expected str, hexstr, ptr, or chain, got ${c.tag}`);
}

/** Encode a string to UTF-8 bytes for use with strEquals/strCompare. */
export function prepareKey(target: string): Uint8Array {
  return textEncoder.encode(target);
}

/** Compare a node's string bytes against key bytes starting at offset. */
function nodeCompare(c: Cursor, key: Uint8Array, offset: number): { cmp: number; offset: number } {
  while (c.tag === "ptr") { c.right = c.val; read(c); }

  if (c.tag === "str") {
    const start = c.left;
    const byteLen = c.val;
    const { data } = c;
    const len = Math.min(byteLen, key.length - offset);
    for (let i = 0; i < len; i++) {
      const diff = data[start + i]! - key[offset + i]!;
      if (diff !== 0) return { cmp: diff, offset: offset + i };
    }
    if (byteLen > key.length - offset) return { cmp: 1, offset: key.length };
    return { cmp: 0, offset: offset + byteLen };
  }

  if (c.tag === "hexstr" || c.tag === "b64str") {
    const str = readStr(c);
    const strBytes = textEncoder.encode(str);
    const len = Math.min(strBytes.length, key.length - offset);
    for (let i = 0; i < len; i++) {
      const diff = strBytes[i]! - key[offset + i]!;
      if (diff !== 0) return { cmp: diff, offset: offset + i };
    }
    if (strBytes.length > key.length - offset) return { cmp: 1, offset: key.length };
    return { cmp: 0, offset: offset + strBytes.length };
  }

  if (c.tag === "ref") {
    return { cmp: NaN, offset };
  }

  if (c.tag === "chain") {
    let right = c.val;
    const left = c.left;
    while (right > left) {
      c.right = right;
      read(c);
      right = c.left;
      const result = nodeCompare(c, key, offset);
      if (result.cmp !== 0) return result;
      offset = result.offset;
    }
    return { cmp: 0, offset };
  }

  return { cmp: NaN, offset };
}

/** Compare cursor's string against target. Returns <0, 0, >0, or NaN. */
export function strCompare(c: Cursor, target: Uint8Array): number {
  _cmp.data = c.data; _cmp.left = c.left; _cmp.right = c.right; _cmp.tag = c.tag; _cmp.val = c.val;
  const { cmp, offset } = nodeCompare(_cmp, target, 0);
  if (cmp !== 0) return cmp;
  return offset < target.length ? -1 : 0;
}

/** Zero-alloc equality check. */
export function strEquals(c: Cursor, target: Uint8Array): boolean {
  return strCompare(c, target) === 0;
}

/** Zero-alloc prefix check. */
export function strHasPrefix(c: Cursor, prefix: Uint8Array): boolean {
  if (prefix.length === 0) return true;
  _cmp.data = c.data; _cmp.left = c.left; _cmp.right = c.right; _cmp.tag = c.tag; _cmp.val = c.val;
  const { offset } = nodeCompare(_cmp, prefix, 0);
  return offset === prefix.length;
}

// ── Container access ──

/** Read a big-endian unsigned integer from data[left..left+width). */
function readBinaryFixed(data: Uint8Array, left: number, width: number): number {
  let result = 0;
  for (let i = 0; i < width; i++) {
    result = result * 256 + data[left + i]!;
  }
  return result;
}

/** Jump to the Nth child of an indexed container. O(1). */
export function seekChild(c: Cursor, container: Cursor, index: number): void {
  if (container.ixWidth === 0) {
    throw new Error("seekChild requires an indexed container");
  }
  if (index < 0 || index >= container.ixCount) {
    throw new RangeError(`seekChild: index ${index} out of range [0, ${container.ixCount})`);
  }
  const { data } = container;
  const { val: ixBase, ixWidth } = container;
  const entryLeft = ixBase + index * ixWidth;
  const delta = readBinaryFixed(data, entryLeft, ixWidth);
  c.data = data;
  c.right = ixBase - delta;
  read(c);
}

/** Collect child right-boundaries into caller-owned array. Returns count. */
export function collectChildren(container: Cursor, offsets: number[]): number {
  _cc.data = container.data;
  let right = container.val;
  const end = container.left;
  let count = 0;
  while (right > end) {
    if (count >= offsets.length) offsets.push(right);
    else offsets[count] = right;
    count++;
    _cc.right = right;
    read(_cc);
    right = _cc.left;
  }
  return count;
}

function keyEquals(target: Uint8Array): boolean {
  return strEquals(_k, target);
}

/** Find a key in an object. Fills c with the value node if found. */
export function findKey(c: Cursor, container: Cursor, target: string | Uint8Array): boolean {
  if (container.tag !== "object") return false;
  if (typeof target === "string") target = prepareKey(target);

  const { data } = container;
  _k.data = data;

  if (container.ixWidth > 0 && container.ixCount > 0 && container.schema === 0) {
    let lo = 0, hi = container.ixCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      seekChild(c, container, mid);
      const cmp = strCompare(c, target);
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo < container.ixCount) {
      seekChild(c, container, lo);
      if (strEquals(c, target)) {
        c.data = data;
        c.right = c.left;
        read(c);
        return true;
      }
    }
    return false;
  }

  let right = container.val;
  const end = container.left;

  if (container.schema !== 0) {
    _s.data = data;
    _s.right = container.schema;
    read(_s);

    if (_s.tag === "ptr") {
      _s.right = _s.val;
      read(_s);
    }

    let keyRight = _s.val;
    const keyEnd = _s.left;
    let valRight = container.val;

    if (_s.tag === "object") {
      while (keyRight > keyEnd && valRight > end) {
        _k.right = keyRight;
        read(_k);
        const matched = keyEquals(target);
        _s.data = data;
        _s.right = _k.left;
        read(_s);
        keyRight = _s.left;

        if (matched) {
          c.data = data;
          c.right = valRight;
          read(c);
          return true;
        }

        c.data = data;
        c.right = valRight;
        read(c);
        valRight = c.left;
      }
    }

    if (_s.tag === "array") {
      while (keyRight > keyEnd && valRight > end) {
        _k.right = keyRight;
        read(_k);
        keyRight = _k.left;

        if (keyEquals(target)) {
          c.data = data;
          c.right = valRight;
          read(c);
          return true;
        }

        c.data = data;
        c.right = valRight;
        read(c);
        valRight = c.left;
      }
    }

    return false;
  }

  while (right > end) {
    _k.right = right;
    read(_k);
    if (keyEquals(target)) {
      c.data = data;
      c.right = _k.left;
      read(c);
      return true;
    }
    c.data = data;
    c.right = _k.left;
    read(c);
    right = c.left;
  }
  return false;
}

/** Find all keys matching a prefix in an object. */
export function findByPrefix(
  c: Cursor,
  container: Cursor,
  prefix: string | Uint8Array,
  visitor: (key: Cursor, value: Cursor) => boolean | void,
): void {
  if (container.tag !== "object") return;
  if (typeof prefix === "string") prefix = prepareKey(prefix);

  const { data } = container;

  if (container.schema !== 0) return;

  if (container.ixWidth > 0 && container.ixCount > 0) {
    let lo = 0, hi = container.ixCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      seekChild(c, container, mid);
      const cmp = strCompare(c, prefix);
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < container.ixCount; i++) {
      seekChild(c, container, i);
      const keyRight = c.right;
      if (!strHasPrefix(c, prefix)) break;
      _cc.data = data; _cc.right = keyRight; read(_cc);
      c.data = data; c.right = c.left; read(c);
      if (visitor(_cc, c) === false) return;
    }
    return;
  }

  _k.data = data;
  let right = container.val;
  const end = container.left;
  while (right > end) {
    _k.right = right;
    read(_k);
    const keyRight = right;
    if (strHasPrefix(_k, prefix)) {
      _cc.data = data; _cc.right = keyRight; read(_cc);
      c.data = data; c.right = _k.left; read(c);
      if (visitor(_cc, c) === false) return;
    } else {
      c.data = data; c.right = _k.left; read(c);
    }
    right = c.left;
  }
}

// ── Raw bytes ──

export function rawBytes(c: Cursor): Uint8Array {
  return c.data.subarray(c.left, c.right);
}

export type Refs = Record<string, unknown>;

// ── High-level Proxy API ──

const HANDLE = Symbol("rxb.handle");

type NodeInfo = {
  data: Uint8Array;
  right: number;
  tag: Tag;
  val: number;
  left: number;
  ixWidth: number;
  ixCount: number;
  schema: number;
  _count?: number;
  _offsets?: number[];
  _keys?: string[];
  _keyMap?: Map<string, number>;
};

type OpenContext = {
  root: unknown;
  resolve(right: number): unknown;
};

function _openContext(buffer: Uint8Array, refs?: Refs, refNames?: string[]): OpenContext {
  const nodeMap = new WeakMap<object, NodeInfo>();
  const proxyCache = new Map<number, unknown>();
  const scratch = makeCursor(buffer);

  function snap(c: Cursor): NodeInfo {
    return {
      data: c.data, right: c.right, tag: c.tag, val: c.val,
      left: c.left, ixWidth: c.ixWidth, ixCount: c.ixCount, schema: c.schema,
    };
  }

  function resolveRef(refIndex: number): unknown {
    if (!refs || !refNames) return undefined;
    const name = refNames[refIndex];
    if (name === undefined) return undefined;
    return name in refs ? refs[name] : undefined;
  }

  function resolveKeyStr(c: Cursor): string {
    const savedLeft = c.left, savedRight = c.right, savedTag = c.tag, savedVal = c.val;
    while (c.tag === "ptr") { c.right = c.val; read(c); }
    let result: string;
    if (c.tag === "ref" && refs && refNames) {
      const val = resolveRef(c.val);
      result = typeof val === "string" ? val : resolveStr(c);
    } else {
      result = resolveStr(c);
    }
    c.left = savedLeft; c.right = savedRight; c.tag = savedTag; c.val = savedVal;
    return result;
  }

  function wrap(c: Cursor): unknown {
    while (c.tag === "ptr") { c.right = c.val; read(c); }
    if (c.tag === "ref") return resolveRef(c.val);
    const cached = proxyCache.get(c.right);
    if (cached !== undefined) return cached;
    switch (c.tag) {
      case "int": case "float": return c.val;
      case "str": case "hexstr": case "b64str": return readStr(c);
      case "chain": return resolveStr(c);
      case "true": return true;
      case "false": return false;
      case "null": return null;
      case "undef": return undefined;
    }
    const info = snap(c);
    const target: object = c.tag === "array" ? [] : Object.create(null);
    nodeMap.set(target, info);
    const proxy = new Proxy(target, handler);
    proxyCache.set(c.right, proxy);
    return proxy;
  }

  function childCount(info: NodeInfo): number {
    if (info._count !== undefined) return info._count;
    if (info.ixCount > 0) return info._count = info.ixCount;
    if (info.tag === "array") {
      ensureOffsets(info);
      return info._count!;
    }
    let right = info.val, n = 0;
    while (right > info.left) {
      scratch.data = info.data; scratch.right = right;
      read(scratch); right = scratch.left; n++;
    }
    return info._count = info.schema !== 0 ? n : n / 2;
  }

  function ensureOffsets(info: NodeInfo): number[] {
    if (!info._offsets) {
      info._offsets = [];
      info._count = collectChildren(info as unknown as Cursor, info._offsets);
    }
    return info._offsets;
  }

  function getChild(info: NodeInfo, index: number): unknown {
    if (index < 0 || index >= childCount(info)) return undefined;
    if (info.ixWidth > 0) {
      seekChild(scratch, info as unknown as Cursor, index);
      return wrap(scratch);
    }
    const offsets = ensureOffsets(info);
    scratch.data = info.data;
    scratch.right = offsets[index]!;
    read(scratch);
    return wrap(scratch);
  }

  function getValue(info: NodeInfo, key: string): unknown {
    if (!info._keyMap && info.schema !== 0) ensureKeyMap(info);
    if (info._keyMap) {
      const valRight = info._keyMap.get(key);
      if (valRight === undefined) return undefined;
      scratch.data = info.data;
      scratch.right = valRight;
      read(scratch);
      return wrap(scratch);
    }
    scratch.data = info.data;
    if (findKey(scratch, info as unknown as Cursor, key)) return wrap(scratch);
    return undefined;
  }

  function ensureKeyMap(info: NodeInfo): { keys: string[]; map: Map<string, number> } {
    if (info._keyMap) {
      return { keys: info._keys!, map: info._keyMap };
    }
    const keys: string[] = [];
    const map = new Map<string, number>();
    const kc = makeCursor(info.data);
    if (info.schema !== 0) {
      const sc = makeCursor(info.data);
      sc.right = info.schema; read(sc);
      while (sc.tag === "ptr") { sc.right = sc.val; read(sc); }
      if (sc.tag === "ref" && refs && refNames) {
        const refVal = resolveRef(sc.val);
        let valRight = info.val;
        const keyStrings: string[] = Array.isArray(refVal)
          ? refVal as string[]
          : (refVal && typeof refVal === "object" ? Object.keys(refVal) : []);
        for (const name of keyStrings) {
          keys.push(name);
          map.set(name, valRight);
          scratch.data = info.data; scratch.right = valRight; read(scratch);
          valRight = scratch.left;
        }
      } else {
        kc.data = sc.data;
        let valRight = info.val;
        if (sc.tag === "object") {
          let keyRight = sc.val;
          const keyEnd = sc.left;
          while (keyRight > keyEnd) {
            kc.right = keyRight; read(kc);
            const nextRight = kc.left;
            const name = resolveKeyStr(kc);
            keys.push(name);
            map.set(name, valRight);
            scratch.data = info.data; scratch.right = valRight; read(scratch);
            valRight = scratch.left;
            sc.right = nextRight; read(sc);
            keyRight = sc.left;
          }
        } else if (sc.tag === "array") {
          let keyRight = sc.val;
          const keyEnd = sc.left;
          while (keyRight > keyEnd) {
            kc.right = keyRight; read(kc);
            const name = resolveKeyStr(kc);
            keys.push(name);
            map.set(name, valRight);
            scratch.data = info.data; scratch.right = valRight; read(scratch);
            valRight = scratch.left;
            keyRight = kc.left;
          }
        }
      }
    } else {
      let right = info.val;
      while (right > info.left) {
        kc.data = info.data; kc.right = right; read(kc);
        const keyLeft = kc.left;
        const name = resolveKeyStr(kc);
        keys.push(name);
        map.set(name, keyLeft);
        kc.data = info.data; kc.right = keyLeft; read(kc);
        right = kc.left;
      }
    }
    info._keys = keys;
    info._keyMap = map;
    return { keys, map };
  }

  const handler: ProxyHandler<object> = {
    get(target, prop) {
      const info = nodeMap.get(target)!;
      if (prop === HANDLE) return { data: info.data, right: info.right };

      if (prop === Symbol.iterator) {
        if (info.tag === "array") {
          return function* () {
            const n = childCount(info);
            for (let i = 0; i < n; i++) yield getChild(info, i);
          };
        }
        if (info.tag === "object") {
          return function* () {
            const ks = ensureKeyMap(info).keys;
            for (const k of ks) yield [k, getValue(info, k)] as [string, unknown];
          };
        }
        return undefined;
      }

      if (typeof prop === "symbol") return undefined;
      if (prop === "length") return childCount(info);

      if (info.tag === "array") {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0) return getChild(info, idx);
        const method = (Array.prototype as any)[prop];
        if (typeof method === "function") {
          return function (...args: unknown[]) {
            const n = childCount(info);
            const arr: unknown[] = new Array(n);
            for (let i = 0; i < n; i++) arr[i] = getChild(info, i);
            return method.apply(arr, args);
          };
        }
        return undefined;
      }

      if (info.tag === "object") return getValue(info, prop);
      return undefined;
    },

    has(target, prop) {
      const info = nodeMap.get(target)!;
      if (prop === HANDLE) return true;
      if (typeof prop === "symbol") return false;
      if (prop === "length") return true;
      if (info.tag === "array") {
        const idx = Number(prop);
        return Number.isInteger(idx) && idx >= 0 && idx < childCount(info);
      }
      if (info.tag === "object") {
        if (!info._keyMap && info.schema !== 0) ensureKeyMap(info);
        if (info._keyMap) return info._keyMap.has(prop);
        scratch.data = info.data;
        return findKey(scratch, info as unknown as Cursor, prop);
      }
      return false;
    },

    ownKeys(target) {
      const info = nodeMap.get(target)!;
      if (info.tag === "array") {
        const n = childCount(info);
        const ks: string[] = [];
        for (let i = 0; i < n; i++) ks.push(String(i));
        ks.push("length");
        return ks;
      }
      return ensureKeyMap(info).keys;
    },

    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "symbol") return undefined;
      const info = nodeMap.get(target)!;
      if (info.tag === "array") {
        if (prop === "length") {
          return { configurable: false, enumerable: false, value: childCount(info), writable: true };
        }
        const idx = Number(prop);
        if (typeof prop === "string" && Number.isInteger(idx) && idx >= 0 && idx < childCount(info)) {
          return { configurable: true, enumerable: true, value: getChild(info, idx) };
        }
        return undefined;
      }
      if (info.tag === "object" && typeof prop === "string") {
        if (!info._keyMap && info.schema !== 0) ensureKeyMap(info);
        if (info._keyMap) {
          if (info._keyMap.has(prop)) {
            return { configurable: true, enumerable: true, value: getValue(info, prop) };
          }
        } else {
          scratch.data = info.data;
          if (findKey(scratch, info as unknown as Cursor, prop)) {
            return { configurable: true, enumerable: true, value: wrap(scratch) };
          }
        }
      }
      return undefined;
    },

    set() { throw new TypeError("rxb data is read-only"); },
    deleteProperty() { throw new TypeError("rxb data is read-only"); },
  };

  function resolve(right: number): unknown {
    scratch.data = buffer;
    scratch.right = right;
    read(scratch);
    return wrap(scratch);
  }

  const root = resolve(buffer.length);
  return { root, resolve };
}

/** Open an rxb buffer and return a Proxy-wrapped root value. */
export function open(buffer: Uint8Array, refs?: Refs): unknown {
  const refNames = refs ? Object.keys(refs).sort() : undefined;
  return _openContext(buffer, refs, refNames).root;
}

/** Get the raw handle from a Proxy-wrapped value. */
export function handle(proxy: unknown): { data: Uint8Array; right: number } | undefined {
  if (proxy && typeof proxy === "object" && HANDLE in proxy) {
    return (proxy as any)[HANDLE];
  }
  return undefined;
}

// ── Decode ──

export interface DecodeOptions {
  refs?: Refs;
}

export function decode(input: Uint8Array, options?: DecodeOptions): unknown {
  return open(input, options?.refs);
}
