import { describe, it, expect } from "vitest";
import {
  encode,
  decode,
  open,
  read,
  readStr,
  makeCursor,
  tagVarintSize,
  tagVarintWrite,
  tagVarintRead,
  isHexString,
  hexEncode,
  hexDecode,
  findKey,
  seekChild,
  collectChildren,
  resolveStr,
  strCompare,
  strEquals,
  strHasPrefix,
  prepareKey,
  TAG_INT,
  TAG_STRING,
  TAG_HEXSTR,
  TAG_REF,
  TAG_LIST,
  TAG_MAP,
  TAG_POINTER,
  TAG_CHAIN,
  TAG_INDEX,
  TAG_DECIMAL,
  REF_NULL,
  REF_TRUE,
  REF_FALSE,
  REF_UNDEF,
  REF_INF,
  REF_NINF,
  REF_NAN,
} from "./rxb.ts";

import { encode as rxEncode, parse as rxParse } from "./rx.ts";

// ── Helper ──

function cur(value: unknown, options?: Parameters<typeof encode>[1]) {
  const buf = encode(value, options);
  const c = makeCursor(buf);
  read(c);
  return c;
}

function roundtrip(value: unknown, options?: Parameters<typeof encode>[1]) {
  const buf = encode(value, options);
  return decode(buf, options);
}

// ── Tag+Varint encoding ──

describe("tagVarint", () => {
  it("encodes tag with value 0 in 1 byte", () => {
    const buf = new Uint8Array(8);
    const n = tagVarintWrite(buf, 0, TAG_INT, 0);
    expect(n).toBe(1);
    expect(buf[0]).toBe(TAG_INT); // 0x00
    const { tag, value, left } = tagVarintRead(buf, 1);
    expect(tag).toBe(TAG_INT);
    expect(value).toBe(0);
    expect(left).toBe(0);
  });

  it("encodes tag with value 1-7 in 1 byte", () => {
    for (let v = 1; v <= 7; v++) {
      const buf = new Uint8Array(8);
      const n = tagVarintWrite(buf, 0, TAG_STRING, v);
      expect(n).toBe(1);
      const { tag, value } = tagVarintRead(buf, 1);
      expect(tag).toBe(TAG_STRING);
      expect(value).toBe(v);
    }
  });

  it("encodes tag with value 8 in 2 bytes", () => {
    const buf = new Uint8Array(8);
    const n = tagVarintWrite(buf, 0, TAG_STRING, 8);
    expect(n).toBe(2);
    const { tag, value, left } = tagVarintRead(buf, 2);
    expect(tag).toBe(TAG_STRING);
    expect(value).toBe(8);
    expect(left).toBe(0);
  });

  it("roundtrips various values", () => {
    const values = [0, 1, 7, 8, 63, 64, 127, 128, 255, 1023, 1024, 16383, 16384, 131071, 131072, 1000000];
    for (const tag of [TAG_INT, TAG_STRING, TAG_LIST, TAG_MAP]) {
      for (const v of values) {
        const buf = new Uint8Array(16);
        const n = tagVarintWrite(buf, 0, tag, v);
        expect(n).toBe(tagVarintSize(tag, v));
        const result = tagVarintRead(buf, n);
        expect(result.tag).toBe(tag);
        expect(result.value).toBe(v);
        expect(result.left).toBe(0);
      }
    }
  });

  it("tagVarintSize is correct", () => {
    expect(tagVarintSize(0, 0)).toBe(1);
    expect(tagVarintSize(0, 7)).toBe(1);
    expect(tagVarintSize(0, 8)).toBe(2);
    expect(tagVarintSize(0, 1023)).toBe(2);
    expect(tagVarintSize(0, 1024)).toBe(3);
    expect(tagVarintSize(0, 131071)).toBe(3);
    expect(tagVarintSize(0, 131072)).toBe(4);
  });
});

// ── Hexstring helpers ──

