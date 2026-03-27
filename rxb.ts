/////////////////////
//
// RXB — Binary variant of RX encoding
// Same right-to-left design, but with:
//   - Combined tag+varint bytes (tag in low 4 bits)
//   - Base-128 varints instead of base-64
//   - Hexstring type for lowercase hex data
//
//////////////////

import {
  toZigZag,
  fromZigZag,
  splitNumber,
  utf8Sort,
  makeKey,
  INDEX_THRESHOLD,
  STRING_CHAIN_THRESHOLD,
  STRING_CHAIN_DELIMITER,
  DEDUP_COMPLEXITY_LIMIT,
} from "./rx.ts";

export {
  toZigZag,
  fromZigZag,
  splitNumber,
  utf8Sort,
  makeKey,
};

// ── Tag constants (4-bit, packed into low nibble) ──

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
// Layout (right-to-left, rightmost byte read first):
//   byte0 (rightmost): [continue:1][value:3][tag:4]
//   byte1+:            [continue:1][value:7]
//
// continue=1 means more bytes to the left.
// value=0 with no continuation bytes encodes as just the tag nibble.

/** Compute the number of bytes needed to encode tag+value. */
export function tagVarintSize(tag: number, value: number): number {
  if (value < 8) return 1;
  let n = 1;
  value = Math.floor(value / 8);
  while (value > 0) { n++; value = Math.floor(value / 128); }
  return n;
}

/** Write tag+value into data starting at offset. Returns bytes written.
 *
 *  Memory layout (left to right):
 *    [tag_byte (MSB=0)] [ext_MSB (MSB=1)] ... [ext_LSB (MSB=1)]
 *
 *  Tag byte: [0][value_low:3][tag:4]
 *  Extension bytes: [1][value:7], ordered MSB-first (big-endian within extensions)
 *
 *  When scanning right-to-left from `right`, extension bytes (MSB=1) are consumed
 *  first, then the tag byte (MSB=0) terminates the scan. Body bytes to the left
 *  of the tag are never reached. */
export function tagVarintWrite(
  data: Uint8Array,
  offset: number,
  tag: number,
  value: number,
): number {
  const tagBits = value & 0x07;
  const tagByte = (tagBits << 4) | (tag & 0x0F); // MSB always 0
  let remaining = Math.floor(value / 8);

  if (remaining === 0) {
    data[offset] = tagByte;
    return 1;
  }

  // Collect extension bytes LSB-group first
  const extBytes: number[] = [];
  while (remaining > 0) {
    extBytes.push((remaining & 0x7F) | 0x80);
    remaining = Math.floor(remaining / 128);
  }

  // Write tag byte first (leftmost)
  let pos = offset;
  data[pos++] = tagByte;
  // Write extension bytes MSB-first (leftmost) to LSB-last (rightmost)
  for (let i = extBytes.length - 1; i >= 0; i--) {
    data[pos++] = extBytes[i]!;
  }

  return pos - offset;
}

/** Read tag+value from data ending at `right`. Returns { tag, value, left }
 *  where left is the position of the tag byte (leftmost byte of this tag+varint). */
export function tagVarintRead(
  data: Uint8Array,
  right: number,
): { tag: number; value: number; left: number } {
  // Scan right-to-left: extension bytes have MSB=1, tag byte has MSB=0
  let pos = right - 1;
  let extValue = 0;
  let shift = 1; // use multiplier for large-value safety

  // Read extension bytes (MSB=1) from right to left
  while (pos >= 0 && (data[pos]! & 0x80) !== 0) {
    extValue = extValue + (data[pos]! & 0x7F) * shift;
    shift *= 128;
    pos--;
  }

  if (pos < 0) throw new SyntaxError("tagVarintRead: no tag byte found");

  // Read tag byte (MSB=0)
  const tagByte = data[pos]!;
  const tag = tagByte & 0x0F;
  const tagBits = (tagByte >> 4) & 0x07;
  const value = tagBits + extValue * 8;

  return { tag, value, left: pos };
}

// ── Hexstring helpers ──

