/////////////////////
//
// Cursor-based rexc parser with zero-allocation reads and Proxy wrapper
//
//////////////////

// TUNE AS NEEDED CONSTANTS
export let INDEX_THRESHOLD = 16; // Objects and Arrays with more values than this are indexed
export let STRING_CHAIN_THRESHOLD = 64; // Strings longer that this are eligible for splitting into chains
export let STRING_CHAIN_DELIMITER = "/"; // Delimiter for splitting long strings into chains
export let KEY_COMPLEXITY_THRESHOLD = 100; // Maxinum object complexity for dedupe keys

export function tune(options: Partial<{
  indexThreshold?: number;
  stringChainThreshold?: number;
  stringChainDelimiter?: string;
  keyComplexityThreshold?: number;
}>): void {
  if (options.indexThreshold !== undefined) INDEX_THRESHOLD = options.indexThreshold;
  if (options.stringChainThreshold !== undefined) STRING_CHAIN_THRESHOLD = options.stringChainThreshold;
  if (options.stringChainDelimiter !== undefined) STRING_CHAIN_DELIMITER = options.stringChainDelimiter;
  if (options.keyComplexityThreshold !== undefined) KEY_COMPLEXITY_THRESHOLD = options.keyComplexityThreshold;
}

// ── Base64 numeric system ──
// Numbers are written big-endian with the most significant digit on the left
// There is no padding, not even for zero, which is an empty string

export const b64regex = /^[0-9a-zA-Z\-_]*$/;

export const b64chars =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

// char-code -> digit-value (0xff = invalid)
export const b64decodeTable = new Uint8Array(256).fill(0xff);

// digit-value -> char-code
export const b64encodeTable = new Uint8Array(64);

for (let i = 0; i < 64; i++) {
  const code = b64chars.charCodeAt(i);
  b64decodeTable[code] = i;
  b64encodeTable[i] = code;
}

// Return true if byte is 0-9, a-z, A-Z, '-' or '_'
export function isB64(byte: number): boolean {
  return b64decodeTable[byte] !== 0xff;
}

// Encode a number as b64 string
export function b64Stringify(num: number): string {
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new Error(`Cannot stringify ${num} as base64`);
  }
  let result = "";
  while (num > 0) {
    result = b64chars[num % 64] + result;
    num = Math.floor(num / 64);
  }
  return result;
}

// Decode a b64 string to a number
export function b64Parse(str: string): number {
  let result = 0;
  for (let i = 0; i < str.length; i++) {
    const digit = b64decodeTable[str.charCodeAt(i)]!;
    if (digit === 0xff) {
      throw new Error(`Invalid base64 character: ${str[i]}`);
    }
    result = result * 64 + digit;
  }
  return result;
}

// Read a b64 number from a byte range
export function b64Read(
  data: Uint8Array,
  left: number,
  right: number,
): number {
  let result = 0;
  for (let i = left; i < right; i++) {
    const digit = b64decodeTable[data[i]!]!
    if (digit === 0xff) {
      throw new Error(`Invalid base64 character code: ${data[i]}`);
    }
    result = result * 64 + digit;
  }
  return result;
}

// Return the number of b64 digits needed to encode num
export function b64Sizeof(num: number): number {
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new Error(`Cannot calculate size of ${num} as base64`);
  }
  return Math.ceil(Math.log(num + 1) / Math.log(64));
}

export function b64Write(
  data: Uint8Array,
  left: number,
  right: number,
  num: number,
) {
  let offset = right - 1;
  while (offset >= left) {
    data[offset--] = b64encodeTable[num % 64]!;
    num = Math.floor(num / 64);
  }
  if (num > 0) {
    throw new Error(`Cannot write ${num} as base64`);
  }
}

// Encode a signed integer as an unsigned zigzag value
export function toZigZag(num: number): number {
  if (num >= -0x80000000 && num <= 0x7fffffff) {
    return ((num << 1) ^ (num >> 31)) >>> 0;
  }
  return num < 0 ? num * -2 - 1 : num * 2;
}