describe("hexstring helpers", () => {
  it("isHexString detects valid hex", () => {
    expect(isHexString("deadbeef")).toBe(true);
    expect(isHexString("0123456789abcdef")).toBe(true);
    expect(isHexString("abc")).toBe(false); // too short
    expect(isHexString("")).toBe(false);
    expect(isHexString("DEADBEEF")).toBe(false); // uppercase
    expect(isHexString("hello")).toBe(false);
    expect(isHexString("abcg")).toBe(false);
  });

  it("hexEncode/hexDecode roundtrip even length", () => {
    const hex = "deadbeef";
    const packed = hexEncode(hex);
    expect(packed.length).toBe(4);
    expect(packed[0]).toBe(0xDE);
    expect(packed[1]).toBe(0xAD);
    expect(packed[2]).toBe(0xBE);
    expect(packed[3]).toBe(0xEF);
    const decoded = hexDecode(packed, 0, packed.length, hex.length);
    expect(decoded).toBe(hex);
  });

  it("hexEncode/hexDecode roundtrip odd length", () => {
    const hex = "abcde";
    const packed = hexEncode(hex);
    expect(packed.length).toBe(3);
    const decoded = hexDecode(packed, 0, packed.length, hex.length);
    expect(decoded).toBe(hex);
  });
});

// ── Primitives ──

describe("primitives", () => {
  it("encodes integers", () => {
    expect(cur(0).tag).toBe("int");
    expect(cur(0).val).toBe(0);
    expect(cur(1).val).toBe(1);
    expect(cur(-1).val).toBe(-1);
    expect(cur(42).val).toBe(42);
    expect(cur(-42).val).toBe(-42);
    expect(cur(255).val).toBe(255);
    expect(cur(1000).val).toBe(1000);
    expect(cur(1000000).val).toBe(1000000);
  });

  it("encodes large integers", () => {
    expect(cur(Number.MAX_SAFE_INTEGER).val).toBe(Number.MAX_SAFE_INTEGER);
    // MIN_SAFE_INTEGER loses precision in zigzag (same as rx.ts) — test a large negative that works
    expect(cur(-4503599627370495).val).toBe(-4503599627370495);
  });

  it("encodes floats", () => {
    expect(cur(3.14).tag).toBe("float");
    expect(cur(3.14).val).toBeCloseTo(3.14);
    expect(cur(0.5).val).toBeCloseTo(0.5);
    expect(cur(-0.5).val).toBeCloseTo(-0.5);
    expect(cur(99.9).val).toBeCloseTo(99.9);
  });

  it("encodes special floats", () => {
    expect(cur(NaN).val).toBeNaN();
    expect(cur(Infinity).val).toBe(Infinity);
    expect(cur(-Infinity).val).toBe(-Infinity);
  });

  it("encodes booleans", () => {
    expect(cur(true).tag).toBe("true");
    expect(cur(false).tag).toBe("false");
  });

  it("encodes null", () => {
    expect(cur(null).tag).toBe("null");
  });

  it("encodes undefined", () => {
    expect(cur(undefined).tag).toBe("undef");
  });

  it("encodes strings", () => {
    const c = cur("hello");
    expect(c.tag).toBe("b64str"); // all b64 chars → b64str encoding
    expect(readStr(c)).toBe("hello");
    // non-b64 chars → regular string
    const c2 = cur("hello world"); // space is not b64
    expect(c2.tag).toBe("str");
    expect(readStr(c2)).toBe("hello world");
  });

  it("encodes empty string", () => {
    const c = cur("");
    expect(c.tag).toBe("str");
    expect(readStr(c)).toBe("");
  });

  it("encodes unicode strings", () => {
    expect(readStr(cur("café"))).toBe("café");
    expect(readStr(cur("🎉"))).toBe("🎉");
    expect(readStr(cur("🏴‍☠️"))).toBe("🏴‍☠️");
  });

  it("encodes hex strings as hexstr type", () => {
    const c = cur("deadbeef");
    expect(c.tag).toBe("hexstr");
    expect(readStr(c)).toBe("deadbeef");
  });

  it("encodes short hex strings as regular strings", () => {
    // "abc" is too short for hex encoding (< 4 chars)
    const c = cur("abc");
    expect(c.tag).toBe("str");
    expect(readStr(c)).toBe("abc");
  });

  it("hex strings save space", () => {
    const hex = "0123456789abcdef0123456789abcdef"; // 32 chars
    const rxbBuf = encode(hex);
    const rxBuf = rxEncode(hex);
    // rxb hex: 16 bytes body + 2 bytes tag+varint = ~18 bytes
    // rx text: 32 bytes body + 2 bytes tag+length = ~34 bytes
    expect(rxbBuf.length).toBeLessThan(rxBuf.length);
  });
});

