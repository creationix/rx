///////////////////////////////////////////////////////////////////
//
// RXB Encoder — compact binary encoding for JSON-shaped data.
//
// Encodes JS values (objects, arrays, strings, numbers, booleans, null)
// into a binary format optimized for:
//   - Small encoded size (97% smaller than JSON on real-world data)
//   - O(log n) key lookup and O(1) array access without full parsing
//   - Structural deduplication (repeated values stored once)
//   - Schema sharing (repeated object shapes share key layout)
//
// The format is a binary variant of RX (rx.ts) using base-128 varints
// and compact string encodings (hex-packed, base64-packed).
//
// Usage:
//   import { encode } from "./rxb.ts";
//   const buffer = encode(myData);
//
// For decoding / random-access reading, see rxb-read.ts.
// For the text-based RX format, see rx.ts.
// For the format specification, see docs/rxb-format.md.
//
///////////////////////////////////////////////////////////////////

import {
  toZigZag,
  splitNumber,
  makeKey,
  INDEX_THRESHOLD,
  STRING_CHAIN_THRESHOLD,
  DEDUP_COMPLEXITY_LIMIT,
} from "./rx.ts";

// ── Tag constants (4-bit, packed into low nibble of varint) ──

export const TAG_INT = 0x0;
export const TAG_DECIMAL = 0x1;
export const TAG_STRING = 0x2;
export const TAG_HEXSTR = 0x3;
export const TAG_REF = 0x4;
export const TAG_LIST = 0x5;
export const TAG_MAP = 0x6;
export const TAG_POINTER = 0x7;
export const TAG_CHAIN = 0x8;
export const TAG_INDEX = 0x9;
export const TAG_B64STR = 0xA;

// ── Ref code constants ──

export const REF_NULL = 0;
export const REF_TRUE = 1;
export const REF_FALSE = 2;
export const REF_UNDEF = 3;
export const REF_INF = 4;
export const REF_NINF = 5;
export const REF_NAN = 6;
export const REF_EXTERNAL_BASE = 7;

// ── Combined tag+varint encoding ──
//
// Each node ends with a variable-length byte sequence packing tag + value:
//   Tag byte (leftmost, MSB=0): [0][value_low:3][tag:4]
//   Extension bytes (MSB=1):    [1][value:7], big-endian
//
// When scanning right-to-left, extension bytes (MSB=1) are consumed first,
// then the tag byte (MSB=0) terminates the scan. Body bytes to the left
// of the tag byte are never reached.

/** Compute the number of bytes needed to encode tag+value. */
export function tagVarintSize(tag: number, value: number): number {
  if (value < 8) return 1;
  let n = 1;
  value = Math.floor(value / 8);
  while (value > 0) { n++; value = Math.floor(value / 128); }
  return n;
}

/** Write tag+value into data starting at offset. Returns bytes written. */
export function tagVarintWrite(
  data: Uint8Array,
  offset: number,
  tag: number,
  value: number,
): number {
  const tagBits = value & 0x07;
  const tagByte = (tagBits << 4) | (tag & 0x0F);
  let remaining = Math.floor(value / 8);

  if (remaining === 0) {
    data[offset] = tagByte;
    return 1;
  }

  const extBytes: number[] = [];
  while (remaining > 0) {
    extBytes.push((remaining & 0x7F) | 0x80);
    remaining = Math.floor(remaining / 128);
  }

  let pos = offset;
  data[pos++] = tagByte;
  for (let i = extBytes.length - 1; i >= 0; i--) {
    data[pos++] = extBytes[i]!;
  }

  return pos - offset;
}

/** Read tag+value from data ending at `right`. Used by the decoder. */
export function tagVarintRead(
  data: Uint8Array,
  right: number,
): { tag: number; value: number; left: number } {
  let pos = right - 1;
  let extValue = 0;
  let shift = 1;

  while (pos >= 0 && (data[pos]! & 0x80) !== 0) {
    extValue = extValue + (data[pos]! & 0x7F) * shift;
    shift *= 128;
    pos--;
  }

  if (pos < 0) throw new SyntaxError("tagVarintRead: no tag byte found");

  const tagByte = data[pos]!;
  const tag = tagByte & 0x0F;
  const tagBits = (tagByte >> 4) & 0x07;
  const value = tagBits + extValue * 8;

  return { tag, value, left: pos };
}

// ── String encoding helpers ──