// Decode an unsigned zigzag value back to a signed integer
export function fromZigZag(num: number): number {
  if (num <= 0xffffffff) {
    return (num >>> 1) ^ -(num & 1);
  }
  return num % 2 === 0 ? num / 2 : (num + 1) / -2;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ── Tags ──

export type Tag =
  | "int"
  | "float"
  | "str"
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

// Internal scratch cursors — reused across calls to avoid allocations.
// Safe because JS is single-threaded and these functions don't re-enter each other.
const _empty = new Uint8Array(0);
const _k: Cursor = makeCursor(_empty); // key/temp cursor
const _s: Cursor = makeCursor(_empty); // schema cursor
const _cc: Cursor = makeCursor(_empty); // collectChildren cursor (separate from _k to avoid conflict with read())
const _cmp: Cursor = makeCursor(_empty); // comparison scratch cursor (strCompare/strEquals/strHasPrefix)

// ── Core parsing ──

// Scan left from c.right past b64 digits. Sets c.left to the tag position.
// Returns the tag byte. b64 digits are at data[c.left+1 .. c.right).
function peekTag(c: Cursor): number {
  const { data } = c;
  let offset = c.right;
  while (--offset >= 0 && isB64(data[offset]!));
  if (offset < 0) throw new SyntaxError("peekTag: no tag found");
  c.left = offset;
  return data[offset]!;
}

// Unpack index metadata into cursor: low 3 bits = width-1, rest = count
function unpackIndex(c: Cursor, data: Uint8Array, left: number, right: number): void {
  const packed = b64Read(data, left, right);
  c.ixWidth = (packed & 0b111) + 1;
  c.ixCount = packed >> 3;
}

/** Read one node ending at c.right. Fills all cursor fields. Returns the tag. */
export function read(c: Cursor): Tag {
  const { data } = c;
  let { right } = c;

  // Reset container fields
  c.ixWidth = 0;
  c.ixCount = 0;
  c.schema = 0;

  // Find the tag: peekTag sets c.left to tag position
  const tag = peekTag(c);
  let { left } = c;

  if (tag === 0x27) {
    // ' — ref or builtin
    // Name bytes are at data[left+1..right), b64 digits overlap with name
    const nameLen = right - left - 1;
    // Check builtins by length + first byte
    if (nameLen === 1) {
      const ch = data[left + 1]!;
      if (ch === 0x74) { c.tag = "true"; c.val = 0; return c.tag; }  // t
      if (ch === 0x66) { c.tag = "false"; c.val = 0; return c.tag; } // f
      if (ch === 0x6e) { c.tag = "null"; c.val = 0; return c.tag; }  // n
      if (ch === 0x75) { c.tag = "undef"; c.val = 0; return c.tag; } // u
    } else if (nameLen === 3) {
      const a = data[left + 1]!, b = data[left + 2]!, d = data[left + 3]!;
      if (a === 0x69 && b === 0x6e && d === 0x66) { c.tag = "float"; c.val = Infinity; return c.tag; }   // inf
      if (a === 0x6e && b === 0x69 && d === 0x66) { c.tag = "float"; c.val = -Infinity; return c.tag; }  // nif
      if (a === 0x6e && b === 0x61 && d === 0x6e) { c.tag = "float"; c.val = NaN; return c.tag; }        // nan
    }
    c.val = nameLen;
    return c.tag = "ref";
  }

  const b64 = b64Read(data, left + 1, right);

  switch (tag) {
    case 0x2c: // , — string (most common)
      c.left = left - b64;
      c.val = b64;
      return c.tag = "str";

    case 0x2b: // + — integer
      c.val = fromZigZag(b64);
      return c.tag = "int";

    case 0x2a: { // * — float (exponent)
      const exp = fromZigZag(b64);
      const savedRight = c.right;
      c.right = left;
      read(c);
      c.val = parseFloat(`${c.val}e${exp}`);
      c.right = savedRight;
      return c.tag = "float";
    }

    case 0x3a: { // : — object
      let content = left;
      c.left = left - b64;
      // Parse optional schema (rightmost), then optional index
      if (content > c.left) {
        _k.data = data;
        _k.right = content;
        let innerTag = peekTag(_k);
        // Schema: ' (ref) or ^ (pointer to container)
        if (innerTag === 0x27 || innerTag === 0x5e) {
          let isSchema = true;
          if (innerTag === 0x5e) {
            const target = _k.left - b64Read(data, _k.left + 1, content);
            _s.data = data;
            _s.right = target;
            const targetTag = peekTag(_s);
            isSchema = targetTag === 0x3b || targetTag === 0x3a;
          }
          if (isSchema) {
            c.schema = content;
            content = _k.left;
          }
        }
        // Index: #
        if (content > c.left) {
          _k.right = content;
          innerTag = peekTag(_k);
          if (innerTag === 0x23) {
            unpackIndex(c, data, _k.left + 1, content);
            content = _k.left - c.ixWidth * c.ixCount;
          }
        }
      }
      c.val = content;
      return c.tag = "object";
    }

    case 0x3b: { // ; — array
      let content = left;
      c.left = left - b64;
      // Check for index
      if (content > c.left) {
        _k.data = data;
        _k.right = content;
        const ixTag = peekTag(_k);
        if (ixTag === 0x23) { // #
          unpackIndex(c, data, _k.left + 1, content);
          content = _k.left - c.ixWidth * c.ixCount;
        }
      }
      c.val = content;
      return c.tag = "array";
    }

    case 0x5e: // ^ — pointer
      c.val = left - b64;
      return c.tag = "ptr";

    case 0x2e: // . — chain
      c.left = left - b64;
      c.val = left;
      return c.tag = "chain";

    default:
      throw new SyntaxError(`Unknown tag: ${String.fromCharCode(tag)}`);
  }
}

// ── String handling ──

// String body start offset. For "str": body is at [left, left+val).
// For "ref": name is at [left+1, left+1+val) (skip the ' tag byte).
function strStart(c: Cursor): number {
  return c.left + (c.tag === "ref" ? 1 : 0);
}

/** Decode the string at cursor position to a JS string. 1 allocation. */
export function readStr(c: Cursor): string {
  const start = strStart(c);
  return textDecoder.decode(c.data.subarray(start, start + c.val));
}

/** Resolve a node to a string, following pointers and concatenating chains.
 *  For plain "str" nodes this is just readStr.
 *  Non-destructive: restores cursor state before returning. */
export function resolveStr(c: Cursor): string {
  const savedLeft = c.left, savedRight = c.right, savedTag = c.tag, savedVal = c.val;
  const result = _resolveStr(c);
  c.left = savedLeft; c.right = savedRight; c.tag = savedTag; c.val = savedVal;
  return result;
}

function _resolveStr(c: Cursor): string {
  while (c.tag === "ptr") { c.right = c.val; read(c); }
  if (c.tag === "str") return readStr(c);
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
  throw new TypeError(`resolveStr: expected str, ptr, or chain, got ${c.tag}`);
}

/** Encode a string to UTF-8 bytes for use with strEquals/strCompare. */
export function prepareKey(target: string): Uint8Array {
  return textEncoder.encode(target);
}

/**
 * Compare a node's string bytes against key bytes starting at offset.
 * Handles str, ptr, and chain (zero-alloc for all).
 * Returns { cmp, offset } where cmp is <0, 0, or >0 for the first difference,
 * NaN if the node is not a string type, and offset is how far into the key bytes.
 */
function nodeCompare(c: Cursor, key: Uint8Array, offset: number): { cmp: number; offset: number } {
  while (c.tag === "ptr") { c.right = c.val; read(c); }

  if (c.tag === "str" || c.tag === "ref") {
    const start = strStart(c);
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

/** Compare cursor's string against target. Returns <0, 0, >0, or NaN if not a string node.
 *  Non-destructive: uses an internal scratch cursor, leaving c unchanged. */
export function strCompare(c: Cursor, target: Uint8Array): number {
  _cmp.data = c.data; _cmp.left = c.left; _cmp.right = c.right; _cmp.tag = c.tag; _cmp.val = c.val;
  const { cmp, offset } = nodeCompare(_cmp, target, 0);
  if (cmp !== 0) return cmp;
  return offset < target.length ? -1 : 0;
}

/** Zero-alloc equality check: does cursor's string match target?
 *  Non-destructive: uses an internal scratch cursor, leaving c unchanged. */
export function strEquals(c: Cursor, target: Uint8Array): boolean {
  return strCompare(c, target) === 0;
}

/** Zero-alloc prefix check: does cursor's string start with prefix?
 *  Non-destructive: uses an internal scratch cursor, leaving c unchanged. */
export function strHasPrefix(c: Cursor, prefix: Uint8Array): boolean {
  if (prefix.length === 0) return true;
  _cmp.data = c.data; _cmp.left = c.left; _cmp.right = c.right; _cmp.tag = c.tag; _cmp.val = c.val;
  const { offset } = nodeCompare(_cmp, prefix, 0);
  return offset === prefix.length;
}

// ── Container access ──

/** Jump to the Nth child of an indexed container. O(1). Reads the child into c. */
export function seekChild(c: Cursor, container: Cursor, index: number): void {
  if (container.ixWidth === 0) {
    throw new Error("seekChild requires an indexed container");
  }
  if (index < 0 || index >= container.ixCount) {
    throw new RangeError(`seekChild: index ${index} out of range [0, ${container.ixCount})`);
  }
  const { data } = container;
  // Layout: [content] [ix entry 0..N-1] [# packed] [tag b64size]
  // container.val = content boundary = start of index table
  // Each entry is a b64 delta relative to container.val
  // child_right = container.val - delta
  const { val: ixBase, ixWidth } = container;
  const entryLeft = ixBase + index * ixWidth;
  const delta = b64Read(data, entryLeft, entryLeft + ixWidth);
  c.data = data;
  c.right = ixBase - delta;
  read(c);
}

/** Collect child right-boundaries into caller-owned array (logical order). Returns count. */
export function collectChildren(container: Cursor, offsets: number[]): number {
  // Uses _cc instead of _k because read() internally uses _k for object
  // schema/index detection — calling read(_k) on an object node would self-conflict.
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

// Compare a key node (in _k) against target. Zero-alloc for str, ptr, and chain.
function keyEquals(target: Uint8Array): boolean {
  return strEquals(_k, target);
}

/** Find a key in an object. Fills c with the value node if found. */
export function findKey(c: Cursor, container: Cursor, target: string | Uint8Array): boolean {
  if (container.tag !== "object") return false;
  if (typeof target === "string") target = prepareKey(target);

  const { data } = container;
  _k.data = data;

  // Sorted + indexed: O(log n) binary search
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
    // Schema object: content has only values, keys come from schema
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
      // Schema is an object — keys are its keys.
      // Read key into _k, check match, then skip schema value using _s.
      while (keyRight > keyEnd && valRight > end) {
        _k.right = keyRight;
        read(_k);
        const matched = keyEquals(target);
        // Skip schema value using _s
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

  // No schema: interleaved key/value pairs
  while (right > end) {
    _k.right = right;
    read(_k);
    if (keyEquals(target)) {
      c.data = data;
      c.right = _k.left;
      read(c);
      return true;
    }
    // Skip value
    c.data = data;
    c.right = _k.left;
    read(c);
    right = c.left;
  }
  return false;
}

/**
 * Find all keys matching a prefix in an object.
 * On indexed objects: O(log n) binary search + O(m) iteration over matches.
 * On non-indexed objects: O(n) linear scan.
 * Calls visitor(keyCursor, valueCursor) for each match — use resolveStr(key)
 * only if you need the string. Stops if visitor returns false.
 */
export function findByPrefix(
  c: Cursor,
  container: Cursor,
  prefix: string | Uint8Array,
  visitor: (key: Cursor, value: Cursor) => boolean | void,
): void {
  if (container.tag !== "object") return;
  if (typeof prefix === "string") prefix = prepareKey(prefix);

  const { data } = container;

  // TODO: schema-based objects
  if (container.schema !== 0) return;

  if (container.ixWidth > 0 && container.ixCount > 0) {
    // Binary search: index entries are sorted and point to keys
    let lo = 0, hi = container.ixCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      seekChild(c, container, mid);
      const cmp = strCompare(c, prefix);
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }
    // lo is the first key >= prefix. Iterate while prefix matches.
    for (let i = lo; i < container.ixCount; i++) {
      seekChild(c, container, i);
      const keyRight = c.right;
      const keyLeft = c.left;
      if (!strHasPrefix(c, prefix)) break;
      // Re-read key into _cc (safe from read() internal _k usage)
      _cc.data = data; _cc.right = keyRight; read(_cc);
      // Read value (immediately after key)
      c.data = data; c.right = keyLeft; read(c);
      if (visitor(_cc, c) === false) return;
    }
    return;
  }

  // Non-indexed: linear scan
  _k.data = data;
  let right = container.val;
  const end = container.left;
  while (right > end) {
    _k.right = right;
    read(_k);
    const keyLeft = _k.left;
    const keyRight = right;
    if (strHasPrefix(_k, prefix)) {
      // Re-read key into _cc (safe from read() internal _k usage)
      _cc.data = data; _cc.right = keyRight; read(_cc);
      c.data = data; c.right = keyLeft; read(c);
      if (visitor(_cc, c) === false) return;
    } else {
      c.data = data; c.right = keyLeft; read(c);
    }
    right = c.left;
  }
}

// ── Raw bytes ──

/** Zero-copy view of the raw rexc bytes for the node at cursor position. */
export function rawBytes(c: Cursor): Uint8Array {
  return c.data.subarray(c.left, c.right);
}

export type Refs = Record<string, unknown>;

// ── High-level Proxy API ──

const HANDLE = Symbol("rexc.handle");

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
  _keyMap?: Map<string, number>; // key → value right-offset, built by ensureKeyMap
};

type OpenContext = {
  root: unknown;
  resolve(right: number): unknown;
};

function _openContext(buffer: Uint8Array, refs?: Refs): OpenContext {
  const nodeMap = new WeakMap<object, NodeInfo>();
  const proxyCache = new Map<number, unknown>(); // right-offset → memoized value
  const scratch = makeCursor(buffer);

  function snap(c: Cursor): NodeInfo {
    return {
      data: c.data, right: c.right, tag: c.tag, val: c.val,
      left: c.left, ixWidth: c.ixWidth, ixCount: c.ixCount, schema: c.schema,
    };
  }

  /** Resolve a ref name to its opaque value, or undefined if not found. */
  function resolveRef(c: Cursor): unknown {
    if (!refs) return undefined;
    const name = readStr(c);
    return name in refs ? refs[name] : undefined;
  }

  /** Resolve a cursor to a string, following ptrs, chains, and refs (for key positions).
   *  Non-destructive: restores cursor state before returning. */
  function resolveKeyStr(c: Cursor): string {
    const savedLeft = c.left, savedRight = c.right, savedTag = c.tag, savedVal = c.val;
    while (c.tag === "ptr") { c.right = c.val; read(c); }
    let result: string;
    if (c.tag === "ref" && refs) {
      const val = resolveRef(c);
      result = typeof val === "string" ? val : resolveStr(c);
    } else {
      result = resolveStr(c);
    }
    c.left = savedLeft; c.right = savedRight; c.tag = savedTag; c.val = savedVal;
    return result;
  }

  function wrap(c: Cursor): unknown {
    while (c.tag === "ptr") { c.right = c.val; read(c); }
    if (c.tag === "ref") return resolveRef(c);
    // Check cache for containers (primitives are cheap to recreate)
    const cached = proxyCache.get(c.right);
    if (cached !== undefined) return cached;
    switch (c.tag) {
      case "int": case "float": return c.val;
      case "str": return readStr(c);
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
    // Object without index — scan children
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
    // Schema objects need ensureKeyMap (findKey can't resolve ref/ptr schemas).
    // Non-schema objects use findKey directly (O(log n) with indexes).
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
      // Resolve ref schemas to opaque values — extract keys from arrays/objects
      if (sc.tag === "ref" && refs) {
        const refVal = resolveRef(sc);
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
        // Inline schema — read keys from the schema's buffer
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
        // skip value
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
        // Delegate Array.prototype methods to a materialized snapshot
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

    set() { throw new TypeError("rexc data is read-only"); },
    deleteProperty() { throw new TypeError("rexc data is read-only"); },
  };

  function resolve(right: number): unknown {
    scratch.data = buffer;
    scratch.right = right;
    read(scratch);
    return wrap(scratch);
  }

  // Read and wrap root
  const root = resolve(buffer.length);
  return { root, resolve };
}

/** Open a rexc buffer and return a Proxy-wrapped root value. */
export function open(buffer: Uint8Array, refs?: Refs): unknown {
  return _openContext(buffer, refs).root;
}

/** Get the raw handle from a Proxy-wrapped value (escape hatch). */
export function handle(proxy: unknown): { data: Uint8Array; right: number } | undefined {
  if (proxy && typeof proxy === "object" && HANDLE in proxy) {
    return (proxy as any)[HANDLE];
  }
  return undefined;
}

// ── Inspect API ──

/** AST node mapping 1:1 to a REXC tag+b64 pair in the byte stream.
 *  Acts like an array of its children: node[0], node.length, for...of, JSON.stringify all work.
 *  Named properties provide the encoding metadata.
 */
export interface ASTNode {
  /** Backing buffer (non-enumerable, shared). */
  readonly data: Uint8Array;
  /** Byte offset of the tag byte. */
  readonly left: number;
  /** Byte offset after the node (after tag + b64 suffix). */
  readonly right: number;
  /** Byte length of content preceding the tag. Children live in [left - size, left). */
  readonly size: number;
  /** Single-character tag: '+' '*' ',' "'" ':' ';' '^' '.' '#' */
  readonly tag: string;
  /** b64 payload — type depends on tag. */
  readonly b64: number | string | { count: number; width: number };
  /** Resolved JS value via open() — lazy. Primitives or open() Proxy. */
  readonly value: unknown;

  // Array-like: numeric index → child ASTNode, .length → child count
  readonly length: number;
  readonly [index: number]: ASTNode;
  [Symbol.iterator](): Iterator<ASTNode>;

  // Semantic utilities (meaningful on containers)
  /** Semantic entry count: number of key-value pairs (objects) or items (arrays). O(1) for indexed containers. */
  readonly entryCount: number;
  keys(): Iterable<ASTNode>;
  values(): Iterable<ASTNode>;
  entries(): Iterable<[ASTNode, ASTNode]>;
  filteredKeys(prefix: string): Iterable<[ASTNode, ASTNode]>;
  index(key: number | string): ASTNode | undefined;
  /** Follow pointers (^) to the target node. Returns self if not a pointer. */
  readonly resolve: ASTNode;
}

const TAG_CHARS: Record<number, string> = {
  0x2b: "+", 0x2a: "*", 0x2c: ",", 0x27: "'",
  0x3a: ":", 0x3b: ";", 0x5e: "^", 0x2e: ".", 0x23: "#",
};

// Internal state for each ASTNode's incremental child parsing
type NodeState = {
  data: Uint8Array;
  left: number;
  right: number;
  size: number;
  tag: string;
  b64: number | string | { count: number; width: number };
  // Incremental child cache
  cache: ASTNode[];
  nextPos: number;  // next byte offset to parse from (scanning right-to-left)
  end: number;      // left boundary of content region
  done: boolean;    // true when all children have been parsed
};

/** Inspect a rexc buffer, returning a lazy AST that maps 1:1 to the encoding. */
export function inspect(buffer: Uint8Array, refs?: Refs): ASTNode {
  const ctx = _openContext(buffer, refs);
  const stateMap = new WeakMap<object, NodeState>();

  /** Follow pointers (^) to the target node. Returns self if not a pointer. */
  function resolveNode(node: ASTNode): ASTNode {
    let current = node;
    let depth = 0;
    while (current.tag === "^" && depth++ < 100) {
      const target = current.left - (current.b64 as number);
      current = makeNode(target);
    }
    return current;
  }

  function parseTag(right: number): { left: number; tagByte: number; tagChar: string; b64val: number | string | { count: number; width: number }; size: number } {
    const c = makeCursor(buffer);
    c.right = right;
    const tagByte = peekTag(c);
    const left = c.left;
    const tagChar = TAG_CHARS[tagByte] ?? String.fromCharCode(tagByte);

    let b64val: number | string | { count: number; width: number };
    let size: number;

    switch (tagByte) {
      case 0x2b: // + integer (signed)
        b64val = fromZigZag(b64Read(buffer, left + 1, right));
        size = 0;
        break;
      case 0x2a: { // * decimal (signed exponent)
        b64val = fromZigZag(b64Read(buffer, left + 1, right));
        const inner = makeCursor(buffer);
        inner.right = left;
        read(inner);
        size = left - inner.left;
        break;
      }
      case 0x2c: // , string
        b64val = b64Read(buffer, left + 1, right);
        size = b64val as number;
        break;
      case 0x27: // ' ref
        b64val = textDecoder.decode(buffer.subarray(left + 1, right));
        size = 0;
        break;
      case 0x3a: // : object
        b64val = b64Read(buffer, left + 1, right);
        size = b64val as number;
        break;
      case 0x3b: // ; array
        b64val = b64Read(buffer, left + 1, right);
        size = b64val as number;
        break;
      case 0x5e: // ^ pointer
        b64val = b64Read(buffer, left + 1, right);
        size = 0;
        break;
      case 0x2e: // . chain
        b64val = b64Read(buffer, left + 1, right);
        size = b64val as number;
        break;
      case 0x23: { // # index
        const packed = b64Read(buffer, left + 1, right);
        const width = (packed & 0b111) + 1;
        const count = packed >> 3;
        b64val = { count, width };
        size = width * count;
        break;
      }
      default:
        throw new SyntaxError(`inspect: unknown tag 0x${tagByte.toString(16)}`);
    }

    return { left, tagByte, tagChar, b64val, size };
  }

  /** Parse children up to (and including) the target index. Returns the child or undefined. */
  function ensureChild(state: NodeState, idx: number): ASTNode | undefined {
    if (idx < state.cache.length) return state.cache[idx];
    if (state.done) return undefined;

    while (state.cache.length <= idx) {
      if (state.nextPos <= state.end) {
        state.done = true;
        return undefined;
      }
      const child = makeNode(state.nextPos);
      state.cache.push(child);
      const cs = stateMap.get(child as unknown as object)!;
      state.nextPos = cs.left - cs.size;
    }
    return state.cache[idx];
  }

  /** Parse all remaining children. */
  function ensureAll(state: NodeState): void {
    if (state.done) return;
    while (state.nextPos > state.end) {
      const child = makeNode(state.nextPos);
      state.cache.push(child);
      const cs = stateMap.get(child as unknown as object)!;
      state.nextPos = cs.left - cs.size;
    }
    state.done = true;
  }

  function makeNode(right: number): ASTNode {
    const { left, tagChar, b64val, size } = parseTag(right);

    const state: NodeState = {
      data: buffer,
      left,
      right,
      size,
      tag: tagChar,
      b64: b64val,
      cache: [],
      nextPos: left, // start scanning right-to-left from just before the tag
      end: left - size,
      // Only container-like tags have parseable children
      done: !(tagChar === ":" || tagChar === ";" || tagChar === "." || tagChar === "*"),
    };

    let _value: unknown;
    let _hasValue = false;

    const target = Object.create(null);
    const proxy = new Proxy(target, {
      get(_, prop) {
        // Numeric index
        if (typeof prop === "string") {
          const idx = Number(prop);
          if (Number.isInteger(idx) && idx >= 0) {
            return ensureChild(state, idx);
          }
        }

        switch (prop) {
          case "data": return buffer;
          case "left": return state.left;
          case "right": return state.right;
          case "size": return state.size;
          case "tag": return state.tag;
          case "b64": return state.b64;
          case "value":
            if (!_hasValue) { _value = ctx.resolve(right); _hasValue = true; }
            return _value;
          case "length":
            ensureAll(state);
            return state.cache.length;
          case "entryCount": {
            // Semantic entry count: O(1) for indexed containers, fallback for small ones
            if (state.tag === ":" || state.tag === ";") {
              for (let ci = 0; ci < 2; ci++) {
                const child = ensureChild(state, ci);
                if (!child) break;
                const cs = stateMap.get(child as unknown as object)!;
                if (cs.tag === "#") return (cs.b64 as { count: number; width: number }).count;
              }
              // Small unindexed: count via entries for objects, ensureAll for arrays
              if (state.tag === ":") {
                let n = 0;
                for (const _ of entriesOf(proxy as ASTNode)) n++;
                return n;
              }
              ensureAll(state);
              return state.cache.length;
            }
            return 0;
          }
          case "keys": return () => keysOf(proxy as ASTNode);
          case "values": return () => valuesOf(proxy as ASTNode);
          case "entries": return () => entriesOf(proxy as ASTNode);
          case "filteredKeys": return (prefix: string) => filteredKeysOf(proxy as ASTNode, prefix);
          case "index": return (key: number | string) => indexOf(proxy as ASTNode, key);
          case "resolve": return resolveNode(proxy as ASTNode);
          case Symbol.iterator:
            return function* () {
              let i = 0;
              while (true) {
                const child = ensureChild(state, i);
                if (child === undefined) return;
                yield child;
                i++;
              }
            };
          case "toJSON":
            return () => {
              const obj: any = { tag: state.tag, b64: state.b64, left: state.left, right: state.right, size: state.size };
              // Only tags with parseable children: containers, chain, decimal
              if (state.size > 0 && (state.tag === ":" || state.tag === ";" || state.tag === "." || state.tag === "*")) {
                const children: unknown[] = [];
                for (const child of proxy as any) children.push(child);
                obj.children = children;
              }
              return obj;
            };
        }

        // Array methods — materialize and delegate
        if (typeof prop === "string" && typeof (Array.prototype as any)[prop] === "function") {
          return function (...args: unknown[]) {
            ensureAll(state);
            return (Array.prototype as any)[prop].apply(state.cache, args);
          };
        }

        return undefined;
      },

      has(_, prop) {
        if (typeof prop === "string") {
          const idx = Number(prop);
          if (Number.isInteger(idx) && idx >= 0) {
            return ensureChild(state, idx) !== undefined;
          }
        }
        if (prop === "length" || prop === "tag" || prop === "b64" || prop === "left" ||
          prop === "right" || prop === "size" || prop === "value" || prop === "data" ||
          prop === "keys" || prop === "values" || prop === "entries" ||
          prop === "filteredKeys" || prop === "index" || prop === "resolve" || prop === Symbol.iterator) {
          return true;
        }
        return false;
      },

      ownKeys() {
        ensureAll(state);
        const ks: string[] = [];
        for (let i = 0; i < state.cache.length; i++) ks.push(String(i));
        ks.push("length", "tag", "b64", "left", "right", "size");
        return ks;
      },

      getOwnPropertyDescriptor(_, prop) {
        if (prop === "length") {
          ensureAll(state);
          return { configurable: true, enumerable: false, value: state.cache.length, writable: false };
        }
        if (typeof prop === "string") {
          const idx = Number(prop);
          if (Number.isInteger(idx) && idx >= 0) {
            const child = ensureChild(state, idx);
            if (child !== undefined) {
              return { configurable: true, enumerable: true, value: child, writable: false };
            }
          }
        }
        // Named metadata props
        if (prop === "tag") return { configurable: true, enumerable: true, value: state.tag, writable: false };
        if (prop === "b64") return { configurable: true, enumerable: true, value: state.b64, writable: false };
        if (prop === "left") return { configurable: true, enumerable: true, value: state.left, writable: false };
        if (prop === "right") return { configurable: true, enumerable: true, value: state.right, writable: false };
        if (prop === "size") return { configurable: true, enumerable: true, value: state.size, writable: false };
        return undefined;
      },

      set() { throw new TypeError("inspect nodes are read-only"); },
      deleteProperty() { throw new TypeError("inspect nodes are read-only"); },
    });

    stateMap.set(proxy, state);
    return proxy as unknown as ASTNode;
  }

  // -- Semantic utilities --

  function* entriesOf(node: ASTNode): Iterable<[ASTNode, ASTNode]> {
    if (node.tag !== ":") return;
    const c = makeCursor(buffer);
    c.data = buffer; c.right = node.right; read(c);
    const hasSchema = c.schema !== 0;

    if (hasSchema) {
      const sc = makeCursor(buffer);
      sc.right = c.schema; read(sc);
      while (sc.tag === "ptr") { sc.right = sc.val; read(sc); }

      const contentEnd = node.left - node.size;
      let valPos = c.val;
      if (sc.tag === "array") {
        let keyPos = sc.val;
        const keyEnd = sc.left;
        while (keyPos > keyEnd && valPos > contentEnd) {
          const keyNode = makeNode(keyPos);
          const valNode = makeNode(valPos);
          yield [keyNode, valNode];
          const ks = stateMap.get(keyNode as unknown as object)!;
          const vs = stateMap.get(valNode as unknown as object)!;
          keyPos = ks.left - ks.size;
          valPos = vs.left - vs.size;
        }
      } else if (sc.tag === "object") {
        const kc = makeCursor(buffer);
        let keyPos = sc.val;
        const keyEnd = sc.left;
        while (keyPos > keyEnd && valPos > contentEnd) {
          const keyNode = makeNode(keyPos);
          const valNode = makeNode(valPos);
          yield [keyNode, valNode];
          const ks = stateMap.get(keyNode as unknown as object)!;
          const vs = stateMap.get(valNode as unknown as object)!;
          kc.data = buffer; kc.right = ks.left - ks.size; read(kc);
          keyPos = kc.left;
          valPos = vs.left - vs.size;
        }
      }
      return;
    }

    const contentEnd = node.left - node.size;
    let pos = c.val;
    while (pos > contentEnd) {
      const keyNode = makeNode(pos);
      const ks = stateMap.get(keyNode as unknown as object)!;
      const keyLeft = ks.left - ks.size;
      if (keyLeft <= contentEnd) break;
      const valNode = makeNode(keyLeft);
      const vs = stateMap.get(valNode as unknown as object)!;
      yield [keyNode, valNode];
      pos = vs.left - vs.size;
    }
  }

  function* keysOf(node: ASTNode): Iterable<ASTNode> {
    for (const [k] of entriesOf(node)) yield k;
  }

  function* valuesOf(node: ASTNode): Iterable<ASTNode> {
    if (node.tag === ";") {
      const c = makeCursor(buffer);
      c.data = buffer; c.right = node.right; read(c);
      const contentEnd = node.left - node.size;
      let pos = c.val;
      while (pos > contentEnd) {
        const child = makeNode(pos);
        yield child;
        const cs = stateMap.get(child as unknown as object)!;
        pos = cs.left - cs.size;
      }
      return;
    }
    if (node.tag === ":") {
      for (const [, v] of entriesOf(node)) yield v;
    }
  }

  function* filteredKeysOf(node: ASTNode, prefix: string): Iterable<[ASTNode, ASTNode]> {
    if (node.tag !== ":") return;
    const prefixBytes = prepareKey(prefix);

    const c = makeCursor(buffer);
    c.data = buffer; c.right = node.right; read(c);
    if (c.ixWidth > 0 && c.ixCount > 0 && c.schema === 0) {
      const container = { ...c, data: buffer } as unknown as Cursor;
      const sc2 = makeCursor(buffer);

      let lo = 0, hi = c.ixCount;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        seekChild(sc2, container, mid);
        const cmp = strCompare(sc2, prefixBytes);
        if (cmp < 0) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < container.ixCount; i++) {
        seekChild(sc2, container, i);
        if (!strHasPrefix(sc2, prefixBytes)) break;
        const keyNode = makeNode(sc2.right);
        const valNode = makeNode(sc2.left);
        yield [keyNode, valNode];
      }
      return;
    }

    for (const [k, v] of entriesOf(node)) {
      const kc = makeCursor(buffer);
      kc.data = buffer; kc.right = k.right; read(kc);
      if (strHasPrefix(kc, prefixBytes)) {
        yield [k, v];
      }
    }
  }

  function indexOf(node: ASTNode, key: number | string): ASTNode | undefined {
    const c = makeCursor(buffer);
    c.data = buffer; c.right = node.right; read(c);

    if (node.tag === ";" && typeof key === "number") {
      if (c.ixWidth > 0 && c.ixCount > 0) {
        if (key < 0 || key >= c.ixCount) return undefined;
        const container = { ...c, data: buffer } as unknown as Cursor;
        seekChild(c, container, key);
        return makeNode(c.right);
      }
      const contentEnd = node.left - node.size;
      let pos = c.val;
      let i = 0;
      while (pos > contentEnd) {
        const child = makeNode(pos);
        if (i === key) return child;
        const cs = stateMap.get(child as unknown as object)!;
        pos = cs.left - cs.size;
        i++;
      }
      return undefined;
    }

    if (node.tag === ":" && typeof key === "string") {
      const container = { ...c, data: buffer } as unknown as Cursor;
      const result = makeCursor(buffer);
      if (findKey(result, container, key)) {
        return makeNode(result.right);
      }
      return undefined;
    }

    return undefined;
  }

  return makeNode(buffer.length);
}

// ── High-level decode ──

export interface DecodeOptions {
  /** External dictionary of known values. Values are returned as-is when a ref is encountered. */
  refs?: Refs;
}

/** Decode a rexc buffer into a plain JS value using the Proxy-based reader. */
export function decode(input: Uint8Array, options?: DecodeOptions): unknown {
  return open(input, options?.refs);
}

/** Parse a rexc string into a plain JS value. */
export function parse(input: string, options?: DecodeOptions): unknown {
  return decode(textEncoder.encode(input), options);
}

// ── Encoder ──

export interface EncodeOptions {
  /** Stream chunks instead of returning a buffer */
  onChunk?: (chunk: Uint8Array, offset: number) => void;
  /** External dictionary of known values (UPPERCASE KEYS) */
  refs?: Refs;
  /** Override INDEX_THRESHOLD for this encode call. 0 = always index, Infinity = never index. */
  indexThreshold?: number;
  /** Override STRING_CHAIN_THRESHOLD. 0 = always split on delimiter, Infinity = never split. */
  stringChainThreshold?: number;
  /** Override STRING_CHAIN_DELIMITER. Empty string disables chain splitting. */
  stringChainDelimiter?: string;
  /** Override KEY_COMPLEXITY_THRESHOLD for structural dedup. */
  keyComplexityThreshold?: number;
}

export type StringifyOptions = Omit<EncodeOptions, "onChunk"> & {
  onChunk?: (chunk: string, offset: number) => void;
};

const ENCODE_DEFAULTS = {
  refs: {},
} as const satisfies Partial<EncodeOptions>;

// ── Number helpers ──

function trimZeroes(str: string): [number, number] {
  const trimmed = str.replace(/0+$/, "");
  return [parseInt(trimmed, 10), str.length - trimmed.length];
}

export function splitNumber(val: number): [number, number] {
  if (Number.isInteger(val)) {
    if (Math.abs(val) < 10) return [val, 0];
    if (Math.abs(val) < 9.999999999999999e20) return trimZeroes(val.toString());
  }
  const decStr = val.toPrecision(14).match(/^([-+]?\d+)(?:\.(\d+))?$/);
  if (decStr) {
    const b1 = parseInt((decStr[1] ?? "") + (decStr[2] ?? ""), 10);
    const e1 = -(decStr[2]?.length ?? 0);
    if (e1 === 0) return [b1, 0];
    const [b2, e2] = splitNumber(b1);
    return [b2, e1 + e2];
  }
  const sciStr = val.toExponential(14).match(/^([+-]?\d+)(?:\.(\d+))?(?:e([+-]?\d+))$/);
  if (sciStr) {
    const e1 = -(sciStr[2]?.length ?? 0);
    const e2 = parseInt(sciStr[3] ?? "0", 10);
    const [b1, e3] = trimZeroes(sciStr[1] + (sciStr[2] ?? ""));
    return [b1, e1 + e2 + e3];
  }
  throw new Error(`Invalid number format: ${val}`);
}

// Compare two strings in UTF-8 byte order (code point order preserves UTF-8 ordering)
export function utf8Sort(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len;) {
    const cpA = a.codePointAt(i) ?? 0;
    const cpB = b.codePointAt(i) ?? 0;
    if (cpA !== cpB) return cpA - cpB;
    i += cpA > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

// ── Identity key for pointer dedup ──

// Generates a stable cache key for dedup/ref lookups.
// Primitives return themselves (work as Map keys via SameValueZero).
// Objects get a structural string key so structurally equal objects deduplicate.
// Non-serializable values (functions, symbols) fall back to identity.
// TTL caps total work to avoid expensive cycles or huge objects.
const KeyMap = new WeakMap<object, string>();
export function makeKey(rootVal: unknown, ttl = KEY_COMPLEXITY_THRESHOLD): unknown {
  return walk(rootVal) ?? rootVal;
  function walk(val: unknown): string | undefined {
    if (--ttl <= 0) return;
    if (val === null || val === undefined) return String(val);
    switch (typeof val) {
      case "string": return JSON.stringify(val);
      case "number": case "boolean": case "bigint": return String(val);
      case "object": break;
      default: return; // functions, symbols → identity fallback
    }
    let key = KeyMap.get(val);
    if (key) return key;
    if (Array.isArray(val)) {
      const parts = new Array(val.length);
      for (let i = 0, l = val.length; i < l; i++) {
        const k = walk(val[i]); if (!k) return;
        parts[i] = k;
      }
      key = `[${parts.join(",")}]`;
    } else {
      const entries = Object.entries(val);
      const parts = new Array(entries.length);
      for (let i = 0, l = entries.length; i < l; i++) {
        const [ek, ev] = entries[i]!;
        const kk = walk(ek); if (!kk) return;
        const vk = walk(ev); if (!vk) return;
        parts[i] = `${kk}:${vk}`;
      }
      key = `{${parts.join(",")}}`;
    }
    KeyMap.set(val, key);
    return key;
  }
}

// ── Tag writers ──

function writeUnsigned(tag: string, value: number): string {
  return `${tag}${b64Stringify(value)}`;
}

function writeSigned(tag: string, value: number): string {
  return `${tag}${b64Stringify(toZigZag(value))}`;
}

// ── Public API ──

export function stringify(
  value: unknown,
  options: StringifyOptions & { onChunk: (chunk: string, offset: number) => void },
): undefined;
export function stringify(value: unknown, options?: StringifyOptions): string;
export function stringify(value: unknown, options?: StringifyOptions): string | undefined {
  const { onChunk, ...rest } = options ?? {};
  if (onChunk) {
    encode(value, {
      ...rest,
      onChunk: (chunk, offset) => onChunk(textDecoder.decode(chunk), offset),
    });
    return undefined;
  }
  return textDecoder.decode(encode(value, rest));
}

export function encode(
  value: unknown,
  options: EncodeOptions & { onChunk: (chunk: Uint8Array, offset: number) => void },
): undefined;
export function encode(value: unknown, options?: EncodeOptions): Uint8Array;
export function encode(rootValue: unknown, options?: EncodeOptions): Uint8Array | undefined {
  const opts = { ...ENCODE_DEFAULTS, ...options };
  const parts: Uint8Array[] = [];
  let byteLength = 0;
  const onChunk = opts.onChunk ?? ((chunk: Uint8Array) => parts.push(chunk));
  const indexThreshold = opts.indexThreshold ?? INDEX_THRESHOLD;
  const chainThreshold = opts.stringChainThreshold ?? STRING_CHAIN_THRESHOLD;
  const chainDelimiter = opts.stringChainDelimiter ?? STRING_CHAIN_DELIMITER;
  const refs = new Map<unknown, string>();
  for (const [key, val] of Object.entries({ ...opts.refs })) {
    refs.set(makeKey(val), key);
  }
  const seenOffsets = new Map<unknown, number>();
  const schemaOffsets = new Map<unknown, number | string>();
  const seenCosts = new Map<unknown, number>();

  // Pre-scan refs for schema keys
  for (const [key, val] of Object.entries(opts.refs)) {
    if (typeof val === "object" && val !== null) {
      schemaOffsets.set(makeKey(Array.isArray(val) ? val : Object.keys(val)), key);
    }
  }

  // Pre-scan for reused path prefixes
  const duplicatePrefixes = new Set<string>();
  const seenPrefixes = new Set<string>();
  scanPrefixes(rootValue);

  function scanPrefixes(value: unknown) {
    if (typeof value === "string" && value.length > chainThreshold && chainDelimiter && value.indexOf(chainDelimiter, 1) > 0) {
      if (!seenPrefixes.has(value)) {
        let offset = 0;
        while (offset < value.length) {
          const next = value.indexOf(chainDelimiter, offset + 1);
          if (next === -1) break;
          const prefix = value.slice(0, next);
          if (seenPrefixes.has(prefix)) duplicatePrefixes.add(prefix);
          else seenPrefixes.add(prefix);
          offset = next;
        }
      }
    } else if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        for (const item of value) scanPrefixes(item);
      } else {
        for (const [key, val] of Object.entries(value)) {
          scanPrefixes(key);
          scanPrefixes(val);
        }
      }
    }
  }

  writeAny(rootValue);

  if (opts.onChunk) return undefined;
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of parts) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;

  function pushBytes(bytes: Uint8Array) {
    onChunk(bytes, byteLength);
    return (byteLength += bytes.byteLength);
  }

  function pushString(str: string) {
    return pushBytes(textEncoder.encode(str));
  }

  function writeAny(value: unknown) {
    const key = makeKey(value);
    const refKey = refs.get(key);
    if (refKey !== undefined) return pushString(`'${refKey}`);
    const seenOffset = seenOffsets.get(key);
    if (seenOffset !== undefined) {
      const delta = byteLength - seenOffset;
      const seenCost = seenCosts.get(key) ?? 0;
      const pointerCost = Math.ceil(Math.log(delta + 1) / Math.log(64)) + 1;
      if (pointerCost < seenCost) return pushString(writeUnsigned("^", delta));
    }
    const before = byteLength;
    const ret = writeAnyInner(value);
    seenOffsets.set(key, byteLength);
    seenCosts.set(key, byteLength - before);
    return ret;
  }

  function writeAnyInner(value: unknown) {
    switch (typeof value) {
      case "string": return writeString(value);
      case "number": return writeNumber(value);
      case "boolean": return pushString(`'${value ? "t" : "f"}`);
      case "undefined": return pushString("'u");
      case "object":
        if (value === null) return pushString("'n");
        if (Array.isArray(value)) return writeArray(value);
        return writeObject(value as Record<string, unknown>);
      default:
        throw new TypeError(`Unsupported value type: ${typeof value}`);
    }
  }

  function writeString(value: string) {
    if (chainDelimiter && value.indexOf(chainDelimiter) >= 0) {
      let offset = value.length;
      let head: string | undefined;
      let tail: string | undefined;
      while (offset > 0) {
        offset = value.lastIndexOf(chainDelimiter, offset - 1);
        if (offset <= 0) break;
        const prefix = value.slice(0, offset);
        if (duplicatePrefixes.has(prefix)) {
          head = prefix;
          tail = value.substring(offset);
          break;
        }
      }
      if (head && tail) {
        const before = byteLength;
        writeAny(tail);
        writeAny(head);
        return pushString(writeUnsigned(".", byteLength - before));
      }
    }
    const utf8 = textEncoder.encode(value);
    pushBytes(utf8);
    return pushString(writeUnsigned(",", utf8.byteLength));
  }

  function writeNumber(value: number) {
    if (Number.isNaN(value)) return pushString("'nan");
    if (value === Infinity) return pushString("'inf");
    if (value === -Infinity) return pushString("'nif");
    const [base, exp] = splitNumber(value);
    if (exp >= 0 && exp < 5 && Number.isInteger(base) && Number.isSafeInteger(base)) {
      return pushString(writeSigned("+", value));
    }
    pushString(writeSigned("+", base));
    return pushString(writeSigned("*", exp));
  }

  function writeArray(value: unknown[]) {
    const start = byteLength;
    writeValues(value);
    return pushString(writeUnsigned(";", byteLength - start));
  }

  function writeValues(values: unknown[]) {
    const length = values.length;
    const offsets = length > indexThreshold ? new Array(length) : undefined;
    for (let i = length - 1; i >= 0; i--) {
      writeAny(values[i]);
      if (offsets) offsets[i] = byteLength;
    }
    if (offsets) {
      const lastOffset = offsets[offsets.length - 1] as number;
      const width = Math.ceil(Math.log(byteLength - lastOffset + 1) / Math.log(64));
      const pointers = offsets
        .map((o: number) => b64Stringify(byteLength - o).padStart(width, "0"))
        .join("");
      pushString(pointers);
      if (width > 8) throw new Error(`Index width exceeds maximum of 8 characters: ${width}`);
      pushString(writeUnsigned("#", (values.length << 3) | (width - 1)));
    }
  }

  function writeObject(value: Record<string, unknown>) {
    const keys = Object.keys(value);
    const length = keys.length;
    if (length === 0) return pushString(":");

    const keysKey = makeKey(keys);
    const schemaTarget = schemaOffsets.get(keysKey) ?? seenOffsets.get(keysKey);
    if (schemaTarget !== undefined) return writeSchemaObject(value, schemaTarget);

    const before = byteLength;
    const offsets = length > indexThreshold ? ({} as Record<string, number>) : undefined;
    let lastOffset: number | undefined;
    const entries = Object.entries(value);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, val] = entries[i] as [string, unknown];
      writeAny(val);
      writeAny(key);
      if (offsets) {
        offsets[key] = byteLength;
        lastOffset = lastOffset ?? byteLength;
      }
    }

    if (offsets && lastOffset !== undefined) {
      const width = Math.ceil(Math.log(byteLength - lastOffset + 1) / Math.log(64));
      const pointers = Object.entries(offsets)
        .sort(([a], [b]) => utf8Sort(a, b))
        .map(([, o]) => b64Stringify(byteLength - o).padStart(width, "0"))
        .join("");
      pushString(pointers);
      if (width > 8) throw new Error(`Index width exceeds maximum of 8 characters: ${width}`);
      pushString(writeUnsigned("#", (length << 3) | (width - 1)));
    }
    const ret = pushString(writeUnsigned(":", byteLength - before));
    schemaOffsets.set(keysKey, byteLength);
    return ret;
  }

  function writeSchemaObject(value: Record<string, unknown>, target: string | number) {
    const before = byteLength;
    writeValues(Object.values(value));
    if (typeof target === "string") pushString(`'${target}`);
    else pushString(writeUnsigned("^", byteLength - target));
    return pushString(writeUnsigned(":", byteLength - before));
  }
}