// ── Roundtrip ──

describe("roundtrip", () => {
  it("roundtrips integers", () => {
    for (const v of [0, 1, -1, 42, -42, 255, 1000, -1000, Number.MAX_SAFE_INTEGER, -4503599627370495]) {
      expect(roundtrip(v)).toBe(v);
    }
  });

  it("roundtrips floats", () => {
    for (const v of [3.14, 0.5, -0.5, 99.9, 1e100, 1e-100]) {
      expect(roundtrip(v)).toBeCloseTo(v, 10);
    }
  });

  it("roundtrips special floats", () => {
    expect(roundtrip(NaN)).toBeNaN();
    expect(roundtrip(Infinity)).toBe(Infinity);
    expect(roundtrip(-Infinity)).toBe(-Infinity);
  });

  it("roundtrips strings", () => {
    for (const v of ["", "hello", "café", "🎉", "hello world this is a test"]) {
      expect(roundtrip(v)).toBe(v);
    }
  });

  it("roundtrips hex strings", () => {
    for (const v of ["deadbeef", "0123456789abcdef", "abcde"]) {
      expect(roundtrip(v)).toBe(v);
    }
  });

  it("roundtrips booleans", () => {
    expect(roundtrip(true)).toBe(true);
    expect(roundtrip(false)).toBe(false);
  });

  it("roundtrips null", () => {
    expect(roundtrip(null)).toBe(null);
  });

  it("roundtrips arrays", () => {
    expect(JSON.stringify(roundtrip([]))).toBe("[]");
    expect(JSON.stringify(roundtrip([1, 2, 3]))).toBe("[1,2,3]");
    expect(JSON.stringify(roundtrip(["a", "b", "c"]))).toBe('["a","b","c"]');
  });

  it("roundtrips objects", () => {
    expect(JSON.stringify(roundtrip({}))).toBe("{}");
    expect(JSON.stringify(roundtrip({ a: 1 }))).toBe('{"a":1}');
    expect(JSON.stringify(roundtrip({ a: 1, b: 2 }))).toBe('{"a":1,"b":2}');
  });

  it("roundtrips nested structures", () => {
    const data = {
      users: [
        { name: "alice", age: 30 },
        { name: "bob", age: 25 },
      ],
      version: 3,
    };
    expect(JSON.stringify(roundtrip(data))).toBe(JSON.stringify(data));
  });

  it("roundtrips deeply nested", () => {
    const data = { a: { b: { c: { d: [1, [2, [3]]] } } } };
    expect(JSON.stringify(roundtrip(data))).toBe(JSON.stringify(data));
  });
});

// ── Containers ──