// Hex lookup: charCode → nibble value (0xFF = not a hex char)
const hexChars = new Uint8Array(256);
for (let i = 0; i < 256; i++) hexChars[i] = 0xFF;
for (let i = 0; i < 10; i++) hexChars[0x30 + i] = i;       // '0'-'9'
for (let i = 0; i < 6; i++) hexChars[0x61 + i] = 10 + i;   // 'a'-'f'

const hexDigits = "0123456789abcdef";

// B64 lookup: charCode → 6-bit value (0xFF = not a b64 char)
// Alphabet: 0-9 a-z A-Z - _ (URL-safe, same as RX base64)
const b64sChars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const b64sDecodeTable = new Uint8Array(128).fill(0xFF);
for (let i = 0; i < 64; i++) b64sDecodeTable[b64sChars.charCodeAt(i)] = i;

/** Classify a string as hex, b64, or regular in a single pass.
 *  Returns 0 (regular), 1 (hex), or 2 (b64). */
export function classifyString(s: string): 0 | 1 | 2 {
  if (s.length < 4) return 0;
  let allHex = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 127 || b64sDecodeTable[c]! === 0xFF) return 0;
    if (allHex && hexChars[c]! === 0xFF) allHex = false;
  }
  return allHex ? 1 : 2;
}

/** Pack hex string directly into target buffer. Returns bytes written. */
export function hexEncodeInto(hex: string, target: Uint8Array, targetOff: number): number {
  const byteLen = Math.ceil(hex.length / 2);
  const pad = hex.length % 2;
  for (let i = 0; i < hex.length; i++) {
    const nibble = hexChars[hex.charCodeAt(i)]!;
    const byteIdx = (i + pad) >> 1;
    if ((i + pad) % 2 === 0) target[targetOff + byteIdx] = nibble << 4;
    else target[targetOff + byteIdx]! |= nibble;
  }
  return byteLen;
}

/** Unpack bytes back to a hex string. Used by the decoder. */
export function hexDecode(data: Uint8Array, start: number, byteLen: number, charCount: number): string {
  let result = "";
  for (let i = 0; i < byteLen; i++) {
    const b = data[start + i]!;
    result += hexDigits[b >> 4];
    result += hexDigits[b & 0x0F];
  }
  return charCount % 2 === 0 ? result : result.slice(1);
}

/** Pack b64 string directly into target buffer (6 bits per char). Returns bytes written. */
export function b64sEncodeInto(s: string, target: Uint8Array, targetOff: number): number {
  const byteLen = Math.ceil(s.length * 6 / 8);
  let bitBuf = 0;
  let bitCount = 0;
  let byteIdx = targetOff;
  for (let i = 0; i < s.length; i++) {
    bitBuf = (bitBuf << 6) | b64sDecodeTable[s.charCodeAt(i)]!;
    bitCount += 6;
    while (bitCount >= 8) {
      bitCount -= 8;
      target[byteIdx++] = (bitBuf >> bitCount) & 0xFF;
    }
  }
  if (bitCount > 0) {
    target[byteIdx] = (bitBuf << (8 - bitCount)) & 0xFF;
  }
  return byteLen;
}

/** Unpack bytes back to a b64 string. Used by the decoder. */
export function b64sDecode(data: Uint8Array, start: number, byteLen: number, charCount: number): string {
  let result = "";
  let bitBuf = 0;
  let bitCount = 0;
  let byteIdx = start;
  for (let i = 0; i < charCount; i++) {
    while (bitCount < 6 && byteIdx < start + byteLen) {
      bitBuf = (bitBuf << 8) | data[byteIdx++]!;
      bitCount += 8;
    }
    bitCount -= 6;
    result += b64sChars[(bitBuf >> bitCount) & 0x3F];
  }
  return result;
}

// ── Encoder ──

const textEncoder = new TextEncoder();

export interface EncodeOptions {
  onChunk?: (chunk: Uint8Array, offset: number) => void;
  refs?: Record<string, unknown>;
  indexThreshold?: number;
  stringChainThreshold?: number;
  stringChainDelimiter?: string;
  dedupComplexityLimit?: number;
  chunkSize?: number;
}

const ENCODE_DEFAULTS = {
  refs: {},
} as const satisfies Partial<EncodeOptions>;

