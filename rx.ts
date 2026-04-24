///////////////////////////////////////////////////////////////////
//
// RX — compact text encoding for JSON-shaped data.
//
// Encodes JS values (objects, arrays, strings, numbers, booleans, null)
// into a text format that supports random-access reads without parsing
// the entire document. Used to encode deployment metadata for compact
// storage with sparse key lookups.
//
// Features:
//   - Structural deduplication (repeated values stored once via pointers)
//   - Schema sharing (repeated object shapes share key layout)
//   - String chain splitting (shared prefixes across path-like strings)
//   - O(log n) key lookup and O(1) array access via optional indexes
//
// Usage:
//   import { encode, stringify } from "./rx.ts";
//   const bytes = encode(myData);        // Uint8Array
//   const text  = stringify(myData);     // string
//
// For decoding / random-access reading, see rx-read.ts.
// For the binary variant (smaller output), see rxb.ts / rxb-read.ts.
// For the format specification, see docs/rx-format.md.
//
///////////////////////////////////////////////////////////////////

// TUNE AS NEEDED CONSTANTS
export let INDEX_THRESHOLD = 16; // Objects and Arrays with more values than this are indexed
export let STRING_CHAIN_THRESHOLD = 24; // Strings longer than this are eligible for splitting into chains
export let STRING_CHAIN_DELIMITER = "/."; // Delimiter chars for splitting long strings into chains
export let DEDUP_COMPLEXITY_LIMIT = 32; // Max recursive node count for structural dedup via JSON.stringify

// Tag byte constants (ASCII codes of the tag characters)
export const TAG_COMMA = 44;    // ','
export const TAG_DOT = 46;      // '.'
export const TAG_COLON = 58;    // ':'
export const TAG_SEMI = 59;     // ';'
export const TAG_HASH = 35;     // '#'
export const TAG_CARET = 94;    // '^'
export const TAG_PLUS = 43;     // '+'
export const TAG_STAR = 42;     // '*'

export function tune(options: Partial<{
  indexThreshold?: number;
  stringChainThreshold?: number;
  stringChainDelimiter?: string;
  dedupComplexityLimit?: number;
}>): void {
  if (options.indexThreshold !== undefined) INDEX_THRESHOLD = options.indexThreshold;
  if (options.stringChainThreshold !== undefined) STRING_CHAIN_THRESHOLD = options.stringChainThreshold;
  if (options.stringChainDelimiter !== undefined) STRING_CHAIN_DELIMITER = options.stringChainDelimiter;
  if (options.dedupComplexityLimit !== undefined) DEDUP_COMPLEXITY_LIMIT = options.dedupComplexityLimit;
}

// ── Base64 numeric system ──
// Numbers are written big-endian with the most significant digit on the left
// There is no padding, not even for zero, which is an empty string

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

// ── Encoder ──

export type Refs = Record<string, unknown>;

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
  /** Override DEDUP_COMPLEXITY_LIMIT. Objects/arrays with recursive node count below this are structurally deduped. 0 = disable. */
  dedupComplexityLimit?: number;
  /** Buffer chunk size in bytes. Chunks are flushed when full. Default 65536. */
  chunkSize?: number;
}

export type StringifyOptions = Omit<EncodeOptions, "onChunk"> & {
  onChunk?: (chunk: string, offset: number) => void;
};

const ENCODE_DEFAULTS = {
  refs: {},
} as const satisfies Partial<EncodeOptions>;

// ── Number helpers ──