const hexChars = new Uint8Array(256);
for (let i = 0; i < 256; i++) hexChars[i] = 0xFF;
for (let i = 0; i < 10; i++) hexChars[0x30 + i] = i;       // '0'-'9'
for (let i = 0; i < 6; i++) hexChars[0x61 + i] = 10 + i;   // 'a'-'f'

const hexDigits = "0123456789abcdef";

/** Check if a string is all lowercase hex and long enough to benefit from hex encoding. */
export function isHexString(s: string): boolean {
  if (s.length < 4) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 127 || hexChars[c]! === 0xFF) return false;
  }
  return true;
}

/** Pack a hex string into bytes. 2 hex chars per byte, high nibble first.
 *  Odd length: leading byte has high nibble = 0. */
export function hexEncode(hex: string): Uint8Array {
  const byteLen = Math.ceil(hex.length / 2);
  const bytes = new Uint8Array(byteLen);
  const offset = hex.length % 2;
  for (let i = 0; i < hex.length; i++) {
    const nibble = hexChars[hex.charCodeAt(i)]!;
    const byteIdx = (i + offset) >> 1;
    if ((i + offset) % 2 === 0) bytes[byteIdx] = nibble << 4;
    else bytes[byteIdx]! |= nibble;
  }
  return bytes;
}

/** Unpack bytes back to a hex string of the given character count. */
export function hexDecode(data: Uint8Array, start: number, byteLen: number, charCount: number): string {
  let result = "";
  for (let i = 0; i < byteLen; i++) {
    const b = data[start + i]!;
    result += hexDigits[b >> 4];
    result += hexDigits[b & 0x0F];
  }
  // If odd charCount, the first char is padding
  return charCount % 2 === 0 ? result : result.slice(1);
}

// ── Base64 string helpers ──
// Alphabet: 0-9 a-z A-Z - _ (same as rx b64chars, URL-safe)
// Packs 4 chars into 3 bytes (6 bits per char)

const b64sChars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

// charCode → 6-bit value (0xFF = invalid)
const b64sDecodeTable = new Uint8Array(128).fill(0xFF);
for (let i = 0; i < 64; i++) b64sDecodeTable[b64sChars.charCodeAt(i)] = i;

/** Check if a string is all base64 chars and long enough to benefit. */
export function isB64String(s: string): boolean {
  if (s.length < 4) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 127 || b64sDecodeTable[c]! === 0xFF) return false;
  }
  return true;
}

/** Pack a base64 string into bytes (6 bits per char, MSB first).
 *  N chars → ceil(N*6/8) bytes. Trailing bits in last byte are zero-padded. */
export function b64sEncode(s: string): Uint8Array {
  const byteLen = Math.ceil(s.length * 6 / 8);
  const bytes = new Uint8Array(byteLen);
  let bitBuf = 0;
  let bitCount = 0;
  let byteIdx = 0;
  for (let i = 0; i < s.length; i++) {
    bitBuf = (bitBuf << 6) | b64sDecodeTable[s.charCodeAt(i)]!;
    bitCount += 6;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes[byteIdx++] = (bitBuf >> bitCount) & 0xFF;
    }
  }
  // Flush remaining bits (zero-padded on the right)
  if (bitCount > 0) {
    bytes[byteIdx] = (bitBuf << (8 - bitCount)) & 0xFF;
  }
  return bytes;
}

/** Unpack bytes back to a base64 string of the given character count. */
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

// ── TextEncoder/Decoder ──

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