export function encode(
  value: unknown,
  options: EncodeOptions & { onChunk: (chunk: Uint8Array, offset: number) => void },
): undefined;
export function encode(value: unknown, options?: EncodeOptions): Uint8Array;
export function encode(rootValue: unknown, options?: EncodeOptions): Uint8Array | undefined {
  const opts = { ...ENCODE_DEFAULTS, ...options };
  const indexThreshold = opts.indexThreshold ?? INDEX_THRESHOLD;
  const chainThreshold = opts.stringChainThreshold ?? Math.min(STRING_CHAIN_THRESHOLD, 24);
  const chainDelimiter = opts.stringChainDelimiter ?? "/.";

  // Build a fast delimiter lookup set for chain splitting
  const chainDelimSet = new Uint8Array(128);
  for (let i = 0; i < chainDelimiter.length; i++) chainDelimSet[chainDelimiter.charCodeAt(i)] = 1;

  function hasDelimiter(s: string, from: number): boolean {
    for (let i = from; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 128 && chainDelimSet[c]!) return true;
    }
    return false;
  }

  function lastDelimiterPos(s: string, before: number): number {
    for (let i = before; i >= 0; i--) {
      const c = s.charCodeAt(i);
      if (c < 128 && chainDelimSet[c]!) return i;
    }
    return -1;
  }

  function nextDelimiterPos(s: string, after: number): number {
    for (let i = after; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 128 && chainDelimSet[c]!) return i;
    }
    return -1;
  }

  // Build ref name table (sorted for deterministic index assignment)
  const refEntries = Object.entries({ ...opts.refs });
  const sortedRefNames = refEntries.map(([k]) => k).sort();
  const refNameToIndex = new Map<string, number>();
  for (let i = 0; i < sortedRefNames.length; i++) {
    refNameToIndex.set(sortedRefNames[i]!, i);
  }

  const refsByKey = new Map<unknown, number>();
  for (const [key, val] of refEntries) {
    const idx = refNameToIndex.get(key)!;
    refsByKey.set(makeKey(val), idx);
  }

  const seenOffsets = new Map<unknown, number>();
  const SCHEMA_OFFSET: unique symbol = Symbol();
  type SchemaTrie = { [key: string]: SchemaTrie } & { [SCHEMA_OFFSET]?: number | string };
  const schemaTrie: SchemaTrie = Object.create(null);

  function schemaUpsert(keys: string[]): SchemaTrie {
    let node = schemaTrie;
    for (let i = 0; i < keys.length; i++) {
      node = node[keys[i]!] ??= Object.create(null);
    }
    return node;
  }

  const seenCosts = new Map<unknown, number>();

  // ── Chunked buffer ──
  const CHUNK_SIZE = opts.chunkSize ?? 65536;
  const onChunk = opts.onChunk;
  const parts: Uint8Array[] = [];
  let buf = new Uint8Array(CHUNK_SIZE);
  let pos = 0;
  let off = 0;

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

  function emitTagVarint(tag: number, value: number) {
    const size = tagVarintSize(tag, value);
    ensureCapacity(size);
    tagVarintWrite(buf, off, tag, value);
    pos += size;
    off += size;
    return pos;
  }

  function emitSigned(tag: number, value: number) {
    return emitTagVarint(tag, toZigZag(value));
  }

  // Pre-scan refs for schema keys
  for (const [key, val] of refEntries) {
    if (typeof val === "object" && val !== null) {
      const schemaKeys = Array.isArray(val) ? val : Object.keys(val);
      schemaUpsert(schemaKeys)[SCHEMA_OFFSET] = key;
    }
  }

  // Lazy prefix tracking for string chains
  const knownPrefixes = chainDelimiter ? new Set<string>() : undefined;
  const prefixLengths = chainDelimiter ? new Set<number>() : undefined;

  const hasRefs = refsByKey.size > 0;

  // Pre-scan: mark simple objects for structural dedup
  const complexityLimit = opts.dedupComplexityLimit ?? DEDUP_COMPLEXITY_LIMIT;
  const simpleValues = new WeakSet<object>();

  (function prescan(val: unknown): number {
    if (typeof val !== "object" || val === null) return 1;
    if (simpleValues.has(val)) return 1;
    let c = 1;
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) c += prescan(val[i]);
    } else {
      for (const k in val) c += 1 + prescan((val as any)[k]);
    }
    if (c < complexityLimit) simpleValues.add(val);
    return c;
  })(rootValue);

  writeAny(rootValue);
  flush();

  if (onChunk) return undefined;
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
      if (Number.isInteger(value) && value >= -2048 && value <= 2048) return true;
      return false;
    }
    if (typeof value === "string") {
      return value.length <= 1;
    }
    return false;
  }

  function tryDedup(key: unknown): boolean {
    const seenOffset = seenOffsets.get(key);
    if (seenOffset === undefined) return false;
    const delta = pos - seenOffset;
    const seenCost = seenCosts.get(key) ?? 0;
    if (tagVarintSize(TAG_POINTER, delta) < seenCost) {
      emitTagVarint(TAG_POINTER, delta);
      return true;
    }
    return false;
  }

  function recordDedup(key: unknown, before: number) {
    seenOffsets.set(key, pos);
    seenCosts.set(key, pos - before);
  }

  function writeAny(value: unknown) {
    if (!hasRefs && isCheap(value)) return writeAnyInner(value);

    if (hasRefs) {
      const refKey = refsByKey.get(typeof value === "string" ? '"' + value
        : typeof value === "number" ? String(value)
        : makeKey(value));
      if (refKey !== undefined) return emitTagVarint(TAG_REF, refKey + REF_EXTERNAL_BASE);
      if (typeof value !== "string" && typeof value !== "number"
        && (typeof value !== "object" || value === null)) return writeAnyInner(value);
    }

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
      case "boolean": return emitTagVarint(TAG_REF, value ? REF_TRUE : REF_FALSE);
      case "undefined": return emitTagVarint(TAG_REF, REF_UNDEF);
      case "object":
        if (value === null) return emitTagVarint(TAG_REF, REF_NULL);
        if (Array.isArray(value)) return writeArray(value);
        return writeObject(value as Record<string, unknown>);
      default:
        throw new TypeError(`Unsupported value type: ${typeof value}`);
    }
  }

  function writeString(value: string) {
    // Chain splitting: share common prefixes across similar strings
    if (knownPrefixes && value.length > chainThreshold && hasDelimiter(value, 1)) {
      let offset = value.length;
      while (offset > 0) {
        offset = lastDelimiterPos(value, offset - 1);
        if (offset <= 0) break;
        if (prefixLengths!.has(offset)) {
          const prefix = value.slice(0, offset);
          if (knownPrefixes.has(prefix)) {
            const before = pos;
            writeAny(value.substring(offset));
            writeAny(prefix);
            return emitTagVarint(TAG_CHAIN, pos - before);
          }
        }
      }
      offset = 0;
      while (offset < value.length) {
        const next = nextDelimiterPos(value, offset + 1);
        if (next === -1) break;
        const prefix = value.slice(0, next);
        knownPrefixes.add(prefix);
        prefixLengths!.add(next);
        offset = next;
      }
    }

    // Single-pass classification: hex (50% savings), b64 (25%), or regular
    const cls = classifyString(value);
    if (cls === 1) {
      const byteLen = Math.ceil(value.length / 2);
      ensureCapacity(byteLen + 16);
      hexEncodeInto(value, buf, off);
      pos += byteLen;
      off += byteLen;
      return emitTagVarint(TAG_HEXSTR, value.length);
    }
    if (cls === 2) {
      const byteLen = Math.ceil(value.length * 6 / 8);
      ensureCapacity(byteLen + 16);
      b64sEncodeInto(value, buf, off);
      pos += byteLen;
      off += byteLen;
      return emitTagVarint(TAG_B64STR, value.length);
    }

    // Regular string
    const len = value.length;
    if (len < 128) {
      let ascii = true;
      for (let i = 0; i < len; i++) {
        if (value.charCodeAt(i) > 127) { ascii = false; break; }
      }
      if (ascii) {
        ensureCapacity(len + 16);
        for (let i = 0; i < len; i++) {
          buf[off + i] = value.charCodeAt(i);
        }
        pos += len;
        off += len;
        return emitTagVarint(TAG_STRING, len);
      }
    }

    const maxBytes = len * 3;
    ensureCapacity(maxBytes + 16);
    const result = textEncoder.encodeInto(value, buf.subarray(off));
    pos += result.written;
    off += result.written;
    return emitTagVarint(TAG_STRING, result.written);
  }

  function writeNumber(value: number) {
    if (Number.isNaN(value)) return emitTagVarint(TAG_REF, REF_NAN);
    if (value === Infinity) return emitTagVarint(TAG_REF, REF_INF);
    if (value === -Infinity) return emitTagVarint(TAG_REF, REF_NINF);
    const [base, exp] = splitNumber(value);
    if (exp >= 0 && exp < 5 && Number.isInteger(base) && Number.isSafeInteger(base)) {
      return emitSigned(TAG_INT, value);
    }
    emitSigned(TAG_INT, base);
    return emitSigned(TAG_DECIMAL, exp);
  }

  function writeArray(value: unknown[]) {
    const start = pos;
    writeValues(value);
    return emitTagVarint(TAG_LIST, pos - start);
  }

  function writeBinaryFixed(target: Uint8Array, offset: number, num: number, width: number) {
    for (let i = width - 1; i >= 0; i--) {
      target[offset + i] = num & 0xFF;
      num = (num / 256) | 0;
    }
  }

  function binaryWidth(maxValue: number): number {
    if (maxValue <= 0xFF) return 1;
    if (maxValue <= 0xFFFF) return 2;
    if (maxValue <= 0xFFFFFF) return 3;
    if (maxValue <= 0xFFFFFFFF) return 4;
    let w = 5;
    let limit = 0x100_0000_0000;
    while (maxValue >= limit && w < 8) { w++; limit *= 256; }
    return Math.min(w, 8);
  }

  function writeIndex(offsets: number[], count: number) {
    let maxDelta = 0;
    for (let i = 0; i < count; i++) {
      const delta = pos - offsets[i]!;
      if (delta > maxDelta) maxDelta = delta;
    }
    const width = binaryWidth(maxDelta);
    if (width > 8) throw new Error(`Index width exceeds maximum of 8 bytes: ${width}`);
    const totalBytes = count * width;
    ensureCapacity(totalBytes + 16);
    for (let i = 0; i < count; i++) {
      writeBinaryFixed(buf, off + i * width, pos - offsets[i]!, width);
    }
    pos += totalBytes;
    off += totalBytes;
    emitTagVarint(TAG_INDEX, (count << 3) | (width - 1));
  }

  function writeValues(values: unknown[]) {
    const length = values.length;
    const offsets = length > indexThreshold ? new Array(length) : undefined;
    for (let i = length - 1; i >= 0; i--) {
      writeAny(values[i]);
      if (offsets) offsets[i] = pos;
    }
    if (offsets) {
      writeIndex(offsets, length);
    }
  }

  function writeObject(value: Record<string, unknown>, keys?: string[]) {
    if (!keys) keys = Object.keys(value);
    const length = keys.length;
    if (length === 0) return emitTagVarint(TAG_MAP, 0);

    const schemaLeaf = length > 1 ? schemaUpsert(keys) : undefined;
    if (schemaLeaf) {
      const schemaTarget = schemaLeaf[SCHEMA_OFFSET];
      if (schemaTarget !== undefined) return writeSchemaObject(value, schemaTarget);
    }

    const before = pos;
    const needsIndex = length > indexThreshold;

    if (needsIndex) {
      const sortedIndices = new Array<number>(length);
      for (let i = 0; i < length; i++) sortedIndices[i] = i;
      sortedIndices.sort((a, b) => keys![a]! < keys![b]! ? -1 : keys![a]! > keys![b]! ? 1 : 0);

      const keyOffsets = new Array<number>(length);
      for (let i = length - 1; i >= 0; i--) {
        const key = keys[i]!;
        writeAny(value[key]);
        writeAny(key);
        keyOffsets[i] = pos;
      }

      const sortedOffsets = new Array<number>(length);
      for (let i = 0; i < length; i++) {
        sortedOffsets[i] = keyOffsets[sortedIndices[i]!]!;
      }
      writeIndex(sortedOffsets, length);
    } else {
      for (let i = length - 1; i >= 0; i--) {
        const key = keys[i]!;
        writeAny(value[key]);
        writeAny(key);
      }
    }

    const ret = emitTagVarint(TAG_MAP, pos - before);
    if (schemaLeaf) schemaLeaf[SCHEMA_OFFSET] = pos;
    return ret;
  }

  function writeSchemaObject(value: Record<string, unknown>, target: string | number) {
    const before = pos;
    writeValues(Object.values(value));
    if (typeof target === "string") {
      const idx = refNameToIndex.get(target);
      if (idx !== undefined) emitTagVarint(TAG_REF, idx + REF_EXTERNAL_BASE);
    } else {
      emitTagVarint(TAG_POINTER, pos - target);
    }
    return emitTagVarint(TAG_MAP, pos - before);
  }
}