describe("containers", () => {
  it("arrays have correct tag and children", () => {
    const c = cur([1, 2, 3]);
    expect(c.tag).toBe("array");
  });

  it("objects have correct tag", () => {
    const c = cur({ a: 1, b: 2 });
    expect(c.tag).toBe("object");
  });

  it("indexed arrays support seekChild", () => {
    const buf = encode([10, 20, 30, 40, 50], { indexThreshold: 0 });
    const c = makeCursor(buf);
    read(c);
    expect(c.tag).toBe("array");
    expect(c.ixCount).toBe(5);

    const child = makeCursor(buf);
    seekChild(child, c, 0);
    expect(child.val).toBe(10);
    seekChild(child, c, 2);
    expect(child.val).toBe(30);
    seekChild(child, c, 4);
    expect(child.val).toBe(50);
  });

  it("indexed objects support findKey", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 20; i++) obj[`key${String(i).padStart(2, "0")}`] = i;
    const buf = encode(obj, { indexThreshold: 0 });
    const c = makeCursor(buf);
    read(c);
    expect(c.tag).toBe("object");
    expect(c.ixCount).toBe(20);

    const result = makeCursor(buf);
    expect(findKey(result, c, "key00")).toBe(true);
    expect(result.val).toBe(0);
    expect(findKey(result, c, "key19")).toBe(true);
    expect(result.val).toBe(19);
    expect(findKey(result, c, "key10")).toBe(true);
    expect(result.val).toBe(10);
    expect(findKey(result, c, "missing")).toBe(false);
  });

  it("collectChildren returns correct count", () => {
    const buf = encode([1, 2, 3]);
    const c = makeCursor(buf);
    read(c);
    const offsets: number[] = [];
    const count = collectChildren(c, offsets);
    expect(count).toBe(3);
  });
});

// ── Dedup (pointers) ──

describe("dedup", () => {
  it("deduplicates repeated strings", () => {
    const data = ["hello world!!", "hello world!!", "hello world!!"];
    const buf = encode(data);
    // Should be smaller than encoding 3 copies
    const noDedupBuf = encode(data, { dedupComplexityLimit: 0 });
    // With dedup, repeated strings become pointers
    expect(buf.length).toBeLessThanOrEqual(noDedupBuf.length);
  });

  it("deduplicates repeated objects", () => {
    const obj = { x: 1, y: 2, z: 3 };
    const data = [obj, obj, obj];
    const buf = encode(data);
    const decoded = decode(buf) as any[];
    expect(JSON.stringify(decoded[0])).toBe(JSON.stringify(obj));
    expect(JSON.stringify(decoded[1])).toBe(JSON.stringify(obj));
    expect(JSON.stringify(decoded[2])).toBe(JSON.stringify(obj));
  });
});

// ── String chains ──

describe("chains", () => {
  it("splits long strings with shared prefixes", () => {
    const data = [
      "/docs/getting-started/installation",
      "/docs/getting-started/quickstart",
      "/docs/encoding/overview",
    ];
    const buf = encode(data, { stringChainThreshold: 4 });
    const decoded = decode(buf) as string[];
    expect(decoded[0]).toBe(data[0]);
    expect(decoded[1]).toBe(data[1]);
    expect(decoded[2]).toBe(data[2]);
  });
});

// ── Schema objects ──

describe("schema", () => {
  it("shares keys across repeated object shapes", () => {
    const data = [
      { name: "alice", age: 30, city: "NYC" },
      { name: "bob", age: 25, city: "LA" },
      { name: "carol", age: 35, city: "SF" },
    ];
    const buf = encode(data);
    const decoded = decode(buf) as any[];
    expect(decoded[0]!.name).toBe("alice");
    expect(decoded[1]!.name).toBe("bob");
    expect(decoded[2]!.name).toBe("carol");
    expect(decoded[0]!.age).toBe(30);
    expect(decoded[1]!.age).toBe(25);
  });
});

// ── Proxy API ──