function trimZeroes(str: string): [number, number] {
  // Manual scan avoids the /0+$/ regex allocation and state machine overhead.
  let end = str.length;
  while (end > 0 && str.charCodeAt(end - 1) === 48) end--;
  const trimmed = end === str.length ? str : str.substring(0, end);
  return [parseInt(trimmed, 10), str.length - end];
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

// Compare entry pairs by key in UTF-8 byte order — avoids closure allocation in sort()
function utf8SortEntries(a: [string, unknown], b: [string, unknown]): number {
  return utf8Sort(a[0], b[0]);
}

function entryValue(e: [string, unknown]): unknown {
  return e[1];
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

// Generates a stable cache key for ref lookups.
// Primitives get a type-tagged string. Objects use JSON.stringify (cached).
const KeyMap = new WeakMap<object, string>();
export function makeKey(rootVal: unknown): unknown {
  if (rootVal === null || rootVal === undefined) return String(rootVal);
  switch (typeof rootVal) {
    case "string": return '"' + rootVal;
    case "number": case "boolean": case "bigint": return String(rootVal);
    case "object": {
      let key = KeyMap.get(rootVal);
      if (!key) {
        key = JSON.stringify(rootVal);
        KeyMap.set(rootVal, key);
      }
      return key;
    }
    default: return rootVal;
  }
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
  const indexThreshold = opts.indexThreshold ?? INDEX_THRESHOLD;
  const chainThreshold = opts.stringChainThreshold ?? STRING_CHAIN_THRESHOLD;
  const chainDelimiter = opts.stringChainDelimiter ?? STRING_CHAIN_DELIMITER;

  // Build a fast delimiter lookup set for chain splitting
  const chainDelimSet = new Uint8Array(128);
  for (let i = 0; i < chainDelimiter.length; i++) chainDelimSet[chainDelimiter.charCodeAt(i)] = 1;

  const refs = new Map<unknown, string>();
  for (const [key, val] of Object.entries({ ...opts.refs })) {
    refs.set(makeKey(val), key);
  }
  // seen: Map<key, packed>. Packed encodes offset + cost into a single number.
  // layout: packed = offset * COST_BASE + cost, where COST_BASE = 2^20.
  // This assumes cost < 2^20 (1 MB) — true for all practical node sizes.
  // For offset up to 2^33 (8 GB), total packed stays within Number.MAX_SAFE_INTEGER (2^53).
  const COST_BASE = 1 << 20; // 1048576
  const seen = new Map<unknown, number>();
  const seenOffsets = new Map<unknown, number>();
  // Schema trie: nested objects keyed by individual key names, avoids join() allocation.
  // Terminal nodes store the offset under a Symbol key to avoid conflicts with real keys.
  const SCHEMA_OFFSET: unique symbol = Symbol();
  type SchemaTrie = { [key: string]: SchemaTrie } & { [SCHEMA_OFFSET]?: number | string };
  const schemaTrie: SchemaTrie = Object.create(null);

  // Traverses the trie, creating nodes as needed, and returns the leaf.
  // Caller reads/writes leaf[SCHEMA_OFFSET] directly.
  function schemaUpsert(keys: string[]): SchemaTrie {
    let node = schemaTrie;
    for (let i = 0; i < keys.length; i++) {
      node = node[keys[i]!] ??= Object.create(null);
    }
    return node;
  }
  const seenCosts = new Map<unknown, number>();

  // ── Chunked buffer ──
  // Both streaming and non-streaming use the same write path.
  // ensureCapacity flushes the current chunk when full.
  const CHUNK_SIZE = opts.chunkSize ?? 65536;
  const onChunk = opts.onChunk;
  const parts: Uint8Array[] = onChunk ? [] : []; // non-streaming collects for concat
  let buf = new Uint8Array(CHUNK_SIZE);
  let pos = 0;   // absolute position in output (for back-references)
  let off = 0;   // offset within current chunk

  function flush() {
    if (off === 0) return;
    const chunk = buf.subarray(0, off);
    if (onChunk) onChunk(chunk, pos - off);
    else parts.push(chunk);
    buf = new Uint8Array(CHUNK_SIZE);
    off = 0;
  }

  function ensureCapacity(needed: number) {
    if (off + needed <= buf.length) return;
    flush();
    if (needed > CHUNK_SIZE) buf = new Uint8Array(needed);
  }

  function pushASCII(str: string) {
    const len = str.length;
    ensureCapacity(len);
    for (let i = 0; i < len; i++) {
      buf[off + i] = str.charCodeAt(i);
    }
    pos += len;
    off += len;
    return pos;
  }

  // Write tag byte + b64 digits directly into buf — no intermediate string.

  function b64Width(num: number): number {
    // Branchy fast path: b64 digit width for non-negative integer.
    if (num < 64) return num === 0 ? 0 : 1;
    if (num < 4096) return 2;
    if (num < 262144) return 3;
    if (num < 16777216) return 4;
    if (num < 1073741824) return 5;
    // Fallback for very large values
    let w = 5;
    num = Math.floor(num / 1073741824);
    while (num > 0) { w++; num = Math.floor(num / 64); }
    return w;
  }

  function emitUnsigned(tag: number, value: number) {
    // Fast path: single-digit (most common — lengths/deltas under 64)
    if (value < 64) {
      ensureCapacity(2);
      buf[off] = tag;
      if (value === 0) {
        pos += 1; off += 1;
      } else {
        buf[off + 1] = b64encodeTable[value]!;
        pos += 2; off += 2;
      }
      return pos;
    }
    const w = b64Width(value);
    ensureCapacity(w + 1);
    buf[off] = tag;
    for (let i = w; i >= 1; i--) {
      buf[off + i] = b64encodeTable[value % 64]!;
      value = Math.trunc(value / 64);
    }
    pos += w + 1;
    off += w + 1;
    return pos;
  }

  function emitSigned(tag: number, value: number) {
    return emitUnsigned(tag, toZigZag(value));
  }

  // Pre-scan refs for schema keys
  for (const [key, val] of Object.entries(opts.refs)) {
    if (typeof val === "object" && val !== null) {
      const schemaKeys = Array.isArray(val) ? val : Object.keys(val);
      schemaUpsert(schemaKeys)[SCHEMA_OFFSET] = key;
    }
  }

  // Lazy prefix tracking for string chains — no pre-scan needed.
  // When we write a long string with delimiters, register its prefixes.
  // When a later string shares a registered prefix, split there.
  const knownPrefixes = chainDelimiter ? new Set<string>() : undefined;
  const prefixLengths = chainDelimiter ? new Set<number>() : undefined;

  // Min pointer cost is 2 bytes (^0). Skip dedup for values that will
  // always be cheaper to re-emit than to reference.
  const hasRefs = refs.size > 0;




  // Pre-scan: compute recursive complexity and stringify simple objects.
  // For simple objects (complexity < limit), cache the JSON key and count occurrences.
  // During encoding, only check dedup for keys that appeared more than once.
  // Pre-scan: depth-first traversal computing cost and dedup key bottom-up.
  // Each object's key is built from its children's cached keys — no JSON.stringify needed.
  // Objects over COMPLEXITY_LIMIT get no key (too expensive to dedup structurally).
  // Pre-scan: compute recursive complexity for every object/array, bottom-up.
  // Memoized in WeakMap — O(1) lookup during encode.
  // Pre-scan: mark objects/arrays with complexity below COMPLEXITY_LIMIT as
  // eligible for structural dedup via JSON.stringify. Only simple values are
  // stored in the set — complex values are skipped during encoding.
  const complexityLimit = opts.dedupComplexityLimit ?? DEDUP_COMPLEXITY_LIMIT;
  const simpleValues = new WeakSet<object>();

  (function prescan(val: unknown): number {
    if (typeof val !== "object" || val === null) return 1;
    if (simpleValues.has(val)) return 1; // already visited and simple
    let c = 1;
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) c += prescan(val[i]);
    } else {
      const keys = Object.keys(val);
      for (let i = 0; i < keys.length; i++) c += 1 + prescan((val as any)[keys[i]!]);
    }
    if (c < complexityLimit) simpleValues.add(val);
    return c;
  })(rootValue);

  writeAny(rootValue);
  flush();

  if (onChunk) return undefined;
  // Concat collected parts
  const output = new Uint8Array(pos);
  let outOff = 0;
  for (const part of parts) {
    output.set(part, outOff);
    outOff += part.byteLength;
  }
  return output;

  function isCheap(value: unknown): boolean {
    if (value === null || value === undefined || typeof value === "boolean") return true;
    if (typeof value === "number") {
      // small integers encode as +N (2-4 bytes)
      if (Number.isInteger(value) && value >= -2048 && value <= 2048) return true;
      return false;
    }
    if (typeof value === "string") {
      // string of length N costs N+2 bytes (utf8 + "," + b64 len)
      // pointer ^N costs 2-5 bytes depending on delta
      // for short strings the dedup savings are marginal
      return value.length <= 1;
    }
    return false;
  }

  // Try to emit a back-reference pointer if we've seen this key before.
  // Returns true if a pointer was emitted.
  function tryDedup(key: unknown): boolean {
    const seenOffset = seenOffsets.get(key);
    if (seenOffset === undefined) return false;
    const delta = pos - seenOffset;
    const seenCost = seenCosts.get(key) ?? 0;
    if (b64Width(delta) + 1 < seenCost) {
      emitUnsigned(TAG_CARET, delta);
      return true;
    }
    return false;
  }

  // Record this key's offset and encoded cost for future dedup.
  function recordDedup(key: unknown, before: number) {
    seenOffsets.set(key, pos);
    seenCosts.set(key, pos - before);
  }

  function writeAny(value: unknown) {
    // Fast path: skip dedup for values too cheap to ever benefit
    if (!hasRefs && isCheap(value)) return writeAnyInner(value);

    // Refs check
    if (hasRefs) {
      const refKey = refs.get(typeof value === "string" ? '"' + value
        : typeof value === "number" ? String(value)
        : makeKey(value));
      if (refKey !== undefined) return pushASCII(`'${refKey}`);
      if (typeof value !== "string" && typeof value !== "number"
        && (typeof value !== "object" || value === null)) return writeAnyInner(value);
    }

    // Primitives: use value directly as dedup key
    if (typeof value === "string") {
      if (tryDedup(value)) return pos;
      const before = pos;
      writeString(value);
      recordDedup(value, before);
      return pos;
    }
    if (typeof value === "number") {
      if (tryDedup(value)) return pos;
      const before = pos;
      writeNumber(value);
      recordDedup(value, before);
      return pos;
    }

    // Objects/arrays: structural dedup for simple values via JSON.stringify
    const isArr = Array.isArray(value);
    if (simpleValues.has(value as object)) {
      const key = JSON.stringify(value);
      if (tryDedup(key)) return pos;
      const before = pos;
      isArr ? writeArray(value) : writeObject(value as Record<string, unknown>);
      recordDedup(key, before);
      return pos;
    }
    return isArr ? writeArray(value) : writeObject(value as Record<string, unknown>);
  }

  function writeAnyInner(value: unknown) {
    switch (typeof value) {
      case "string": return writeString(value);
      case "number": return writeNumber(value);
      case "boolean": return pushASCII(value ? "'t" : "'f");
      case "undefined": return pushASCII("'u");
      case "object":
        if (value === null) return pushASCII("'n");
        if (Array.isArray(value)) return writeArray(value);
        return writeObject(value as Record<string, unknown>);
      default:
        throw new TypeError(`Unsupported value type: ${typeof value}`);
    }
  }

  function writeString(value: string) {
    if (knownPrefixes && value.length > chainThreshold) {
      // Find the last delimiter position (if any) in a single reverse pass.
      // If no delimiter exists, skip the whole chain block — no allocations.
      const vlen = value.length;
      let lastDelim = -1;
      for (let i = vlen - 1; i >= 1; i--) {
        const c = value.charCodeAt(i);
        if (c < 128 && chainDelimSet[c]!) { lastDelim = i; break; }
      }
      if (lastDelim > 0) {
        // Walk delimiters right-to-left looking for a registered prefix.
        let offset = lastDelim;
        while (offset > 0) {
          if (prefixLengths!.has(offset)) {
            const prefix = value.slice(0, offset);
            if (knownPrefixes.has(prefix)) {
              const before = pos;
              writeAny(value.substring(offset));
              writeAny(prefix);
              return emitUnsigned(TAG_DOT, pos - before);
            }
          }
          // find next delimiter to the left
          let prev = -1;
          for (let i = offset - 1; i >= 1; i--) {
            const c = value.charCodeAt(i);
            if (c < 128 && chainDelimSet[c]!) { prev = i; break; }
          }
          if (prev <= 0) break;
          offset = prev;
        }
        // No match — register this string's prefixes for future splits (left-to-right).
        offset = 0;
        while (offset < vlen) {
          let next = -1;
          for (let i = offset + 1; i < vlen; i++) {
            const c = value.charCodeAt(i);
            if (c < 128 && chainDelimSet[c]!) { next = i; break; }
          }
          if (next === -1) break;
          knownPrefixes.add(value.slice(0, next));
          prefixLengths!.add(next);
          offset = next;
        }
      }
    }
    const len = value.length;
    // Fast path: attempt single-pass ASCII write, fall through to TextEncoder
    // if we encounter a non-ASCII char. For short strings (<128 chars), most
    // real-world strings are pure ASCII and this avoids a separate scan pass.
    if (len < 128) {
      ensureCapacity(len * 3 + 16);
      let ok = true;
      for (let i = 0; i < len; i++) {
        const c = value.charCodeAt(i);
        if (c > 127) { ok = false; break; }
        buf[off + i] = c;
      }
      if (ok) {
        pos += len;
        off += len;
        return emitUnsigned(TAG_COMMA, len);
      }
      // Fall back to TextEncoder — buffer already ensured
      const result = textEncoder.encodeInto(value, buf.subarray(off));
      pos += result.written;
      off += result.written;
      return emitUnsigned(TAG_COMMA, result.written);
    }
    const maxBytes = len * 3;
    ensureCapacity(maxBytes + 16);
    const result = textEncoder.encodeInto(value, buf.subarray(off));
    pos += result.written;
    off += result.written;
    return emitUnsigned(TAG_COMMA, result.written);
  }

  function writeNumber(value: number) {
    if (Number.isNaN(value)) return pushASCII("'nan");
    if (value === Infinity) return pushASCII("'inf");
    if (value === -Infinity) return pushASCII("'nif");
    const [base, exp] = splitNumber(value);
    if (exp >= 0 && exp < 5 && Number.isInteger(base) && Number.isSafeInteger(base)) {
      return emitSigned(TAG_PLUS, value);
    }
    emitSigned(TAG_PLUS, base);
    return emitSigned(TAG_STAR, exp);
  }

  function writeArray(value: unknown[]) {
    const start = pos;
    writeValues(value);
    return emitUnsigned(TAG_SEMI, pos - start);
  }

  // Write a b64-encoded number of exactly `width` digits into buf at `offset`.
  // Pads with '0' (which is b64encodeTable[0]) on the left.
  function writeB64Fixed(target: Uint8Array, offset: number, num: number, width: number) {
    for (let i = width - 1; i >= 0; i--) {
      target[offset + i] = b64encodeTable[num % 64]!;
      num = (num / 64) | 0;
    }
  }

  function writeIndex(offsets: number[], count: number) {
    let minOffset = offsets[0]!;
    for (let i = 1; i < count; i++) {
      if (offsets[i]! < minOffset) minOffset = offsets[i]!;
    }
    const width = Math.max(1, Math.ceil(Math.log(pos - minOffset + 1) / Math.log(64)));
    if (width > 8) throw new Error(`Index width exceeds maximum of 8 characters: ${width}`);
    const totalBytes = count * width;
    ensureCapacity(totalBytes + 16);
    for (let i = 0; i < count; i++) {
      writeB64Fixed(buf, off + i * width, pos - offsets[i]!, width);
    }
    pos += totalBytes;
    off += totalBytes;
    emitUnsigned(TAG_HASH, (count << 3) | (width - 1));
  }

  function writeValues(values: unknown[]) {
    const length = values.length;
    if (length > indexThreshold) {
      const offsets = new Array<number>(length);
      for (let i = length - 1; i >= 0; i--) {
        writeAny(values[i]);
        offsets[i] = pos;
      }
      writeIndex(offsets, length);
    } else {
      for (let i = length - 1; i >= 0; i--) {
        writeAny(values[i]);
      }
    }
  }

  function writeObject(value: Record<string, unknown>, keys?: string[]) {
    if (!keys) keys = Object.keys(value);
    const length = keys.length;
    if (length === 0) return pushASCII(":");

    // Inline schemaUpsert: walk/create trie nodes for this key sequence.
    let schemaLeaf: SchemaTrie = schemaTrie;
    for (let i = 0; i < length; i++) {
      const k = keys[i]!;
      schemaLeaf = schemaLeaf[k] ??= Object.create(null);
    }
    const schemaTarget = schemaLeaf[SCHEMA_OFFSET];
    if (schemaTarget !== undefined) return writeSchemaObject(value, schemaTarget, keys);

    const before = pos;
    const needsIndex = length > indexThreshold;

    if (needsIndex) {
      // Pre-compute sorted order for index: sort key indices by UTF-8 order
      const sortedIndices = new Array<number>(length);
      for (let i = 0; i < length; i++) sortedIndices[i] = i;
      sortedIndices.sort((a, b) => utf8Sort(keys![a]!, keys![b]!));

      // Write entries in reverse insertion order, recording offset per key index
      const keyOffsets = new Array<number>(length);
      for (let i = length - 1; i >= 0; i--) {
        const key = keys[i]!;
        writeAny(value[key]);
        writeAny(key);
        keyOffsets[i] = pos;
      }

      // Build sorted offsets array for index
      const sortedOffsets = new Array<number>(length);
      for (let i = 0; i < length; i++) {
        sortedOffsets[i] = keyOffsets[sortedIndices[i]!]!;
      }
      writeIndex(sortedOffsets, length);
    } else {
      // Small object — no index needed; iterate keys directly (no Object.entries tuple alloc)
      for (let i = length - 1; i >= 0; i--) {
        const key = keys[i]!;
        writeAny(value[key]);
        writeAny(key);
      }
    }

    const ret = emitUnsigned(TAG_COLON, pos - before);
    schemaLeaf[SCHEMA_OFFSET] = pos;
    return ret;
  }

  function writeSchemaObject(value: Record<string, unknown>, target: string | number, keys: string[]) {
    const before = pos;
    const length = keys.length;
    // Inline writeValues logic to avoid building Object.values() array
    if (length > indexThreshold) {
      const offsets = new Array<number>(length);
      for (let i = length - 1; i >= 0; i--) {
        writeAny(value[keys[i]!]);
        offsets[i] = pos;
      }
      writeIndex(offsets, length);
    } else {
      for (let i = length - 1; i >= 0; i--) {
        writeAny(value[keys[i]!]);
      }
    }
    if (typeof target === "string") pushASCII(`'${target}`);
    else emitUnsigned(TAG_CARET, pos - target);
    return emitUnsigned(TAG_COLON, pos - before);
  }
}