/** Scan left from c.right to find the tag+varint. Sets c.left. Returns the raw tag nibble. */
function peekTag(c: Cursor): number {
  const { tag, value, left } = tagVarintRead(c.data, c.right);
  c.left = left;
  (c as any)._rawVal = value;
  return tag;
}

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
      // External ref
      c.val = value - REF_EXTERNAL_BASE;
      return c.tag = "ref";
    }

    case TAG_MAP: {
      let content = left;
      c.left = left - value;
      // Parse optional schema (rightmost), then optional index
      if (content > c.left) {
        const { tag: innerTag, value: innerVal, left: innerLeft } = tagVarintRead(data, content);
        // Schema: ref or pointer to container
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
        // Index
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
      // Check for index
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
    // Expand to compare byte-by-byte against UTF-8 key
    // b64str chars are all ASCII, so string length == byte length
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
    // External ref — treat as opaque (can't compare bytes)
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

// ── Encoder ──

export interface EncodeOptions {
  onChunk?: (chunk: Uint8Array, offset: number) => void;
  refs?: Refs;
  indexThreshold?: number;
  stringChainThreshold?: number;
  stringChainDelimiter?: string;
  dedupComplexityLimit?: number;
  chunkSize?: number;
}

const ENCODE_DEFAULTS = {
  refs: {},
} as const satisfies Partial<EncodeOptions>;

// Compare entry pairs by key in UTF-8 byte order
function utf8SortEntries(a: [string, unknown], b: [string, unknown]): number {
  return utf8Sort(a[0], b[0]);
}

function entryValue(e: [string, unknown]): unknown {
  return e[1];
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
    // Try chain splitting for long strings with delimiters
    if (knownPrefixes && value.length > chainThreshold && value.indexOf(chainDelimiter, 1) > 0) {
      let offset = value.length;
      while (offset > 0) {
        offset = value.lastIndexOf(chainDelimiter, offset - 1);
        if (offset <= 0) break;
        const prefix = value.slice(0, offset);
        if (knownPrefixes.has(prefix)) {
          const before = pos;
          writeAny(value.substring(offset));
          writeAny(prefix);
          return emitTagVarint(TAG_CHAIN, pos - before);
        }
      }
      offset = 0;
      while (offset < value.length) {
        const next = value.indexOf(chainDelimiter, offset + 1);
        if (next === -1) break;
        knownPrefixes.add(value.slice(0, next));
        offset = next;
      }
    }

    // Check if hex encoding is beneficial (50% savings)
    if (isHexString(value)) {
      const packed = hexEncode(value);
      ensureCapacity(packed.length + 16);
      buf.set(packed, off);
      pos += packed.length;
      off += packed.length;
      return emitTagVarint(TAG_HEXSTR, value.length);
    }

    // Check if b64 string encoding is beneficial (25% savings)
    if (isB64String(value)) {
      const packed = b64sEncode(value);
      ensureCapacity(packed.length + 16);
      buf.set(packed, off);
      pos += packed.length;
      off += packed.length;
      return emitTagVarint(TAG_B64STR, value.length);
    }

    // Regular string
    const len = value.length;
    // Fast path: ASCII
    let isASCII = true;
    if (len < 128) {
      for (let i = 0; i < len; i++) {
        if (value.charCodeAt(i) > 127) { isASCII = false; break; }
      }
    } else {
      isASCII = false;
    }

    if (isASCII) {
      ensureCapacity(len + 16);
      for (let i = 0; i < len; i++) {
        buf[off + i] = value.charCodeAt(i);
      }
      pos += len;
      off += len;
      return emitTagVarint(TAG_STRING, len);
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

  /** Write a big-endian unsigned integer of fixed byte width. */
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

    const schemaLeaf = schemaUpsert(keys);
    const schemaTarget = schemaLeaf[SCHEMA_OFFSET];
    if (schemaTarget !== undefined) return writeSchemaObject(value, schemaTarget);

    const before = pos;
    const offsets = length > indexThreshold ? ({} as Record<string, number>) : undefined;
    let lastOffset: number | undefined;
    const entries = Object.entries(value);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, val] = entries[i] as [string, unknown];
      writeAny(val);
      writeAny(key);
      if (offsets) {
        offsets[key] = pos;
        lastOffset = lastOffset ?? pos;
      }
    }

    if (offsets && lastOffset !== undefined) {
      const sortedOffsets = Object.entries(offsets)
        .sort(utf8SortEntries)
        .map(entryValue) as number[];
      writeIndex(sortedOffsets, length);
    }
    const ret = emitTagVarint(TAG_MAP, pos - before);
    schemaLeaf[SCHEMA_OFFSET] = pos;
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