describe("proxy API", () => {
  it("array indexing", () => {
    const arr = open(encode([10, 20, 30])) as number[];
    expect(arr[0]).toBe(10);
    expect(arr[1]).toBe(20);
    expect(arr[2]).toBe(30);
    expect(arr.length).toBe(3);
  });

  it("object property access", () => {
    const obj = open(encode({ x: 1, y: "hello" })) as any;
    expect(obj.x).toBe(1);
    expect(obj.y).toBe("hello");
  });

  it("nested access", () => {
    const data = { users: [{ name: "alice" }, { name: "bob" }] };
    const obj = open(encode(data)) as any;
    expect(obj.users[0].name).toBe("alice");
    expect(obj.users[1].name).toBe("bob");
  });

  it("Object.keys works", () => {
    const obj = open(encode({ a: 1, b: 2, c: 3 })) as any;
    expect(Object.keys(obj)).toEqual(["a", "b", "c"]);
  });

  it("JSON.stringify works", () => {
    const data = { a: 1, b: [2, 3] };
    const obj = open(encode(data)) as any;
    expect(JSON.stringify(obj)).toBe(JSON.stringify(data));
  });

  it("for...of on arrays", () => {
    const arr = open(encode([1, 2, 3])) as number[];
    const result: number[] = [];
    for (const item of arr) result.push(item);
    expect(result).toEqual([1, 2, 3]);
  });

  it("spread on arrays", () => {
    const arr = open(encode([1, 2, 3])) as number[];
    expect([...arr]).toEqual([1, 2, 3]);
  });

  it("array methods", () => {
    const arr = open(encode([1, 2, 3])) as number[];
    expect(arr.map(x => x * 2)).toEqual([2, 4, 6]);
    expect(arr.filter(x => x > 1)).toEqual([2, 3]);
  });

  it("hex strings read correctly through proxy", () => {
    const data = { hash: "deadbeef01234567" };
    const obj = open(encode(data)) as any;
    expect(obj.hash).toBe("deadbeef01234567");
  });
});

// ── String operations ──

describe("string operations", () => {
  it("strCompare works on regular strings", () => {
    const buf = encode("hello");
    const c = makeCursor(buf);
    read(c);
    expect(strCompare(c, prepareKey("hello"))).toBe(0);
    expect(strCompare(c, prepareKey("hell"))).toBeGreaterThan(0);
    expect(strCompare(c, prepareKey("helloz"))).toBeLessThan(0);
  });

  it("strEquals works", () => {
    const buf = encode("test");
    const c = makeCursor(buf);
    read(c);
    expect(strEquals(c, prepareKey("test"))).toBe(true);
    expect(strEquals(c, prepareKey("other"))).toBe(false);
  });

  it("strHasPrefix works", () => {
    const buf = encode("hello world");
    const c = makeCursor(buf);
    read(c);
    expect(strHasPrefix(c, prepareKey("hello"))).toBe(true);
    expect(strHasPrefix(c, prepareKey("world"))).toBe(false);
    expect(strHasPrefix(c, prepareKey(""))).toBe(true);
  });
});

// ── Cross-format verification ──

describe("cross-format", () => {
  it("rxb is smaller than rx for hex-heavy data", () => {
    const data = {
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      md5: "d41d8cd98f00b204e9800998ecf8427e",
    };
    const rxBuf = rxEncode(data);
    const rxbBuf = encode(data);
    expect(rxbBuf.length).toBeLessThan(rxBuf.length);
  });

  it("rxb produces same values as rx for common data", () => {
    const data = {
      name: "test",
      version: 42,
      items: [1, 2, 3],
      nested: { a: true, b: null, c: "hello" },
    };
    const rxVal = JSON.stringify(rxParse(new TextDecoder().decode(rxEncode(data))));
    const rxbVal = JSON.stringify(decode(encode(data)));
    expect(rxbVal).toBe(rxVal);
  });

  it("rxb is generally smaller than rx", () => {
    const data = {
      users: Array.from({ length: 5 }, (_, i) => ({
        id: i,
        name: `user${i}`,
        email: `user${i}@example.com`,
        active: i % 2 === 0,
      })),
    };
    const rxBuf = rxEncode(data);
    const rxbBuf = encode(data);
    // Binary format should be at least as compact
    expect(rxbBuf.length).toBeLessThanOrEqual(rxBuf.length);
  });
});

// ── Hexstring specific ──

describe("hexstring encoding", () => {
  it("UUID-like hex", () => {
    const uuid = "550e8400e29b41d4a716446655440000";
    expect(roundtrip(uuid)).toBe(uuid);
    const c = cur(uuid);
    expect(c.tag).toBe("hexstr");
    // 32 hex chars → 16 packed bytes + tag+varint
    const buf = encode(uuid);
    expect(buf.length).toBeLessThan(uuid.length); // much less than 32
  });

  it("SHA-256 hash", () => {
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(roundtrip(sha)).toBe(sha);
    const buf = encode(sha);
    // 64 hex chars → 32 packed bytes + tag+varint ≈ 34 bytes
    expect(buf.length).toBeLessThan(40);
  });

  it("odd-length hex", () => {
    const hex = "abcde";
    expect(roundtrip(hex)).toBe(hex);
  });

  it("all zeros", () => {
    const hex = "0000000000000000";
    expect(roundtrip(hex)).toBe(hex);
  });

  it("all f's", () => {
    const hex = "ffffffffffffffff";
    expect(roundtrip(hex)).toBe(hex);
  });
});

// ── Base64 string specific ──

describe("b64str encoding", () => {
  it("encodes b64-safe strings as b64str", () => {
    const c = cur("hello-world_123");
    expect(c.tag).toBe("b64str");
    expect(readStr(c)).toBe("hello-world_123");
  });

  it("saves space vs regular string", () => {
    const s = "abcdefghijklmnopqrstuvwxyz012345"; // 32 chars
    const buf = encode(s);
    // b64str: ceil(32*6/8)=24 bytes body + 2 bytes tag+varint = ~26 bytes
    // regular: 32 bytes body + 2 bytes tag+varint = ~34 bytes
    expect(buf.length).toBeLessThan(30);
  });

  it("roundtrips b64 strings", () => {
    for (const v of ["abcd", "Hello-World_42", "0123456789abcdefghijklmnopqrstuvwxyz", "a-b_c"]) {
      expect(roundtrip(v)).toBe(v);
    }
  });

  it("short b64 strings stay as regular strings", () => {
    const c = cur("abc"); // only 3 chars, below threshold
    expect(c.tag).toBe("str");
  });

  it("strings with spaces are not b64str", () => {
    const c = cur("hello world");
    expect(c.tag).toBe("str");
  });

  it("hex strings still use hexstr (more compact)", () => {
    const c = cur("deadbeef");
    expect(c.tag).toBe("hexstr"); // hex is subset of b64 but more compact
  });
});

// ── External refs ──

describe("external refs", () => {
  it("encodes and decodes with refs", () => {
    const refs = { myType: [1, 2, 3] };
    const data = { items: [1, 2, 3], other: "hello" };
    const buf = encode(data, { refs });
    const decoded = decode(buf, { refs }) as any;
    expect(JSON.stringify(decoded.items)).toBe(JSON.stringify([1, 2, 3]));
    expect(decoded.other).toBe("hello");
  });
});

// ── Edge cases ──

describe("edge cases", () => {
  it("empty array", () => {
    expect(JSON.stringify(roundtrip([]))).toBe("[]");
  });

  it("empty object", () => {
    expect(JSON.stringify(roundtrip({}))).toBe("{}");
  });

  it("single-element array", () => {
    expect(JSON.stringify(roundtrip([42]))).toBe("[42]");
  });

  it("nested empty", () => {
    expect(JSON.stringify(roundtrip({ a: [], b: {} }))).toBe('{"a":[],"b":{}}');
  });

  it("mixed types in array", () => {
    const data = [1, "hello", true, null, 3.14, [1], { a: 1 }];
    expect(JSON.stringify(roundtrip(data))).toBe(JSON.stringify(data));
  });

  it("string with special characters", () => {
    expect(roundtrip("hello\nworld")).toBe("hello\nworld");
    expect(roundtrip("tab\there")).toBe("tab\there");
    expect(roundtrip("null\0byte")).toBe("null\0byte");
  });

  it("large array with index", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const decoded = roundtrip(arr, { indexThreshold: 0 }) as number[];
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(arr));
  });

  it("large object with index", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 50; i++) obj[`k${i}`] = i;
    const decoded = roundtrip(obj, { indexThreshold: 0 }) as any;
    for (let i = 0; i < 50; i++) {
      expect(decoded[`k${i}`]).toBe(i);
    }
  });
});
