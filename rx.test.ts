import { describe, expect, test } from "vitest";
import {
	encode,
	stringify,
	parse,
	makeCursor,
	read,
	readStr,
	resolveStr,
	strEquals,
	strCompare,
	findKey,
	seekChild,
	collectChildren,
	rawBytes,
	open,
	handle,
	prepareKey,
	strHasPrefix,
	findByPrefix,
	inspect,
	type ASTNode,
} from "./rx";

function cur(value: unknown, opts?: Parameters<typeof encode>[1]) {
	const data = encode(value, opts);
	const c = makeCursor(data);
	read(c);
	return c;
}

describe("read() primitives", () => {
	test("integers", () => {
		let c = cur(0);
		expect(c.tag).toBe("int");
		expect(c.val).toBe(0);

		c = cur(42);
		expect(c.tag).toBe("int");
		expect(c.val).toBe(42);

		c = cur(-42);
		expect(c.tag).toBe("int");
		expect(c.val).toBe(-42);
	});

	test("floats", () => {
		let c = cur(3.14);
		expect(c.tag).toBe("float");
		expect(c.val).toBe(3.14);

		c = cur(0.5);
		expect(c.tag).toBe("float");
		expect(c.val).toBe(0.5);
	});

	test("special floats", () => {
		let c = cur(Infinity);
		expect(c.tag).toBe("float");
		expect(c.val).toBe(Infinity);

		c = cur(-Infinity);
		expect(c.tag).toBe("float");
		expect(c.val).toBe(-Infinity);

		c = cur(NaN);
		expect(c.tag).toBe("float");
		expect(c.val).toBeNaN();
	});

	test("strings", () => {
		let c = cur("");
		expect(c.tag).toBe("str");
		expect(c.val).toBe(0);
		expect(readStr(c)).toBe("");

		c = cur("hello");
		expect(c.tag).toBe("str");
		expect(c.val).toBe(5);
		expect(readStr(c)).toBe("hello");

		c = cur("hello world");
		expect(c.tag).toBe("str");
		expect(readStr(c)).toBe("hello world");
	});

	test("unicode strings", () => {
		const c = cur("🚀");
		expect(c.tag).toBe("str");
		expect(readStr(c)).toBe("🚀");
	});

	test("booleans, null, undefined", () => {
		expect(cur(true).tag).toBe("true");
		expect(cur(false).tag).toBe("false");
		expect(cur(null).tag).toBe("null");
		expect(cur(undefined).tag).toBe("undef");
	});
});

describe("read() containers", () => {
	test("empty array", () => {
		const c = cur([]);
		expect(c.tag).toBe("array");
		expect(c.val).toBe(c.left); // no content
	});

	test("simple array", () => {
		const c = cur([1, 2, 3]);
		expect(c.tag).toBe("array");
		// Iterate children
		const vals: number[] = [];
		let right = c.val;
		const tmp = makeCursor(c.data);
		while (right > c.left) {
			tmp.right = right;
			read(tmp);
			expect(tmp.tag).toBe("int");
			vals.push(tmp.val);
			right = tmp.left;
		}
		expect(vals).toEqual([1, 2, 3]);
	});

	test("simple object", () => {
		const c = cur({ color: "red", size: 42 });
		expect(c.tag).toBe("object");
		// Iterate key/value pairs
		const k = makeCursor(c.data);
		const v = makeCursor(c.data);
		const entries: [string, unknown][] = [];
		let right = c.val;
		while (right > c.left) {
			k.right = right;
			read(k);
			v.right = k.left;
			read(v);
			entries.push([readStr(k), v.tag === "str" ? readStr(v) : v.val]);
			right = v.left;
		}
		expect(entries).toContainEqual(["color", "red"]);
		expect(entries).toContainEqual(["size", 42]);
	});

	test("empty object", () => {
		const c = cur({});
		expect(c.tag).toBe("object");
		expect(c.val).toBe(c.left);
	});
});

describe("read() indexed containers", () => {
	test("indexed array has ixWidth and ixCount", () => {
		const c = cur([1, 2, 3], { indexThreshold: 0 });
		expect(c.tag).toBe("array");
		expect(c.ixWidth).toBeGreaterThan(0);
		expect(c.ixCount).toBe(3);
	});

	test("indexed object has ixWidth and ixCount", () => {
		const c = cur({ a: 1, b: 2, c: 3 }, { indexThreshold: 0 });
		expect(c.tag).toBe("object");
		expect(c.ixWidth).toBeGreaterThan(0);
		expect(c.ixCount).toBe(3);
	});
});

describe("read() pointers", () => {
	test("pointer to string", () => {
		// hello,5^;8
		// Encoding writes last element first: "hello" at [0,7), then "^" pointer at [7,8)
		// Natural read order (right-to-left) sees pointer first, then string
		const c = cur(["hello", "hello"]);
		expect(c.tag).toBe("array");

		const tmp = makeCursor(c.data);
		// First child in read order: the pointer
		tmp.right = c.val;
		read(tmp);
		expect(tmp.tag).toBe("ptr");
		const secondChildRight = tmp.left; // save before resolving

		// Resolve pointer — should give us the string
		tmp.right = tmp.val;
		read(tmp);
		expect(tmp.tag).toBe("str");
		expect(readStr(tmp)).toBe("hello");

		// Second child in read order: the actual string
		tmp.right = secondChildRight;
		read(tmp);
		expect(tmp.tag).toBe("str");
		expect(readStr(tmp)).toBe("hello");
	});
});

describe("read() chains", () => {
	test("chain node has correct boundaries", () => {
		const c = cur(["/foo/bar/baz", "/foo/bar/qux", "/foo/quux"]);
		expect(c.tag).toBe("array");
		// Just verify we can iterate without crashing
		const tmp = makeCursor(c.data);
		let right = c.val;
		let count = 0;
		while (right > c.left) {
			tmp.right = right;
			read(tmp);
			right = tmp.left;
			count++;
		}
		expect(count).toBe(3);
	});
});

const p = prepareKey;

describe("strEquals", () => {
	test("matches ASCII strings", () => {
		const c = cur("hello");
		expect(strEquals(c, p("hello"))).toBe(true);
		expect(strEquals(c, p("world"))).toBe(false);
		expect(strEquals(c, p("hell"))).toBe(false);
		expect(strEquals(c, p("helloo"))).toBe(false);
	});

	test("matches unicode strings", () => {
		const c = cur("🚀");
		expect(strEquals(c, p("🚀"))).toBe(true);
		expect(strEquals(c, p("🔥"))).toBe(false);
	});

	test("matches empty string", () => {
		const c = cur("");
		expect(strEquals(c, p(""))).toBe(true);
		expect(strEquals(c, p("a"))).toBe(false);
	});
});

describe("strCompare", () => {
	test("ordering", () => {
		const a = cur("apple");
		const b = cur("banana");
		expect(strCompare(a, p("apple"))).toBe(0);
		expect(strCompare(a, p("banana"))).toBeLessThan(0);
		expect(strCompare(b, p("apple"))).toBeGreaterThan(0);
	});
});

describe("seekChild", () => {
	test("random access indexed array", () => {
		const arr = [10, 20, 30, 40, 50];
		const c = cur(arr, { indexThreshold: 0 });
		expect(c.ixCount).toBe(5);
		const child = makeCursor(c.data);
		for (let i = 0; i < arr.length; i++) {
			seekChild(child, c, i);
			expect(child.tag).toBe("int");
			expect(child.val).toBe(arr[i]);
		}
	});
});

describe("collectChildren", () => {
	test("collects child boundaries", () => {
		const c = cur([1, 2, 3]);
		const offsets: number[] = [];
		const count = collectChildren(c, offsets);
		expect(count).toBe(3);
		// Verify we can read each child
		const tmp = makeCursor(c.data);
		const vals: number[] = [];
		for (let i = 0; i < count; i++) {
			tmp.right = offsets[i]!;
			read(tmp);
			vals.push(tmp.val);
		}
		expect(vals).toEqual([1, 2, 3]);
	});
});

describe("findKey", () => {
	test("finds existing key", () => {
		const c = cur({ color: "red", size: 42 });
		const v = makeCursor(c.data);
		expect(findKey(v, c, "color")).toBe(true);
		expect(v.tag).toBe("str");
		expect(readStr(v)).toBe("red");

		expect(findKey(v, c, "size")).toBe(true);
		expect(v.tag).toBe("int");
		expect(v.val).toBe(42);
	});

	test("returns false for missing key", () => {
		const c = cur({ a: 1 });
		const v = makeCursor(c.data);
		expect(findKey(v, c, "z")).toBe(false);
	});

	test("finds key that is a chain (path with shared prefix)", () => {
		// Keys like "/foo/bar" and "/foo/baz" share prefix "/foo" → chain encoding
		const obj = { "/foo/bar": 1, "/foo/baz": 2 };
		const c = cur(obj);
		const v = makeCursor(c.data);
		expect(findKey(v, c, "/foo/bar")).toBe(true);
		expect(v.tag).toBe("int");
		expect(v.val).toBe(1);

		expect(findKey(v, c, "/foo/baz")).toBe(true);
		expect(v.tag).toBe("int");
		expect(v.val).toBe(2);

		expect(findKey(v, c, "/foo/qux")).toBe(false);
	});
});

describe("rawBytes", () => {
	test("extracts node bytes", () => {
		const c = cur(42);
		const bytes = rawBytes(c);
		expect(new TextDecoder().decode(bytes)).toBe("+1k");
	});
});

describe("resolveStr", () => {
	test("plain string", () => {
		const c = cur("hello");
		expect(resolveStr(c)).toBe("hello");
	});

	test("pointer to string", () => {
		// Create data with a pointer: ["hello", "hello"] → second is a ptr
		const c = cur(["hello", "hello"]);
		const tmp = makeCursor(c.data);
		// First child in read order is the pointer
		tmp.right = c.val;
		read(tmp);
		expect(tmp.tag).toBe("ptr");
		expect(resolveStr(tmp)).toBe("hello");
	});

	test("chain string", () => {
		// Paths with shared prefixes produce chains
		const arr = ["/foo/bar/baz", "/foo/bar/qux"];
		const c = cur(arr);
		const tmp = makeCursor(c.data);
		// Iterate children and resolve each
		const results: string[] = [];
		let right = c.val;
		while (right > c.left) {
			tmp.right = right;
			read(tmp);
			results.push(resolveStr(tmp));
			right = tmp.left;
		}
		expect(results).toEqual(["/foo/bar/baz", "/foo/bar/qux"]);
	});

	test("throws on non-string node", () => {
		const c = cur(42);
		expect(() => resolveStr(c)).toThrow();
	});
});

describe("read() floats extended", () => {
	test("negative exponent (small decimal)", () => {
		const c = cur(0.001);
		expect(c.tag).toBe("float");
		expect(c.val).toBe(0.001);
	});

	test("large float", () => {
		const c = cur(1.23e15);
		expect(c.tag).toBe("float");
		expect(c.val).toBe(1.23e15);
	});

	test("small float", () => {
		const c = cur(1.5e-10);
		expect(c.tag).toBe("float");
		expect(c.val).toBe(1.5e-10);
	});

	test("negative float", () => {
		const c = cur(-3.14);
		expect(c.tag).toBe("float");
		expect(c.val).toBe(-3.14);
	});

	test("negative float with exponent", () => {
		const c = cur(-2.5e8);
		expect(c.tag).toBe("float");
		expect(c.val).toBe(-2.5e8);
	});
});

describe("read() large integers", () => {
	test("large positive without trailing zeroes", () => {
		const c = cur(123457);
		expect(c.tag).toBe("int");
		expect(c.val).toBe(123457);
	});

	test("large negative without trailing zeroes", () => {
		const c = cur(-999997);
		expect(c.tag).toBe("int");
		expect(c.val).toBe(-999997);
	});

	test("trailing zeroes encode as float with exponent", () => {
		// 1000000 = 1e6, encoder uses exponent form
		const c = cur(1000000);
		expect(c.tag).toBe("float");
		expect(c.val).toBe(1000000);
	});
});

describe("nested containers", () => {
	test("nested arrays", () => {
		const c = cur([[1, 2], [3, 4]]);
		expect(c.tag).toBe("array");
		const tmp = makeCursor(c.data);
		const inner = makeCursor(c.data);
		const results: number[][] = [];
		let right = c.val;
		while (right > c.left) {
			tmp.right = right;
			read(tmp);
			expect(tmp.tag).toBe("array");
			const vals: number[] = [];
			let innerRight = tmp.val;
			while (innerRight > tmp.left) {
				inner.right = innerRight;
				read(inner);
				vals.push(inner.val);
				innerRight = inner.left;
			}
			results.push(vals);
			right = tmp.left;
		}
		expect(results).toEqual([[1, 2], [3, 4]]);
	});

	test("nested objects", () => {
		const c = cur({ a: { b: 1 } });
		expect(c.tag).toBe("object");
		const v = makeCursor(c.data);
		expect(findKey(v, c, "a")).toBe(true);
		expect(v.tag).toBe("object");
		const inner = makeCursor(v.data);
		expect(findKey(inner, v, "b")).toBe(true);
		expect(inner.tag).toBe("int");
		expect(inner.val).toBe(1);
	});

	test("object containing array", () => {
		const c = cur({ items: [10, 20, 30] });
		const v = makeCursor(c.data);
		expect(findKey(v, c, "items")).toBe(true);
		expect(v.tag).toBe("array");
		const child = makeCursor(v.data);
		const vals: number[] = [];
		let right = v.val;
		while (right > v.left) {
			child.right = right;
			read(child);
			vals.push(child.val);
			right = child.left;
		}
		expect(vals).toEqual([10, 20, 30]);
	});

	test("array of objects", () => {
		const c = cur([{ x: 1 }, { x: 2 }]);
		expect(c.tag).toBe("array");
		const tmp = makeCursor(c.data);
		const v = makeCursor(c.data);
		const results: number[] = [];
		let right = c.val;
		while (right > c.left) {
			tmp.right = right;
			read(tmp);
			expect(tmp.tag).toBe("object");
			expect(findKey(v, tmp, "x")).toBe(true);
			results.push(v.val);
			right = tmp.left;
		}
		expect(results).toEqual([1, 2]);
	});
});

describe("seekChild on indexed objects", () => {
	test("random access indexed object entries", () => {
		const obj = { a: 10, b: 20, c: 30 };
		const c = cur(obj, { indexThreshold: 0 });
		expect(c.tag).toBe("object");
		expect(c.ixCount).toBe(3);
		// Each entry is a key/value pair — seekChild gives the key node
		const child = makeCursor(c.data);
		const keys: string[] = [];
		for (let i = 0; i < c.ixCount; i++) {
			seekChild(child, c, i);
			// In indexed objects, each index entry points to a key
			keys.push(readStr(child));
		}
		expect(keys.length).toBe(3);
		// Indexed objects are sorted by UTF-8 key order
		expect(keys).toEqual(["a", "b", "c"]);
	});
});

describe("collectChildren on objects", () => {
	test("collects key/value boundaries", () => {
		const c = cur({ x: 1, y: 2 });
		const offsets: number[] = [];
		const count = collectChildren(c, offsets);
		// Objects without schema: children are interleaved key, value, key, value
		expect(count).toBe(4);
		const tmp = makeCursor(c.data);
		const tags: string[] = [];
		for (let i = 0; i < count; i++) {
			tmp.right = offsets[i]!;
			read(tmp);
			tags.push(tmp.tag);
		}
		// Alternating: str (key), int (value), str (key), int (value)
		expect(tags.filter(t => t === "str").length).toBe(2);
		expect(tags.filter(t => t === "int").length).toBe(2);
	});
});

describe("findKey with schema objects", () => {
	test("finds key in schema object (repeated shape)", () => {
		// Three objects with same keys. The encoder writes last-to-first,
		// so carol (index 2) is encoded first with inline keys.
		// alice and bob get schema pointers referencing carol's key layout.
		// Read order = logical order: alice, bob, carol.
		const data = [
			{ name: "alice", age: 30 },
			{ name: "bob", age: 25 },
			{ name: "carol", age: 20 },
		];
		const c = cur(data);
		expect(c.tag).toBe("array");
		const tmp = makeCursor(c.data);
		const v = makeCursor(c.data);

		// alice (first in read order) has a schema — last encoded, references carol's keys
		tmp.right = c.val;
		read(tmp);
		expect(tmp.tag).toBe("object");
		expect(tmp.schema).not.toBe(0);

		// findKey should work on schema objects
		expect(findKey(v, tmp, "name")).toBe(true);
		expect(v.tag).toBe("str");
		expect(readStr(v)).toBe("alice");

		expect(findKey(v, tmp, "age")).toBe(true);
		expect(v.tag).toBe("int");
		expect(v.val).toBe(30);

		expect(findKey(v, tmp, "missing")).toBe(false);

		// bob (second in read order) also has a schema
		tmp.right = tmp.left;
		read(tmp);
		expect(tmp.tag).toBe("object");
		expect(tmp.schema).not.toBe(0);

		expect(findKey(v, tmp, "name")).toBe(true);
		expect(readStr(v)).toBe("bob");

		expect(findKey(v, tmp, "age")).toBe(true);
		expect(v.val).toBe(25);

		// carol (third in read order) has inline keys, no schema
		tmp.right = tmp.left;
		read(tmp);
		expect(tmp.tag).toBe("object");
		expect(tmp.schema).toBe(0);

		expect(findKey(v, tmp, "name")).toBe(true);
		expect(readStr(v)).toBe("carol");

		expect(findKey(v, tmp, "age")).toBe(true);
		expect(v.val).toBe(20);
	});
});

describe("findKey with pointer keys", () => {
	test("finds key that is a pointer (deduplicated key string)", () => {
		// When the same key string appears in multiple objects, the encoder
		// deduplicates it with a pointer. Use enough objects to trigger this.
		const data = [
			{ name: "alice" },
			{ name: "bob" },
			{ name: "carol" },
		];
		const c = cur(data);
		const tmp = makeCursor(c.data);
		const v = makeCursor(c.data);

		// Iterate all objects and findKey "name" in each
		let right = c.val;
		const names: string[] = [];
		while (right > c.left) {
			tmp.right = right;
			read(tmp);
			expect(tmp.tag).toBe("object");
			expect(findKey(v, tmp, "name")).toBe(true);
			expect(v.tag).toBe("str");
			names.push(readStr(v));
			right = tmp.left;
		}
		expect(names).toEqual(["alice", "bob", "carol"]);
	});
});

describe("strEquals with multi-byte UTF-8", () => {
	test("2-byte UTF-8 (accented characters)", () => {
		const c = cur("café");
		expect(strEquals(c, p("café"))).toBe(true);
		expect(strEquals(c, p("cafe"))).toBe(false);
		expect(strEquals(c, p("caféé"))).toBe(false);
	});

	test("3-byte UTF-8 (CJK characters)", () => {
		const c = cur("日本語");
		expect(strEquals(c, p("日本語"))).toBe(true);
		expect(strEquals(c, p("日本"))).toBe(false);
		expect(strEquals(c, p("中文"))).toBe(false);
	});

	test("mixed ASCII and multi-byte", () => {
		const c = cur("hello 世界 🌍");
		expect(strEquals(c, p("hello 世界 🌍"))).toBe(true);
		expect(strEquals(c, p("hello 世界"))).toBe(false);
	});
});

describe("error paths", () => {
	test("seekChild throws on non-indexed container", () => {
		const c = cur([1, 2, 3]); // no indexes option
		const child = makeCursor(c.data);
		expect(() => seekChild(child, c, 0)).toThrow("indexed");
	});

	test("seekChild throws on out-of-range index", () => {
		const c = cur([1, 2, 3], { indexThreshold: 0 });
		const child = makeCursor(c.data);
		expect(() => seekChild(child, c, -1)).toThrow();
		expect(() => seekChild(child, c, 3)).toThrow();
	});

	test("findKey returns false on non-object", () => {
		const c = cur([1, 2, 3]);
		const v = makeCursor(c.data);
		expect(findKey(v, c, "key")).toBe(false);
	});
});

// ── open() Proxy API ──

function opened(value: unknown, opts?: Parameters<typeof encode>[1]) {
	return open(encode(value, opts));
}

describe("open() primitives", () => {
	test("integers", () => {
		expect(opened(0)).toBe(0);
		expect(opened(42)).toBe(42);
		expect(opened(-7)).toBe(-7);
	});

	test("floats", () => {
		expect(opened(3.14)).toBe(3.14);
		expect(opened(Infinity)).toBe(Infinity);
		expect(opened(-Infinity)).toBe(-Infinity);
		expect(opened(NaN)).toBeNaN();
	});

	test("strings", () => {
		expect(opened("")).toBe("");
		expect(opened("hello")).toBe("hello");
		expect(opened("🚀")).toBe("🚀");
	});

	test("booleans, null, undefined", () => {
		expect(opened(true)).toBe(true);
		expect(opened(false)).toBe(false);
		expect(opened(null)).toBe(null);
		expect(opened(undefined)).toBe(undefined);
	});
});

describe("open() arrays", () => {
	test("Array.isArray", () => {
		expect(Array.isArray(opened([]))).toBe(true);
		expect(Array.isArray(opened([1, 2]))).toBe(true);
	});

	test("length", () => {
		const arr = opened([10, 20, 30]) as unknown[];
		expect(arr.length).toBe(3);
	});

	test("index access", () => {
		const arr = opened([10, 20, 30]) as unknown[];
		expect(arr[0]).toBe(10);
		expect(arr[1]).toBe(20);
		expect(arr[2]).toBe(30);
		expect(arr[3]).toBe(undefined);
	});

	test("for...of iteration", () => {
		const arr = opened([1, 2, 3]) as unknown[];
		const vals: unknown[] = [];
		for (const v of arr) vals.push(v);
		expect(vals).toEqual([1, 2, 3]);
	});

	test("spread", () => {
		const arr = opened([1, 2, 3]) as unknown[];
		expect([...arr]).toEqual([1, 2, 3]);
	});

	test("JSON.stringify", () => {
		const arr = opened([1, "hello", true, null]);
		expect(JSON.stringify(arr)).toBe('[1,"hello",true,null]');
	});

	test("nested arrays", () => {
		const arr = opened([[1, 2], [3, 4]]) as unknown[][];
		expect(arr[0]![0]).toBe(1);
		expect(arr[0]![1]).toBe(2);
		expect(arr[1]![0]).toBe(3);
		expect(arr[1]![1]).toBe(4);
		expect(JSON.stringify(arr)).toBe("[[1,2],[3,4]]");
	});

	test("empty array", () => {
		const arr = opened([]) as unknown[];
		expect(arr.length).toBe(0);
		expect([...arr]).toEqual([]);
	});

	test("indexed array", () => {
		const arr = opened([10, 20, 30, 40, 50], { indexThreshold: 0 }) as unknown[];
		expect(arr.length).toBe(5);
		expect(arr[0]).toBe(10);
		expect(arr[4]).toBe(50);
		expect([...arr]).toEqual([10, 20, 30, 40, 50]);
	});

	test("'in' operator", () => {
		const arr = opened([10, 20]) as unknown[];
		expect(0 in arr).toBe(true);
		expect(1 in arr).toBe(true);
		expect(2 in arr).toBe(false);
	});
});

describe("open() objects", () => {
	test("property access", () => {
		const obj = opened({ color: "red", size: 42 }) as any;
		expect(obj.color).toBe("red");
		expect(obj.size).toBe(42);
	});

	test("missing key returns undefined", () => {
		const obj = opened({ a: 1 }) as any;
		expect(obj.missing).toBe(undefined);
	});

	test("Object.keys", () => {
		const obj = opened({ x: 1, y: 2 }) as any;
		const keys = Object.keys(obj);
		expect(keys.sort()).toEqual(["x", "y"]);
	});

	test("Object.entries", () => {
		const obj = opened({ a: 1, b: 2 }) as any;
		const entries = Object.entries(obj);
		expect(entries.sort()).toEqual([["a", 1], ["b", 2]]);
	});

	test("'in' operator", () => {
		const obj = opened({ a: 1 }) as any;
		expect("a" in obj).toBe(true);
		expect("b" in obj).toBe(false);
	});

	test("JSON.stringify", () => {
		const obj = opened({ a: 1, b: "hello" }) as any;
		const parsed = JSON.parse(JSON.stringify(obj));
		expect(parsed.a).toBe(1);
		expect(parsed.b).toBe("hello");
	});

	test("nested objects", () => {
		const obj = opened({ outer: { inner: 42 } }) as any;
		expect(obj.outer.inner).toBe(42);
	});

	test("object containing array", () => {
		const obj = opened({ items: [10, 20, 30] }) as any;
		expect(Array.isArray(obj.items)).toBe(true);
		expect(obj.items.length).toBe(3);
		expect(obj.items[1]).toBe(20);
	});

	test("array of objects", () => {
		const data = opened([{ x: 1 }, { x: 2 }]) as any[];
		expect(data[0].x).toBe(1);
		expect(data[1].x).toBe(2);
	});

	test("empty object", () => {
		const obj = opened({}) as any;
		expect(Object.keys(obj)).toEqual([]);
	});

	test("length on object", () => {
		const obj = opened({ a: 1, b: 2, c: 3 }) as any;
		expect(obj.length).toBe(3);
	});
});

describe("open() schema objects", () => {
	test("property access on schema objects", () => {
		const data = opened([
			{ name: "alice", age: 30 },
			{ name: "bob", age: 25 },
			{ name: "carol", age: 20 },
		]) as any[];
		expect(data[0].name).toBe("alice");
		expect(data[0].age).toBe(30);
		expect(data[1].name).toBe("bob");
		expect(data[2].age).toBe(20);
	});

	test("Object.keys on schema objects", () => {
		const data = opened([
			{ name: "alice", age: 30 },
			{ name: "bob", age: 25 },
			{ name: "carol", age: 20 },
		]) as any[];
		expect(Object.keys(data[0]).sort()).toEqual(["age", "name"]);
		expect(Object.keys(data[1]).sort()).toEqual(["age", "name"]);
		// carol has inline keys (no schema)
		expect(Object.keys(data[2]).sort()).toEqual(["age", "name"]);
	});

	test("JSON.stringify with schema objects", () => {
		const data = opened([
			{ name: "alice", age: 30 },
			{ name: "bob", age: 25 },
		]) as any[];
		const parsed = JSON.parse(JSON.stringify(data));
		expect(parsed).toEqual([
			{ name: "alice", age: 30 },
			{ name: "bob", age: 25 },
		]);
	});
});

describe("open() pointers and chains", () => {
	test("pointer values resolve transparently", () => {
		const data = opened(["hello", "hello"]) as any[];
		expect(data[0]).toBe("hello");
		expect(data[1]).toBe("hello");
	});

	test("chain strings resolve", () => {
		const data = opened(["/foo/bar/baz", "/foo/bar/qux"]) as any[];
		expect(data[0]).toBe("/foo/bar/baz");
		expect(data[1]).toBe("/foo/bar/qux");
	});
});

describe("open() read-only", () => {
	test("set throws", () => {
		const obj = opened({ a: 1 }) as any;
		expect(() => { obj.a = 2; }).toThrow("read-only");
	});

	test("delete throws", () => {
		const obj = opened({ a: 1 }) as any;
		expect(() => { delete obj.a; }).toThrow("read-only");
	});
});

describe("open() handle escape hatch", () => {
	test("handle returns data and right offset", () => {
		const obj = opened({ a: 1 }) as any;
		const h = handle(obj);
		expect(h).toBeDefined();
		expect(h!.data).toBeInstanceOf(Uint8Array);
		expect(typeof h!.right).toBe("number");
	});

	test("handle returns undefined for non-proxy", () => {
		expect(handle(42)).toBe(undefined);
		expect(handle("hello")).toBe(undefined);
		expect(handle({})).toBe(undefined);
	});
});

describe("open() Symbol.iterator on objects", () => {
	test("iterates [key, value] pairs", () => {
		const obj = opened({ a: 1, b: 2 }) as any;
		const entries: [string, unknown][] = [];
		for (const pair of obj) entries.push(pair);
		expect(entries.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([["a", 1], ["b", 2]]);
	});
});

// ── strHasPrefix ──

describe("strHasPrefix", () => {
	test("matches ASCII prefix", () => {
		const c = cur("hello world");
		expect(strHasPrefix(c, p("hello"))).toBe(true);
		expect(strHasPrefix(c, p("hello world"))).toBe(true);
		expect(strHasPrefix(c, p("world"))).toBe(false);
	});

	test("empty prefix matches everything", () => {
		const c = cur("hello");
		expect(strHasPrefix(c, p(""))).toBe(true);
		const empty = cur("");
		expect(strHasPrefix(empty, p(""))).toBe(true);
	});

	test("prefix longer than string does not match", () => {
		const c = cur("hi");
		expect(strHasPrefix(c, p("hello"))).toBe(false);
	});

	test("unicode prefix", () => {
		const c = cur("café latte");
		expect(strHasPrefix(c, p("café"))).toBe(true);
		expect(strHasPrefix(c, p("cafe"))).toBe(false);
	});

	test("chain strings match prefix", () => {
		const arr = cur(["/foo/bar/baz", "/foo/bar/qux"]);
		const tmp = makeCursor(arr.data);
		tmp.right = arr.val;
		read(tmp);
		// First child is a chain
		expect(strHasPrefix(tmp, p("/foo/bar"))).toBe(true);
		expect(strHasPrefix(tmp, p("/foo/baz"))).toBe(false);
	});
});

// ── strCompare / strEquals on non-string nodes ──

describe("strCompare on non-string nodes", () => {
	test("returns NaN for integer", () => {
		const c = cur(42);
		expect(strCompare(c, p("hello"))).toBeNaN();
	});

	test("strEquals returns false for non-string", () => {
		const c = cur(42);
		expect(strEquals(c, p("42"))).toBe(false);
	});

	test("strHasPrefix returns false for non-string", () => {
		const c = cur(42);
		expect(strHasPrefix(c, p("4"))).toBe(false);
	});
});

// ── findByPrefix ──

describe("findByPrefix", () => {
	test("finds matching keys (non-indexed)", () => {
		const obj = cur({ apple: 1, apricot: 2, banana: 3, avocado: 4 });
		const c = makeCursor(obj.data);
		const results: [string, number][] = [];
		findByPrefix(c, obj, "ap", (key, value) => {
			results.push([resolveStr(key), value.val]);
		});
		expect(results.sort()).toEqual([["apple", 1], ["apricot", 2]]);
	});

	test("finds matching keys (indexed)", () => {
		const obj = cur({ apple: 1, apricot: 2, banana: 3, avocado: 4 }, { indexThreshold: 0 });
		const c = makeCursor(obj.data);
		const results: [string, number][] = [];
		findByPrefix(c, obj, "ap", (key, value) => {
			results.push([resolveStr(key), value.val]);
		});
		expect(results.sort()).toEqual([["apple", 1], ["apricot", 2]]);
	});

	test("no matches returns nothing", () => {
		const obj = cur({ apple: 1, banana: 2 });
		const c = makeCursor(obj.data);
		const results: string[] = [];
		findByPrefix(c, obj, "zzz", (key) => { results.push(resolveStr(key)); });
		expect(results).toEqual([]);
	});

	test("empty prefix matches all keys", () => {
		const obj = cur({ a: 1, b: 2 });
		const c = makeCursor(obj.data);
		const results: string[] = [];
		findByPrefix(c, obj, "", (key) => { results.push(resolveStr(key)); });
		expect(results.sort()).toEqual(["a", "b"]);
	});

	test("visitor returning false stops iteration", () => {
		const obj = cur({ a: 1, b: 2, c: 3 });
		const c = makeCursor(obj.data);
		const results: string[] = [];
		findByPrefix(c, obj, "", (key) => {
			results.push(resolveStr(key));
			return false; // stop after first
		});
		expect(results.length).toBe(1);
	});

	test("works with chain keys", () => {
		const obj = cur({ "/foo/bar": 1, "/foo/baz": 2, "/qux": 3 });
		const c = makeCursor(obj.data);
		const results: [string, number][] = [];
		findByPrefix(c, obj, "/foo/", (key, value) => {
			results.push([resolveStr(key), value.val]);
		});
		expect(results.sort()).toEqual([["/foo/bar", 1], ["/foo/baz", 2]]);
	});

	test("on non-object does nothing", () => {
		const arr = cur([1, 2, 3]);
		const c = makeCursor(arr.data);
		let called = false;
		findByPrefix(c, arr, "x", () => { called = true; });
		expect(called).toBe(false);
	});
});

// ── Proxy identity (memoization) ──

describe("open() proxy identity", () => {
	test("same container returns same proxy", () => {
		const obj = opened({ nested: { a: 1 } }) as any;
		expect(obj.nested).toBe(obj.nested);
	});

	test("same array element returns same proxy", () => {
		const arr = opened([{ x: 1 }, { x: 2 }]) as any[];
		expect(arr[0]).toBe(arr[0]);
	});

	test("pointer dedup returns same proxy", () => {
		// Two objects sharing the same nested value via pointer
		const shared = { inner: 42 };
		const arr = opened([shared, shared]) as any[];
		expect(arr[0]).toBe(arr[1]);
	});
});

// ── Proxy Array.prototype delegation ──

describe("open() array methods", () => {
	test("map", () => {
		const arr = opened([1, 2, 3]) as any[];
		const doubled = arr.map((x: number) => x * 2);
		expect(doubled).toEqual([2, 4, 6]);
	});

	test("filter", () => {
		const arr = opened([1, 2, 3, 4, 5]) as any[];
		const evens = arr.filter((x: number) => x % 2 === 0);
		expect(evens).toEqual([2, 4]);
	});

	test("indexOf", () => {
		const arr = opened([10, 20, 30]) as any[];
		expect(arr.indexOf(20)).toBe(1);
		expect(arr.indexOf(99)).toBe(-1);
	});

	test("includes", () => {
		const arr = opened(["a", "b", "c"]) as any[];
		expect(arr.includes("b")).toBe(true);
		expect(arr.includes("z")).toBe(false);
	});

	test("every / some", () => {
		const arr = opened([2, 4, 6]) as any[];
		expect(arr.every((x: number) => x % 2 === 0)).toBe(true);
		expect(arr.some((x: number) => x > 5)).toBe(true);
		expect(arr.some((x: number) => x > 10)).toBe(false);
	});

	test("reduce", () => {
		const arr = opened([1, 2, 3]) as any[];
		const sum = arr.reduce((acc: number, x: number) => acc + x, 0);
		expect(sum).toBe(6);
	});

	test("find", () => {
		const arr = opened([{ x: 1 }, { x: 2 }, { x: 3 }]) as any[];
		const found = arr.find((item: any) => item.x === 2);
		expect(found.x).toBe(2);
	});

	test("slice", () => {
		const arr = opened([10, 20, 30, 40]) as any[];
		expect(arr.slice(1, 3)).toEqual([20, 30]);
	});
});

// ── Proxy for...in iteration ──

describe("open() for...in", () => {
	test("iterates object keys", () => {
		const obj = opened({ x: 1, y: 2, z: 3 }) as any;
		const keys: string[] = [];
		for (const k in obj) keys.push(k);
		expect(keys.sort()).toEqual(["x", "y", "z"]);
	});

	test("accesses values during for...in", () => {
		const obj = opened({ a: 10, b: 20 }) as any;
		const entries: [string, number][] = [];
		for (const k in obj) entries.push([k, obj[k]]);
		expect(entries.sort()).toEqual([["a", 10], ["b", 20]]);
	});
});

// ── stringify ──

describe("stringify", () => {
	describe("primitives", () => {
		test("encodes integers with zigzag + base64", () => {
			expect(stringify(0)).toBe("+");
			expect(stringify(1)).toBe("+2");
			expect(stringify(-1)).toBe("+1");
			expect(stringify(42)).toBe("+1k");
			expect(stringify(-42)).toBe("+1j");
		});

		test("encodes decimals", () => {
			expect(stringify(3.14)).toBe("+9Q*3");
			expect(stringify(0.5)).toBe("+a*1");
			expect(stringify(1000000)).toBe("+2*c");
		});

		test("encodes length-prefixed strings for non-bare characters", () => {
			expect(stringify("hello world")).toBe("hello world,b");
			expect(stringify("foo bar")).toBe("foo bar,7");
		});

		test("encodes booleans, null, undefined", () => {
			expect(stringify(true)).toBe("'t");
			expect(stringify(false)).toBe("'f");
			expect(stringify(null)).toBe("'n");
			expect(stringify(undefined)).toBe("'u");
		});

		test("encodes special numbers", () => {
			expect(stringify(NaN)).toBe("'nan");
			expect(stringify(Infinity)).toBe("'inf");
			expect(stringify(-Infinity)).toBe("'nif");
		});
	});

	describe("arrays", () => {
		test("encodes simple arrays", () => {
			expect(stringify([1, 2, 3])).toBe("+6+4+2;6");
		});

		test("encodes arrays as values with length prefix", () => {
			const encoded = stringify([[1, 2, 3]], {});
			expect(encoded).toBe("+6+4+2;6;8");
		});

		test("encodes empty array", () => {
			expect(stringify([])).toBe(";");
		});

		test("encodes nested arrays", () => {
			const encoded = stringify([[1], [2]]);
			expect(encoded).toBe("+4;2+2;2;8");
		});

		test("encodes arrays with different formats", () => {
			const data = [
				[1, 2],
				[3, 4],
			];
			expect(stringify(data)).toBe("+8+6;4+4+2;4;c");
			expect(stringify(data, { indexThreshold: 0 })).toBe(
				"+8+602#g;8+4+202#g;80a#g;o",
			);
		});
	});

	describe("objects", () => {
		test("encodes simple objects", () => {
			expect(stringify({ color: "red", size: 42 })).toBe(
				"+1ksize,4red,3color,5:l",
			);
		});

		test("encodes empty object", () => {
			expect(stringify({})).toBe(":");
		});

		test("encodes objects with length prefix", () => {
			const encoded = stringify([{ a: 1 }]);
			expect(encoded).toBe("+2a,1:5;7");
		});

		test("encodes objects with different formats", () => {
			const data = { a: { b: 1, c: 1 }, d: { e: 3, f: 4 } };
			expect(stringify(data)).toBe("+8f,1+6e,1:ad,1+2c,1+2b,1:aa,1:u");
			expect(stringify(data, { indexThreshold: 0 })).toBe(
				"+8f,1+6e,105#g:ed,1+2c,1+2b,105#g:ea,10j#g:G",
			);
		});

		test("object keys are sorted when indexes enabled", () => {
			const obj = { c: 3, a: 1, b: 2 };
			const encoded = stringify(obj, { indexThreshold: 2 });
			expect(encoded).toBe("+4b,1+2a,1+6c,15a0#o:k");
		});
	});

	describe("indexes", () => {
		test("embed index into small array", () => {
			const arr = [1, 2, 3];
			const encoded = stringify(arr, { indexThreshold: 2 });
			expect(encoded).toBe("+6+4+2024#o;b");
		});
		test("embeds index for medium arrays", () => {
			const arr = Array.from({ length: 12 }, (_, i) => i);
			const encoded = stringify(arr, { indexThreshold: 10 });
			expect(encoded).toBe("+m+k+i+g+e+c+a+8+6+4+2+013579bdfhjl#1w;C");
		});
		test("embeds index for large arrays", () => {
			const arr = Array.from({ length: 40 }, (_, i) => i);
			const encoded = stringify(arr, { indexThreshold: 30 });
			expect(encoded).toBe(
				"+1e+1c+1a+18+16+14+12+10+-+Y+W+U+S+Q+O+M+K+I+G+E+C+A+y+w+u+s+q+o+m+k+i+g+e+c+a+8+6+4+2+0001030507090b0d0f0h0j0l0n0p0r0t0v0x0z0B0D0F0H0J0L0N0P0R0T0V0X0Z0_1215181b1e1h1k#51;2G",
			);
		});

		test("skips index for small arrays", () => {
			const encoded = stringify([1, 2, 3], { indexThreshold: 10 });
			expect(encoded).not.toContain("#");
		});

		test("disables index when indexes is false", () => {
			const arr = Array.from({ length: 20 }, (_, i) => i);
			const encoded = stringify(arr, { indexThreshold: Infinity });
			expect(encoded).not.toContain("#");
		});

		test("indices for maps", () => {
			const obj = { a: 1, b: 2, c: 3 };
			const encoded = stringify(obj, { indexThreshold: 2 });
			expect(encoded).toBe("+6c,1+4b,1+2a,105a#o:k");
		});

		test("map indexes sort keys", () => {
			const obj = { c: 3, a: 1, b: 2 };
			const encoded = stringify(obj, { indexThreshold: 2 });
			expect(encoded).toBe("+4b,1+2a,1+6c,15a0#o:k");
		});

		test("schema objects can have indices on values", () => {
			const data = [
				{ name: "alice", age: 1 },
				{ name: "bob", age: 2 },
			];
			expect(stringify(data, { indexThreshold: 1 })).toBe(
				"+4age,3bob,3name,4b0#g:m+2alice,507#g^d:f0h#g;J",
			);
			expect(stringify(data, { indexThreshold: 1 })).toBe(
				"+4age,3bob,3name,4b0#g:m+2alice,507#g^d:f0h#g;J",
			);
		});
	});

	describe("pointers", () => {
		test("deduplicates repeated strings", () => {
			const encoded = stringify(["hello", "hello"]);
			expect(encoded).toBe("hello,5^;8");
		});

		test("deduplicates repeated objects", () => {
			const obj = { x: 1 };
			expect(stringify([obj, obj])).toBe("+2x,1:5^;8");
		});
	});

	describe("refs", () => {
		test("encodes value matching a ref as ref shorthand", () => {
			expect(
				stringify("hello", {
					refs: { H: "hello" }
				}),
			).toBe("'H");
		});

		test("encodes number matching a ref", () => {
			expect(stringify(42, { refs: { X: 42 } })).toBe("'X");
		});

		test("encodes refs inside arrays", () => {
			expect(stringify(["hello", "world"], { refs: { H: "hello" } })).toBe(
				"world,5'H;9",
			);
		});

		test("encodes multiple refs", () => {
			expect(
				stringify(["hello", 42], {
					refs: { H: "hello", X: 42 },
				}),
			).toBe("'X'H;4");
		});

		test("encodes schema ref for repeated object shapes", () => {
			const data = [
				{ a: 1, b: 2 },
				{ a: 3, b: 4 },
			];
			expect(
				stringify(data, {
					refs: { S: ["a", "b"] },
				}),
			).toBe("+8+6'S:6+4+2'S:6;g");
		});

		test("use refs even when pointers are disabled", () => {
			expect(
				stringify("hello", { refs: { H: "hello" } }),
			).toBe("'H");
		});
	});

	describe("shared schemas", () => {
		test("deduplicates repeated object shapes", () => {
			const data = [
				{ name: "alice", age: 1 },
				{ name: "bob", age: 2 },
				{ name: "charlie", age: 3 },
			];
			expect(stringify(data)).toBe(
				"+6age,3charlie,7name,4:m+4bob,3^7:9+2alice,5^k:b;M",
			);
		});

		test("does not use schemas for single objects", () => {
			const data = [{ name: "alice" }];
			const encoded = stringify(data);
			expect(encoded).toBe("alice,5name,4:d;f");
		});

		test("Can use array refs as schema targets", () => {
			const data = { a: 1, b: 2 };
			const refs = { K: ["a", "b"] };
			expect(stringify(data, { refs })).toBe("+4+2'K:6");
		});

		test("Can use object refs as schema targets", () => {
			const data = { a: 1, b: 2 };
			const refs = { O: { a: 3, b: 4 } };
			expect(stringify(data, { refs })).toBe("+4+2'O:6");
		});

		describe("path chains", () => {
			test("encodes path chains with shared prefixes", () => {
				const chain = { stringChainThreshold: 0 };
				expect(stringify("/")).toBe("/,1");
				expect(stringify("/about")).toBe("/about,6");
				const paths = ["/foo/bar/baz", "/foo/bar/qux", "/foo/quux"];
				expect(stringify(paths, chain)).toBe(
					"/quux,5/foo,4.d/qux,4/bar,4^e.8.g/baz,4^8.8;H",
				);
				const prefixedPaths = ["/foo/bar/baz", "/foo/bar/qux"];
				expect(stringify(prefixedPaths, chain)).toBe("/qux,4/bar,4/foo,4.c.k/baz,4^8.8;w");
			});
		});

		describe("website manifest", () => {
			const doc = {
				"/": { name: "Home", method: "GET" },
				"/about": { name: "About", method: "GET" },
				"/contact": { name: "Contact", method: "POST" },
				"/blog": { name: "Blog", method: "GET" },
				"/blog/post": { name: "Blog Post", method: "GET" },
				"/blog/post/comment": { name: "Comment", method: "POST" },
				"/api/data": { name: "API Data", method: "GET" },
				"/api/update": { name: "API Update", method: "POST" },
				"/admin": { name: "Admin", method: "GET" },
				"/admin/settings": { name: "Admin Settings", method: "POST" },
				"/admin/users": { name: "Admin Users", method: "GET" },
				"/admin/users/add": { name: "Add User", method: "POST" },
				"/admin/users/remove": { name: "Remove User", method: "POST" },
				"/admin/logs": { name: "Admin Logs", method: "GET" },
				"/admin/logs/clear": { name: "Clear Logs", method: "POST" },
				"/admin/logs/export": { name: "Export Logs", method: "GET" },
				"/admin/logs/export/json": { name: "Export Logs as JSON", method: "GET" },
				"/admin/logs/export/csv": { name: "Export Logs as CSV", method: "GET" },
			};
			test("byte counts are accurate with different options", () => {
				const chain = { stringChainThreshold: 0 };
				expect(stringify(doc, chain)).toBe(
					"GET,3method,6Export Logs as CSV,iname,4:D/csv,4/export,7/logs,5/admin,6.f.q.y^18Export Logs as JSON,j^Y:q/json,5^B.9^1LExport Logs,b^1r:j^-POST,4Clear Logs,a^1Q:l/clear,6^1x.b^2GAdmin Logs,a^2l:i^1W^RRemove User,b^2I:i/remove,7/users,6^2A.b.m^1xAdd User,8^3m:g/add,4^q.8^49Admin Users,b^3R:j^P^2kAdmin Settings,e^4f:m/settings,9^41.e^58Admin,5^4K:d^4l^3eAPI Update,a^55:i/update,7/api,4.f^5_API Data,8^5E:g/data,5^r.9^4gComment,7^64:f/post/comment,d/blog,5.m^75Blog Post,9^6L:h/post,5^s.9^7zBlog,4^78:c^K^5DContact,7^7r:f/contact,8^8eAbout,5^7Q:d/about,6^8BHome,4^8a:c/,1000h3s5R6c6M7K773K4m4J592q2T131j1N0E#2h:9y",
				);
				expect(
					stringify(doc, {
						...chain,
						indexThreshold: Infinity,
					}),
				).toBe(
					"GET,3method,6Export Logs as CSV,iname,4:D/csv,4/export,7/logs,5/admin,6.f.q.y^18Export Logs as JSON,j^Y:q/json,5^B.9^1LExport Logs,b^1r:j^-POST,4Clear Logs,a^1Q:l/clear,6^1x.b^2GAdmin Logs,a^2l:i^1W^RRemove User,b^2I:i/remove,7/users,6^2A.b.m^1xAdd User,8^3m:g/add,4^q.8^49Admin Users,b^3R:j^P^2kAdmin Settings,e^4f:m/settings,9^41.e^58Admin,5^4K:d^4l^3eAPI Update,a^55:i/update,7/api,4.f^5_API Data,8^5E:g/data,5^r.9^4gComment,7^64:f/post/comment,d/blog,5.m^75Blog Post,9^6L:h/post,5^s.9^7zBlog,4^78:c^K^5DContact,7^7r:f/contact,8^8eAbout,5^7Q:d/about,6^8BHome,4^8a:c/,1:8X",
				);
			});
		});

		describe("emoji party", () => {
			const doc = {
				"/emoji/🔥": { name: "fire", group: "travel-places" },
				"/emoji/💧": { name: "water", group: "travel-places" },
				"/emoji/🌱": { name: "seedling", group: "animals-nature" },
				"/emoji/🐍": { name: "snake", group: "animals-nature" },
				"/emoji/🎸": { name: "guitar", group: "objects" },
				"/emoji/⚽": { name: "soccer ball", group: "activities" },
				"/emoji/❤️": { name: "red heart", group: "smileys-emotion" },
				"/emoji/🏴‍☠️": { name: "pirate flag", group: "flags" },
			};
			test("byte counts are accurate with different options", () => {
				expect(stringify(doc, { stringChainThreshold: 0 })).toBe(
					"flags,5group,5pirate flag,bname,4:x/🏴‍☠️,e/emoji,6.osmileys-emotion,fred heart,9^S:u/❤️,7^H.bactivities,asoccer ball,b^1w:s/⚽,4^1j.9objects,7guitar,6^21:k/🎸,5^1R.aanimals-nature,esnake,5^2F:q/🐍,5^2t.a^oseedling,8^36:f/🌱,5^2W.atravel-places,dwater,5^3J:p/💧,5^3x.a^ofire,4^46:b/🔥,5^3W.a:4W",
				);
				expect(stringify(doc, { stringChainDelimiter: "" })).toBe(
					"flags,5group,5pirate flag,bname,4:x/emoji/🏴‍☠️,ksmileys-emotion,fred heart,9^O:u/emoji/❤️,dactivities,asoccer ball,b^1u:s/emoji/⚽,aobjects,7guitar,6^20:k/emoji/🎸,banimals-nature,esnake,5^2F:q/emoji/🐍,b^pseedling,8^37:f/emoji/🌱,btravel-places,dwater,5^3L:p/emoji/💧,b^pfire,4^49:b/emoji/🔥,b:4-",
				);
			});
		});

		describe("encode colored fruits", () => {
			const doc = [
				{ color: "red", fruits: ["apple", "strawberry"] },
				{ color: "green", fruits: ["apple"] },
				{ color: "yellow", fruits: ["apple", "banana"] },
				{ color: "orange", fruits: ["orange"] },
			];
			test("with correct options applied", () => {
				expect(stringify(doc)).toBe(
					"orange,6;8fruits,6^acolor,5:rbanana,6apple,5;fyellow,6^p:r^e;2green,5^E:dstrawberry,a^F;ered,3^11:o;1z",
				);
				expect(stringify(doc, {})).toBe(
					"orange,6;8fruits,6^acolor,5:rbanana,6apple,5;fyellow,6^p:r^e;2green,5^E:dstrawberry,a^F;ered,3^11:o;1z",
				);
				expect(stringify(doc)).toBe(
					"orange,6;8fruits,6^acolor,5:rbanana,6apple,5;fyellow,6^p:r^e;2green,5^E:dstrawberry,a^F;ered,3^11:o;1z",
				);
			});
		});
	});
});

// ── parse / decode ──

describe("parse", () => {
	describe("primitives", () => {
		test("parses integers", () => {
			expect(parse("+")).toBe(0);
			expect(parse("+2")).toBe(1);
			expect(parse("+1")).toBe(-1);
			expect(parse("+1k")).toBe(42);
			expect(parse("+1j")).toBe(-42);
		});

		test("parses decimals", () => {
			expect(parse("+9Q*3")).toBe(3.14);
			expect(parse("+a*1")).toBe(0.5);
		});

		test("parses strings", () => {
			expect(parse(",")).toBe("");
			expect(parse("hello world,b")).toBe("hello world");
			expect(parse("foo bar,7")).toBe("foo bar");
		});

		test("parses booleans, null, undefined", () => {
			expect(parse("'t")).toBe(true);
			expect(parse("'f")).toBe(false);
			expect(parse("'n")).toBe(null);
			expect(parse("'u")).toBe(undefined);
		});

		test("parses special numbers", () => {
			expect(parse("'nan")).toBeNaN();
			expect(parse("'inf")).toBe(Infinity);
			expect(parse("'nif")).toBe(-Infinity);
		});
	});

	describe("arrays", () => {
		test("parses simple arrays", () => {
			expect([...(parse("+6+4+2;6") as any[])]).toEqual([1, 2, 3]);
		});

		test("parses empty array", () => {
			expect([...(parse(";") as any[])]).toEqual([]);
		});
	});

	describe("objects", () => {
		test("parses simple objects", () => {
			const obj = parse("+1ksize,4red,3color,5:l") as any;
			expect(obj.color).toBe("red");
			expect(obj.size).toBe(42);
		});

		test("parses empty object", () => {
			expect(Object.keys(parse(":") as any)).toEqual([]);
		});
	});

	test("resolves pointer references", () => {
		const arr = parse("hello,5^;8") as any[];
		expect(arr[0]).toBe("hello");
		expect(arr[1]).toBe("hello");
	});
});

// ── streaming ──

describe("stringify streaming", () => {
	test("onChunk receives chunks", () => {
		const chunks: { offset: number; data: string }[] = [];
		stringify(
			{ a: 1 },
			{
				onChunk: (data, offset) => chunks.push({ offset, data }),
			},
		);
		expect(chunks).toEqual([
			{ offset: 0, data: "+2" },
			{ offset: 2, data: "a" },
			{ offset: 3, data: ",1" },
			{ offset: 5, data: ":5" },
		]);
	});

	test("onChunk offsets are increasing", () => {
		const offsets: number[] = [];
		stringify([1, 2, 3, "hello", { a: true }], {
			onChunk: (_, offset) => offsets.push(offset),
		});
		for (let i = 1; i < offsets.length; i++) {
			expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]!);
		}
	});

	test("reassembled chunks match non-streaming output", () => {
		const value = { items: [1, "two", true], name: "test" };
		const direct = stringify(value);
		const chunks: string[] = [];
		stringify(value, {
			onChunk: (chunk) => chunks.push(chunk),
		});
		const result = chunks.join("");
		expect(result).toBe(direct);
	});
});

// ── round-trip ──

describe("round-trip", () => {
	const roundTrip = (
		value: unknown,
		opts?: Parameters<typeof encode>[1],
	) => {
		const buf = encode(value, opts);
		return open(buf, opts?.refs);
	};

	test("round-trips primitives", () => {
		expect(roundTrip(0)).toBe(0);
		expect(roundTrip(1)).toBe(1);
		expect(roundTrip(-1)).toBe(-1);
		expect(roundTrip(42)).toBe(42);
		expect(roundTrip(3.14)).toBe(3.14);
		expect(roundTrip("hello")).toBe("hello");
		expect(roundTrip("hello world")).toBe("hello world");
		expect(roundTrip("")).toBe("");
		expect(roundTrip(true)).toBe(true);
		expect(roundTrip(false)).toBe(false);
		expect(roundTrip(null)).toBe(null);
		expect(roundTrip(undefined)).toBe(undefined);
	});

	test("round-trips arrays", () => {
		expect([...(roundTrip([]) as any[])]).toEqual([]);
		expect([...(roundTrip([1, 2, 3]) as any[])]).toEqual([1, 2, 3]);
		expect([...(roundTrip(["a", "b", "c"]) as any[])]).toEqual(["a", "b", "c"]);
		const nested = roundTrip([[1, 2], [3, 4]]) as any[];
		expect([...(nested[0] as any[])]).toEqual([1, 2]);
		expect([...(nested[1] as any[])]).toEqual([3, 4]);
	});

	test("round-trips objects", () => {
		expect(Object.keys(roundTrip({}) as any)).toEqual([]);
		const obj = roundTrip({ a: 1, b: 2 }) as any;
		expect(obj.a).toBe(1);
		expect(obj.b).toBe(2);
		const nested = roundTrip({ name: "rex", nested: { ok: true } }) as any;
		expect(nested.name).toBe("rex");
		expect(nested.nested.ok).toBe(true);
	});

	test("round-trips complex nested structures", () => {
		const value = {
			routes: [
				{ path: "/api/users", handler: "getUsers", methods: ["GET"] },
				{ path: "/api/users", handler: "createUser", methods: ["POST"] },
			],
			metadata: { version: 1, generated: true },
		};
		const result = roundTrip(value) as any;
		expect(result.metadata.version).toBe(1);
		expect(result.metadata.generated).toBe(true);
		expect(result.routes[0].path).toBe("/api/users");
		expect(result.routes[0].handler).toBe("getUsers");
		expect([...(result.routes[0].methods as any[])]).toEqual(["GET"]);
		expect(result.routes[1].handler).toBe("createUser");
	});

	test("round-trips with path chains", () => {
		const paths = [
			"/docs/api/v2/users",
			"/docs/api/v2/teams",
			"/docs/api/v2/billing",
		];
		const result = roundTrip({ paths, config: { retries: 3, timeout: 30 } }) as any;
		expect([...(result.paths as any[])]).toEqual(paths);
		expect(result.config.retries).toBe(3);
		expect(result.config.timeout).toBe(30);
	});

	test("round-trips with duplicated values", () => {
		const shared = { type: "page", status: 200 };
		const result = roundTrip([shared, shared, shared]) as any[];
		expect(result[0].type).toBe("page");
		expect(result[0].status).toBe(200);
		expect(result[1].type).toBe("page");
		expect(result[2].status).toBe(200);
	});

	test("round-trips large indexed arrays", () => {
		const arr = Array.from({ length: 100 }, (_, i) => i);
		const result = roundTrip(arr, { indexThreshold: 10 }) as any[];
		expect([...result]).toEqual(arr);
	});

	test("round-trips large indexed objects", () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < 50; i++) obj[`key${i}`] = i;
		const result = roundTrip(obj, { indexThreshold: 10 }) as any;
		for (const [k, v] of Object.entries(obj)) {
			expect(result[k]).toBe(v);
		}
	});

	test("round-trips with schemas", () => {
		const data = {
			entries: {
				"/data/people/alice": { name: "alice", age: 1 },
				"/data/people/bob": { name: "bob", age: 2 },
				"/data/people/charlie": { name: "charlie", age: 3 },
			}
		};
		const result = roundTrip(data) as any;
		expect(result.entries["/data/people/alice"].name).toBe("alice");
		expect(result.entries["/data/people/bob"].age).toBe(2);
		expect(result.entries["/data/people/charlie"].name).toBe("charlie");
	});

	test("round-trips objects with overlapping but distinct key sets", () => {
		const data = [{ a: 1, b: 2 }, { a: 3 }];
		const result = roundTrip(data) as any[];
		expect(result[0].a).toBe(1);
		expect(result[0].b).toBe(2);
		expect(result[1].a).toBe(3);
	});

	test("round-trips objects where first key is a pointer", () => {
		const data = [
			{ contentType: "text/html", status: 200 },
			{ contentType: "text/css" },
		];
		const result = roundTrip(data) as any[];
		expect(result[0].contentType).toBe("text/html");
		expect(result[0].status).toBe(200);
		expect(result[1].contentType).toBe("text/css");
	});

	test("round-trips mixed key/value reuse across objects", () => {
		const data = [
			{ label: "type" },
			{ type: "page", active: true },
		];
		const result = roundTrip(data) as any[];
		expect(result[0].label).toBe("type");
		expect(result[1].type).toBe("page");
		expect(result[1].active).toBe(true);
	});

	test("round-trips string ref", () => {
		const refs = { H: "hello" };
		// Verify encoder actually uses the ref shorthand
		const encoded = stringify("hello", { refs });
		expect(encoded).toBe("'H");
		// Verify decode with refs resolves correctly
		const result = roundTrip("hello", { refs });
		expect(result).toBe("hello");
	});

	test("round-trips number ref", () => {
		const refs = { X: 42 };
		const encoded = stringify(42, { refs });
		expect(encoded).toBe("'X");
		const result = roundTrip(42, { refs });
		expect(result).toBe(42);
	});

	test("round-trips refs inside arrays", () => {
		const refs = { H: "hello" };
		// Verify the ref is used — "hello" should be 'H, not hello,5
		const encoded = stringify(["hello", "world"], { refs });
		expect(encoded).toContain("'H");
		expect(encoded).not.toContain("hello,5");
		// Verify round-trip
		const result = roundTrip(["hello", "world"], { refs }) as any[];
		expect(result[0]).toBe("hello");
		expect(result[1]).toBe("world");
	});

	test("round-trips multiple refs", () => {
		const refs = { H: "hello", W: "world" };
		const encoded = stringify(["hello", "world", "hello"], { refs });
		expect(encoded).toContain("'H");
		expect(encoded).toContain("'W");
		const result = roundTrip(["hello", "world", "hello"], { refs }) as any[];
		expect(result[0]).toBe("hello");
		expect(result[1]).toBe("world");
		expect(result[2]).toBe("hello");
	});

	test("round-trips object ref as value", () => {
		const sharedObj = { x: 1, y: 2 };
		const refs = { S: sharedObj };
		// Encoding { x: 1, y: 2 } with ref S should produce 'S
		const encoded = stringify(sharedObj, { refs });
		expect(encoded).toBe("'S");
		// Round-trip resolves back to the ref value
		const result = roundTrip(sharedObj, { refs }) as any;
		expect(result.x).toBe(1);
		expect(result.y).toBe(2);
	});

	test("round-trips schema ref for repeated object shapes", () => {
		const data = [
			{ a: 1, b: 2 },
			{ a: 3, b: 4 },
		];
		const refs = { S: ["a", "b"] };
		// Verify encoder uses schema refs — both objects should reference 'S
		const encoded = stringify(data, { refs });
		expect(encoded).toBe("+8+6'S:6+4+2'S:6;g");
		// Both objects use 'S as schema, no inline keys
		expect(encoded.match(/'S/g)?.length).toBe(2);
		// Verify round-trip
		const result = roundTrip(data, { refs }) as any[];
		expect(result[0].a).toBe(1);
		expect(result[0].b).toBe(2);
		expect(result[1].a).toBe(3);
		expect(result[1].b).toBe(4);
		// Verify Object.keys works on schema-ref objects
		expect(Object.keys(result[0]).sort()).toEqual(["a", "b"]);
		expect(Object.keys(result[1]).sort()).toEqual(["a", "b"]);
	});

	test("round-trips object ref as schema target", () => {
		const data = { a: 1, b: 2 };
		const refs = { O: { a: 3, b: 4 } };
		// Encoder should use 'O as schema
		const encoded = stringify(data, { refs });
		expect(encoded).toContain("'O");
		const result = roundTrip(data, { refs }) as any;
		expect(result.a).toBe(1);
		expect(result.b).toBe(2);
		expect(Object.keys(result).sort()).toEqual(["a", "b"]);
	});

	test("round-trips refs mixed with non-ref values", () => {
		const refs = { T: true, N: null };
		const data = [true, false, null, undefined, 42];
		const encoded = stringify(data, { refs });
		// true and null should use refs, others should not
		expect(encoded).toContain("'T");
		expect(encoded).toContain("'N");
		const result = roundTrip(data, { refs }) as any[];
		expect(result[0]).toBe(true);
		expect(result[1]).toBe(false);
		expect(result[2]).toBe(null);
		expect(result[3]).toBe(undefined);
		expect(result[4]).toBe(42);
	});

	test("ref value that also appears as a key (known limitation)", () => {
		// The encoder applies refs to keys too, encoding key "shared" as 'K.
		// The decoder can't currently resolve this because refs in key position
		// make the object appear to have a schema (the ref). This is a known
		// encoder bug — refs shouldn't match object keys.
		const refs = { K: "shared" };
		const encoded = stringify({ shared: "shared" }, { refs });
		// Both key and value become 'K — verifying the encoder behavior
		expect(encoded).toBe("'K'K:4");
	});

	test("opaque non-serializable ref values round-trip", () => {
		// Functions and symbols can be refs — matched by identity on encode,
		// returned as-is on decode.
		const fn = () => "hello";
		const sym = Symbol("test");
		const refs = { F: fn, S: sym };
		// Encoder matches by identity via makeKey
		const encoded = stringify([fn, sym, 42], { refs });
		expect(encoded).toContain("'F");
		expect(encoded).toContain("'S");
		// Decoder returns opaque values
		const result = roundTrip([fn, sym, 42], { refs }) as any[];
		expect(result[0]).toBe(fn);
		expect(result[1]).toBe(sym);
		expect(result[2]).toBe(42);
	});

	// ── Number edge cases ──

	test("negative zero", () => {
		// -0 is tricky: Object.is(-0, 0) is false, but -0 === 0 is true
		const result = roundTrip(-0);
		expect(result).toBe(0); // zigzag can't distinguish -0 from 0
	});

	test("large integers (within zigzag safe range)", () => {
		// Zigzag doubles the magnitude, so max safe integer for zigzag is MAX_SAFE_INTEGER / 2
		const maxZigzag = Math.floor(Number.MAX_SAFE_INTEGER / 2);
		expect(roundTrip(maxZigzag)).toBe(maxZigzag);
		expect(roundTrip(-maxZigzag)).toBe(-maxZigzag);
		expect(roundTrip(0x7FFFFFFFFF)).toBe(0x7FFFFFFFFF);
		expect(roundTrip(-0x7FFFFFFFFF)).toBe(-0x7FFFFFFFFF);
	});

	test("powers of 10 (trailing zeroes use exponent form)", () => {
		for (const n of [10, 100, 1000, 10000, 1e10, 1e15, 1e20]) {
			expect(roundTrip(n)).toBe(n);
			expect(roundTrip(-n)).toBe(-n);
		}
	});

	test("very small floats", () => {
		expect(roundTrip(1e-10)).toBe(1e-10);
		expect(roundTrip(5e-324)).toBe(5e-324); // Number.MIN_VALUE
	});

	test("floats with moderate precision", () => {
		// Encoder uses toPrecision(14), so ~14 significant digits survive
		expect(roundTrip(0.1 + 0.2)).toBeCloseTo(0.1 + 0.2, 14);
		expect(roundTrip(1.23456789012345)).toBeCloseTo(1.23456789012345, 13);
		expect(roundTrip(9.876543210987e12)).toBe(9.876543210987e12);
	});

	// ── String edge cases ──

	test("empty string in various positions", () => {
		const result = roundTrip({ "": 1, a: "" }) as any;
		expect(result[""]).toBe(1);
		expect(result.a).toBe("");
	});

	test("strings containing rexc tag characters", () => {
		// These characters are tags in rexc: + , : ; ^ . ' # *
		const tags = ["+", ",", ":", ";", "^", ".", "'", "#", "*"];
		for (const ch of tags) {
			expect(roundTrip(ch)).toBe(ch);
		}
		expect([...(roundTrip(tags) as any[])]).toEqual(tags);
	});

	test("strings that look like b64 digits", () => {
		// b64 charset: 0-9 a-z A-Z - _
		const tricky = ["0", "a", "Z", "-", "_", "abc123", "---___"];
		for (const s of tricky) {
			expect(roundTrip(s)).toBe(s);
		}
	});

	test("keys that are b64 or tag characters", () => {
		const obj: Record<string, number> = {};
		const keys = ["+", ",", ":", ";", "^", ".", "'", "#", "*", "0", "a", "_"];
		keys.forEach((k, i) => obj[k] = i);
		const result = roundTrip(obj) as any;
		keys.forEach((k, i) => expect(result[k]).toBe(i));
	});

	test("strings with null bytes and control characters", () => {
		expect(roundTrip("\0")).toBe("\0");
		expect(roundTrip("\x01\x02\x03")).toBe("\x01\x02\x03");
		expect(roundTrip("hello\0world")).toBe("hello\0world");
		expect(roundTrip("\n\r\t")).toBe("\n\r\t");
	});

	test("unicode edge cases", () => {
		expect(roundTrip("🏴‍☠️")).toBe("🏴‍☠️"); // ZWJ sequence
		expect(roundTrip("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦"); // family emoji (long ZWJ)
		expect(roundTrip("é")).toBe("é"); // precomposed
		expect(roundTrip("é")).toBe("é"); // decomposed (e + combining accent)
		expect(roundTrip("\u{10FFFF}")).toBe("\u{10FFFF}"); // max codepoint
		expect(roundTrip("日本語テスト")).toBe("日本語テスト"); // CJK
	});

	test("long string (multi-digit b64 length)", () => {
		const long = "x".repeat(10000);
		expect(roundTrip(long)).toBe(long);
	});

	test("keys that are prefixes of each other", () => {
		const obj = { a: 1, ab: 2, abc: 3, abcd: 4 };
		const result = roundTrip(obj) as any;
		expect(result.a).toBe(1);
		expect(result.ab).toBe(2);
		expect(result.abc).toBe(3);
		expect(result.abcd).toBe(4);
	});

	// ── Container edge cases ──

	test("nested empty containers", () => {
		const result1 = roundTrip([[]]) as any[];
		expect([...(result1[0] as any[])]).toEqual([]);

		const result2 = roundTrip([{}]) as any[];
		expect(Object.keys(result2[0])).toEqual([]);

		const result3 = roundTrip({ a: [] }) as any;
		expect([...(result3.a as any[])]).toEqual([]);

		const result4 = roundTrip({ a: {} }) as any;
		expect(Object.keys(result4.a)).toEqual([]);
	});

	test("deeply nested structure", () => {
		let value: any = 42;
		for (let i = 0; i < 50; i++) value = { v: value };
		let result = roundTrip(value) as any;
		for (let i = 0; i < 50; i++) result = result.v;
		expect(result).toBe(42);
	});

	test("mixed types in single array", () => {
		const mixed = [0, -1, 3.14, "", "hello", true, false, null, undefined, [], {}];
		const result = roundTrip(mixed) as any[];
		expect(result[0]).toBe(0);
		expect(result[1]).toBe(-1);
		expect(result[2]).toBe(3.14);
		expect(result[3]).toBe("");
		expect(result[4]).toBe("hello");
		expect(result[5]).toBe(true);
		expect(result[6]).toBe(false);
		expect(result[7]).toBe(null);
		expect(result[8]).toBe(undefined);
		expect([...(result[9] as any[])]).toEqual([]);
		expect(Object.keys(result[10])).toEqual([]);
	});

	test("single-element containers", () => {
		expect([...(roundTrip([42]) as any[])]).toEqual([42]);
		const obj = roundTrip({ only: "one" }) as any;
		expect(obj.only).toBe("one");
	});

	test("container at exact index threshold", () => {
		// Exactly at threshold: should get indexed
		const atThreshold = Array.from({ length: 32 }, (_, i) => i);
		const result1 = roundTrip(atThreshold, { indexThreshold: 32 }) as any[];
		expect([...result1]).toEqual(atThreshold);

		// One below threshold: should NOT get indexed
		const belowThreshold = Array.from({ length: 31 }, (_, i) => i);
		const result2 = roundTrip(belowThreshold, { indexThreshold: 32 }) as any[];
		expect([...result2]).toEqual(belowThreshold);
	});

	// ── Pointer / dedup edge cases ──

	test("same object at different nesting depths", () => {
		const shared = { x: 1 };
		const data = { a: shared, b: { c: shared }, d: [shared] };
		const result = roundTrip(data) as any;
		expect(result.a.x).toBe(1);
		expect(result.b.c.x).toBe(1);
		expect(result.d[0].x).toBe(1);
	});

	test("many identical small values (pointer cost vs inline cost)", () => {
		// Small values like single chars may be cheaper inline than as pointers
		const data = Array.from({ length: 100 }, () => "a");
		const result = roundTrip(data) as any[];
		expect([...result]).toEqual(data);
	});

	test("identical arrays are deduplicated", () => {
		const shared = [1, 2, 3];
		const data = [shared, shared];
		const result = roundTrip(data) as any[];
		expect([...(result[0] as any[])]).toEqual([1, 2, 3]);
		expect([...(result[1] as any[])]).toEqual([1, 2, 3]);
	});

	test("string appears as both key and value", () => {
		const data = { hello: "hello", world: "world" };
		const result = roundTrip(data) as any;
		expect(result.hello).toBe("hello");
		expect(result.world).toBe("world");
	});

	test("object where all values are identical", () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < 20; i++) obj[`k${i}`] = 999;
		const result = roundTrip(obj) as any;
		for (let i = 0; i < 20; i++) expect(result[`k${i}`]).toBe(999);
	});

	// ── Chain / path edge cases ──

	test("path that is exactly the split character", () => {
		expect(roundTrip("/")).toBe("/");
		expect(roundTrip("//")).toBe("//");
	});

	test("paths with trailing slashes", () => {
		const paths = ["/foo/bar/", "/foo/baz/"];
		const result = roundTrip(paths) as any[];
		expect(result[0]).toBe("/foo/bar/");
		expect(result[1]).toBe("/foo/baz/");
	});

	test("paths with consecutive slashes", () => {
		const paths = ["/foo//bar", "/foo//baz"];
		const result = roundTrip(paths) as any[];
		expect(result[0]).toBe("/foo//bar");
		expect(result[1]).toBe("/foo//baz");
	});

	test("paths with no shared prefix despite containing slashes", () => {
		const paths = ["/alpha/one", "/beta/two"];
		const result = roundTrip(paths) as any[];
		expect(result[0]).toBe("/alpha/one");
		expect(result[1]).toBe("/beta/two");
	});

	test("chain splitting disabled preserves paths", () => {
		const paths = ["/foo/bar/baz", "/foo/bar/qux"];
		const result = roundTrip(paths, { stringChainDelimiter: "" }) as any[];
		expect(result[0]).toBe("/foo/bar/baz");
		expect(result[1]).toBe("/foo/bar/qux");
	});

	test("many paths sharing a deep prefix", () => {
		const base = "/a/b/c/d/e";
		const paths = Array.from({ length: 10 }, (_, i) => `${base}/item${i}`);
		const result = roundTrip(paths) as any[];
		expect([...result]).toEqual(paths);
	});

	// ── Schema edge cases ──

	test("three different object shapes interleaved", () => {
		const data = [
			{ a: 1 },
			{ b: 2 },
			{ a: 3 },
			{ b: 4 },
			{ c: 5 },
		];
		const result = roundTrip(data) as any[];
		expect(result[0].a).toBe(1);
		expect(result[1].b).toBe(2);
		expect(result[2].a).toBe(3);
		expect(result[3].b).toBe(4);
		expect(result[4].c).toBe(5);
	});

	test("objects with same keys but different value types", () => {
		const data = [
			{ x: 1, y: "hello" },
			{ x: "world", y: 2 },
		];
		const result = roundTrip(data) as any[];
		expect(result[0].x).toBe(1);
		expect(result[0].y).toBe("hello");
		expect(result[1].x).toBe("world");
		expect(result[1].y).toBe(2);
	});

	test("schema object with nested containers as values", () => {
		const data = [
			{ list: [1, 2], meta: { ok: true } },
			{ list: [3, 4], meta: { ok: false } },
		];
		const result = roundTrip(data) as any[];
		expect([...(result[0].list as any[])]).toEqual([1, 2]);
		expect(result[0].meta.ok).toBe(true);
		expect([...(result[1].list as any[])]).toEqual([3, 4]);
		expect(result[1].meta.ok).toBe(false);
	});

	test("wide object (many keys)", () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < 200; i++) obj[`field_${String(i).padStart(3, "0")}`] = i;
		const result = roundTrip(obj) as any;
		for (let i = 0; i < 200; i++) {
			expect(result[`field_${String(i).padStart(3, "0")}`]).toBe(i);
		}
	});

	// ── Combination stress tests ──

	test("indexed objects with chain keys", () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < 50; i++) obj[`/api/v2/resource/${i}`] = i;
		const result = roundTrip(obj, { indexThreshold: 10 }) as any;
		for (let i = 0; i < 50; i++) {
			expect(result[`/api/v2/resource/${i}`]).toBe(i);
		}
	});

	test("schemas + indexes + chains combined", () => {
		const data = Array.from({ length: 40 }, (_, i) => ({
			path: `/section/${i % 5}/item/${i}`,
			value: i,
			active: i % 2 === 0,
		}));
		const result = roundTrip(data, { indexThreshold: 10 }) as any[];
		for (let i = 0; i < 40; i++) {
			expect(result[i].path).toBe(`/section/${i % 5}/item/${i}`);
			expect(result[i].value).toBe(i);
			expect(result[i].active).toBe(i % 2 === 0);
		}
	});

	test("number string keys ('0', '1', '2') in objects", () => {
		const obj = { "0": "zero", "1": "one", "10": "ten" };
		const result = roundTrip(obj) as any;
		expect(result["0"]).toBe("zero");
		expect(result["1"]).toBe("one");
		expect(result["10"]).toBe("ten");
	});
});

// ── inspect() tests ──

function inspected(value: unknown, opts?: Parameters<typeof encode>[1]) {
	return inspect(encode(value, opts), opts?.refs);
}

function childArray(node: ASTNode): ASTNode[] {
	return [...node];
}

describe("inspect() node fields", () => {
	test("integer", () => {
		const node = inspected(42);
		expect(node.tag).toBe("+");
		expect(node.b64).toBe(42);
		expect(node.size).toBe(0);
		expect(node.left).toBe(node.right - 1 - 2); // tag + b64 digits
		expect(node.value).toBe(42);
		expect(childArray(node)).toHaveLength(0);
	});

	test("negative integer", () => {
		const node = inspected(-7);
		expect(node.tag).toBe("+");
		expect(node.b64).toBe(-7);
		expect(node.size).toBe(0);
		expect(node.value).toBe(-7);
	});

	test("zero", () => {
		const node = inspected(0);
		expect(node.tag).toBe("+");
		expect(node.b64).toBe(0);
		expect(node.value).toBe(0);
	});

	test("float (decimal)", () => {
		const node = inspected(3.14);
		expect(node.tag).toBe("*");
		expect(typeof node.b64).toBe("number"); // exponent
		expect(node.size).toBeGreaterThan(0); // has integer child
		expect(node.value).toBeCloseTo(3.14);
		const children = childArray(node);
		expect(children).toHaveLength(1);
		expect(children[0].tag).toBe("+"); // integer base
	});

	test("string", () => {
		const node = inspected("hello");
		expect(node.tag).toBe(",");
		expect(node.b64).toBe(5); // byte length of "hello"
		expect(node.size).toBe(5);
		expect(node.value).toBe("hello");
	});

	test("ref builtins", () => {
		const n = inspected(null);
		expect(n.tag).toBe("'");
		expect(n.b64).toBe("n");
		expect(n.size).toBe(0);
		expect(n.value).toBe(null);

		const t = inspected(true);
		expect(t.tag).toBe("'");
		expect(t.b64).toBe("t");
		expect(t.value).toBe(true);

		const f = inspected(false);
		expect(f.tag).toBe("'");
		expect(f.b64).toBe("f");
		expect(f.value).toBe(false);

		const u = inspected(undefined);
		expect(u.tag).toBe("'");
		expect(u.b64).toBe("u");
		expect(u.value).toBe(undefined);
	});

	test("special floats", () => {
		const inf = inspected(Infinity);
		expect(inf.tag).toBe("'");
		expect(inf.b64).toBe("inf");
		expect(inf.value).toBe(Infinity);

		const ninf = inspected(-Infinity);
		expect(ninf.tag).toBe("'");
		expect(ninf.b64).toBe("nif");
		expect(ninf.value).toBe(-Infinity);

		const nan = inspected(NaN);
		expect(nan.tag).toBe("'");
		expect(nan.b64).toBe("nan");
		expect(nan.value).toBeNaN();
	});

	test("empty string", () => {
		const node = inspected("");
		expect(node.tag).toBe(",");
		expect(node.b64).toBe(0);
		expect(node.size).toBe(0);
		expect(node.value).toBe("");
	});
});

describe("inspect() containers", () => {
	test("empty array", () => {
		const node = inspected([]);
		expect(node.tag).toBe(";");
		expect(node.b64).toBe(0);
		expect(node.size).toBe(0);
		expect(childArray(node)).toHaveLength(0);
		expect((node.value as any).length).toBe(0);
	});

	test("simple array", () => {
		const node = inspected([1, 2, 3]);
		expect(node.tag).toBe(";");
		expect(node.size).toBeGreaterThan(0);
		const children = childArray(node);
		expect(children).toHaveLength(3);
		expect(children[0].tag).toBe("+");
		expect(children[0].b64).toBe(1);
		expect(children[1].b64).toBe(2);
		expect(children[2].b64).toBe(3);
	});

	test("empty object", () => {
		const node = inspected({});
		expect(node.tag).toBe(":");
		expect(node.b64).toBe(0);
		expect(node.size).toBe(0);
		expect(childArray(node)).toHaveLength(0);
	});

	test("simple object — interleaved key/value children", () => {
		const node = inspected({ a: 1 });
		expect(node.tag).toBe(":");
		const children = childArray(node);
		// Should have key and value as children
		expect(children.length).toBe(2);
		// First child (rightmost in buffer = key "a")
		expect(children[0].tag).toBe(","); // string key
		expect(children[0].value).toBe("a");
		// Second child = value 1
		expect(children[1].tag).toBe("+");
		expect(children[1].b64).toBe(1);
	});

	test("chain", () => {
		const node = inspected("/foo/bar/baz", { stringChainDelimiter: "/", stringChainThreshold: 0 });
		// Depending on dedup, might be a plain string or a chain
		if (node.tag === ".") {
			expect(node.size).toBeGreaterThan(0);
			const children = childArray(node);
			expect(children.length).toBeGreaterThan(0);
		}
	});
});

describe("inspect() indexed containers", () => {
	test("large array has # index child", () => {
		const arr = Array.from({ length: 50 }, (_, i) => i);
		const node = inspected(arr, { indexThreshold: 32 });
		expect(node.tag).toBe(";");
		const children = childArray(node);
		// First child should be the # index node
		const indexNode = children.find(c => c.tag === "#");
		expect(indexNode).toBeDefined();
		expect(typeof indexNode!.b64).toBe("object");
		const { count, width } = indexNode!.b64 as { count: number; width: number };
		expect(count).toBe(50);
		expect(width).toBeGreaterThanOrEqual(1);
		// Rest are element nodes
		const elements = children.filter(c => c.tag !== "#");
		expect(elements).toHaveLength(50);
	});

	test("large object has # index child", () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < 50; i++) obj[`key${String(i).padStart(3, "0")}`] = i;
		const node = inspected(obj, { indexThreshold: 32 });
		expect(node.tag).toBe(":");
		const children = childArray(node);
		const indexNode = children.find(c => c.tag === "#");
		expect(indexNode).toBeDefined();
	});
});

describe("inspect() pointers", () => {
	test("pointer node", () => {
		// Encode something that creates pointers (repeated values)
		const data = encode(["hello", "hello"]);
		const root = inspect(data);
		expect(root.tag).toBe(";");
		const children = childArray(root);
		// One should be a string, the other a pointer
		const ptr = children.find(c => c.tag === "^");
		const str = children.find(c => c.tag === ",");
		expect(ptr).toBeDefined();
		expect(str).toBeDefined();
		expect(ptr!.size).toBe(0);
		expect(typeof ptr!.b64).toBe("number"); // delta
		expect(ptr!.value).toBe("hello");
	});
});

describe("inspect() value resolution", () => {
	test("value matches open() for primitives", () => {
		expect(inspected(42).value).toBe(42);
		expect(inspected("hi").value).toBe("hi");
		expect(inspected(true).value).toBe(true);
		expect(inspected(null).value).toBe(null);
		expect(inspected(undefined).value).toBe(undefined);
	});

	test("value returns open() proxy for containers", () => {
		const node = inspected({ x: 1, y: 2 });
		const val = node.value as any;
		expect(val.x).toBe(1);
		expect(val.y).toBe(2);
	});

	test("value on array proxy", () => {
		const node = inspected([10, 20, 30]);
		const val = node.value as any;
		expect(val[0]).toBe(10);
		expect(val[1]).toBe(20);
		expect(val[2]).toBe(30);
		expect(val.length).toBe(3);
	});

	test("value with refs", () => {
		const myRef = { a: 1, b: 2 };
		const data = encode(myRef, { refs: { MYREF: myRef } });
		// The ref itself resolves to the original object
		const root = inspect(data, { MYREF: myRef });
		expect(root.value).toBe(myRef);
	});
});

describe("inspect() semantic utilities", () => {
	test("entries() on simple object", () => {
		const node = inspected({ x: 1, y: 2 });
		const entries = [...node.entries()];
		expect(entries).toHaveLength(2);
		// Keys should be string nodes
		expect(entries[0][0].value).toBe("x");
		expect(entries[0][1].value).toBe(1);
		expect(entries[1][0].value).toBe("y");
		expect(entries[1][1].value).toBe(2);
	});

	test("keys() on object", () => {
		const node = inspected({ a: 1, b: 2, c: 3 });
		const keys = [...node.keys()].map(k => k.value);
		expect(keys).toEqual(["a", "b", "c"]);
	});

	test("values() on object", () => {
		const node = inspected({ a: 10, b: 20 });
		const vals = [...node.values()].map(v => v.value);
		expect(vals).toEqual([10, 20]);
	});

	test("values() on array", () => {
		const node = inspected([10, 20, 30]);
		const vals = [...node.values()].map(v => v.value);
		expect(vals).toEqual([10, 20, 30]);
	});

	test("index() on array", () => {
		const node = inspected([10, 20, 30]);
		expect(node.index(0)?.value).toBe(10);
		expect(node.index(1)?.value).toBe(20);
		expect(node.index(2)?.value).toBe(30);
		expect(node.index(3)).toBeUndefined();
		expect(node.index(-1)).toBeUndefined();
	});

	test("index() on object", () => {
		const node = inspected({ foo: 1, bar: 2 });
		expect(node.index("foo")?.value).toBe(1);
		expect(node.index("bar")?.value).toBe(2);
		expect(node.index("baz")).toBeUndefined();
	});

	test("index() on large indexed array", () => {
		const arr = Array.from({ length: 50 }, (_, i) => i * 10);
		const node = inspected(arr, { indexThreshold: 32 });
		expect(node.index(0)?.value).toBe(0);
		expect(node.index(25)?.value).toBe(250);
		expect(node.index(49)?.value).toBe(490);
		expect(node.index(50)).toBeUndefined();
	});

	test("index() on large indexed object", () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < 50; i++) obj[`k${String(i).padStart(3, "0")}`] = i;
		const node = inspected(obj, { indexThreshold: 32 });
		expect(node.index("k000")?.value).toBe(0);
		expect(node.index("k025")?.value).toBe(25);
		expect(node.index("k049")?.value).toBe(49);
		expect(node.index("missing")).toBeUndefined();
	});

	test("filteredKeys() on indexed object", () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < 50; i++) obj[`k${String(i).padStart(3, "0")}`] = i;
		const node = inspected(obj, { indexThreshold: 32 });
		const matches = [...node.filteredKeys("k00")];
		// k000..k009 = 10 matches
		expect(matches).toHaveLength(10);
		expect(matches[0][0].value).toBe("k000");
		expect(matches[0][1].value).toBe(0);
	});

	test("filteredKeys() on non-indexed object", () => {
		const node = inspected({ apple: 1, apricot: 2, banana: 3 });
		const matches = [...node.filteredKeys("ap")];
		expect(matches).toHaveLength(2);
		const keys = matches.map(([k]) => k.value);
		expect(keys).toContain("apple");
		expect(keys).toContain("apricot");
	});
});

describe("inspect() lazy iteration", () => {
	test("partial children iteration", () => {
		const arr = Array.from({ length: 100 }, (_, i) => i);
		const node = inspected(arr, { indexThreshold: 32 });
		let count = 0;
		for (const _child of node) {
			count++;
			if (count >= 3) break;
		}
		expect(count).toBe(3);
	});

	test("data property is not in ownKeys", () => {
		const node = inspected(42);
		expect(Object.keys(node)).not.toContain("data");
		// But it's still accessible
		expect(node.data).toBeInstanceOf(Uint8Array);
	});
});

describe("inspect() schema objects", () => {
	test("entries() on schema object", () => {
		// Encode multiple objects with the same shape to trigger schema dedup
		const data = encode([
			{ name: "alice", age: 30 },
			{ name: "bob", age: 25 },
		]);
		const root = inspect(data);
		const children = [...root.values()];
		// Both should be object nodes
		expect(children[0].tag).toBe(":");
		expect(children[1].tag).toBe(":");
		// The second object should use a schema (pointer to first)
		// entries() should still work on both
		const e0 = [...children[0].entries()];
		const e1 = [...children[1].entries()];
		expect(e0).toHaveLength(2);
		expect(e1).toHaveLength(2);
		expect(e0[0][0].value).toBe("name");
		expect(e0[0][1].value).toBe("alice");
		expect(e1[0][0].value).toBe("name");
		expect(e1[0][1].value).toBe("bob");
	});
});

describe("inspect() array-like behavior", () => {
	test("numeric index access", () => {
		const node = inspected([10, 20, 30]);
		expect(node[0].tag).toBe("+");
		expect(node[0].b64).toBe(10);
		expect(node[1].b64).toBe(20);
		expect(node[2].b64).toBe(30);
		expect(node[3]).toBeUndefined();
	});

	test(".length returns child count", () => {
		const node = inspected([10, 20, 30]);
		expect(node.length).toBe(3);
	});

	test(".length on leaf node is 0", () => {
		const node = inspected(42);
		expect(node.length).toBe(0);
	});

	test("for...of iteration", () => {
		const node = inspected([1, 2, 3]);
		const values: number[] = [];
		for (const child of node) {
			values.push(child.b64 as number);
		}
		expect(values).toEqual([1, 2, 3]);
	});

	test("spread into array", () => {
		const node = inspected([1, 2, 3]);
		const arr = [...node];
		expect(arr).toHaveLength(3);
		expect(arr[0].b64).toBe(1);
	});

	test("incremental parsing — accessing [5] parses 0..5, not all", () => {
		// Use 10 elements (below INDEX_THRESHOLD) to avoid a # index child
		const arr = Array.from({ length: 10 }, (_, i) => i);
		const node = inspected(arr);
		// Access index 5 — should parse children 0-5
		const child5 = node[5];
		expect(child5!.b64).toBe(5);
		// Now access index 2 — should be cached, no re-parsing
		const child2 = node[2];
		expect(child2!.b64).toBe(2);
		// Access beyond — parses more
		const child8 = node[8];
		expect(child8!.b64).toBe(8);
	});
});

describe("inspect() JSON.stringify", () => {
	test("leaf node serializes with tag and b64", () => {
		const node = inspected(42);
		const json = JSON.parse(JSON.stringify(node));
		expect(json.tag).toBe("+");
		expect(json.b64).toBe(42);
		expect(json.left).toBeDefined();
		expect(json.right).toBeDefined();
	});

	test("container serializes with children array", () => {
		const node = inspected([1, 2, 3]);
		const json = JSON.parse(JSON.stringify(node));
		expect(json.tag).toBe(";");
		expect(json.children).toHaveLength(3);
		expect(json.children[0].tag).toBe("+");
		expect(json.children[0].b64).toBe(1);
		expect(json.children[1].b64).toBe(2);
		expect(json.children[2].b64).toBe(3);
	});

	test("nested structure serializes recursively", () => {
		const node = inspected({ items: [1, 2] });
		const json = JSON.parse(JSON.stringify(node));
		expect(json.tag).toBe(":");
		expect(json.children.length).toBeGreaterThan(0);
		// Should have nested children
		const arrChild = json.children.find((c: any) => c.tag === ";");
		expect(arrChild).toBeDefined();
		expect(arrChild.children).toHaveLength(2);
	});

	test("pointer serializes as leaf", () => {
		const data = encode(["hello", "hello"]);
		const root = inspect(data);
		const json = JSON.parse(JSON.stringify(root));
		const ptr = json.children.find((c: any) => c.tag === "^");
		expect(ptr).toBeDefined();
		expect(typeof ptr.b64).toBe("number");
		// Pointer has no children
		expect(ptr.children).toBeUndefined();
	});
});

// ── Regression: cursor corruption after strEquals/strHasPrefix/resolveKeyStr ──

describe("cursor corruption regressions", () => {
	// To trigger these bugs, keys must be encoded as pointers (^) — which
	// happens when the same string was already written as a value earlier.
	// We include key strings as values in an "_index" entry so the encoder
	// deduplicates the keys as pointers. 20+ keys ensures indexing is used.

	/** Build an indexed object whose keys are pointer-deduplicated.
	 *  The "_index" array contains the key strings as values so they're
	 *  written first; when the encoder later writes them as keys, it emits
	 *  pointer (^) nodes instead of inline strings. */
	function buildPointerKeyObject(keys: string[], valueFn: (k: string, i: number) => unknown) {
		const obj: Record<string, unknown> = {};
		for (let i = 0; i < keys.length; i++) obj[keys[i]!] = valueFn(keys[i]!, i);
		obj["_index"] = keys; // forces key strings to be written as values first
		return obj;
	}

	test("findKey on indexed object with pointer keys returns correct value", () => {
		const keys = Array.from({ length: 20 }, (_, i) => `/blog/post-${i}`);
		keys.push("/blog/[slug]");
		const obj = buildPointerKeyObject(keys, (k, i) =>
			k === "/blog/[slug]" ? { id: 99, content: "hello" } : { id: i });

		const data = encode(obj);
		const c = makeCursor(data);
		read(c);
		expect(c.ixWidth).toBeGreaterThan(0); // confirm indexed

		const v = makeCursor(data);
		expect(findKey(v, c, "/blog/[slug]")).toBe(true);
		expect(v.tag).toBe("object"); // value is an object, not a stray string
		const inner = makeCursor(data);
		expect(findKey(inner, v, "id")).toBe(true);
		expect(inner.val).toBe(99);
	});

	test("Proxy open() on indexed object with pointer keys", () => {
		const keys = Array.from({ length: 20 }, (_, i) => `/blog/post-${i}`);
		keys.push("/blog/[slug]");
		const obj = buildPointerKeyObject(keys, (k, i) =>
			k === "/blog/[slug]" ? { id: 42, content: "hello" } : { id: i });

		const data = encode(obj);
		const root = open(data) as Record<string, any>;

		expect(root["/blog/[slug]"]).toBeDefined();
		expect(root["/blog/[slug]"].id).toBe(42);
		expect(root["/blog/[slug]"].content).toBe("hello");
		expect(root["/blog/post-3"].id).toBe(3);
	});

	test("findByPrefix on indexed object with pointer keys returns correct values", () => {
		const keys = Array.from({ length: 20 }, (_, i) => `/api/route-${i}`);
		const obj = buildPointerKeyObject(keys, (_, i) => i);

		const data = encode(obj);
		const c = makeCursor(data);
		read(c);
		expect(c.ixWidth).toBeGreaterThan(0);

		const results: [string, number][] = [];
		const v = makeCursor(data);
		findByPrefix(v, c, "/api/route-", (key, value) => {
			results.push([resolveStr(key), value.val]);
		});
		expect(results).toHaveLength(20);
		for (let i = 0; i < 20; i++) {
			expect(results.find(([k]) => k === `/api/route-${i}`)?.[1]).toBe(i);
		}
	});

	test("filteredKeys on indexed inspect node with pointer keys", () => {
		const keys = Array.from({ length: 20 }, (_, i) => `/page/item-${i}`);
		const obj = buildPointerKeyObject(keys, (_, i) => i * 10);

		const data = encode(obj);
		const node = inspect(data);

		const matches = [...node.filteredKeys("/page/item-")];
		expect(matches).toHaveLength(20);
		for (const [keyNode, valNode] of matches) {
			const key = keyNode.value as string;
			expect(key).toMatch(/^\/page\/item-\d+$/);
			const idx = parseInt(key.replace("/page/item-", ""));
			expect(valNode.value).toBe(idx * 10);
		}
	});

	test("ensureKeyMap with array schema and pointer keys resolves correctly", () => {
		// Multiple objects sharing a schema with path-like keys.
		// The encoder deduplicates repeated key sets as schemas.
		const items = [];
		for (let i = 0; i < 4; i++) {
			items.push({ "/data/alpha": i, "/data/beta": i * 10, "/data/gamma": i * 100 });
		}

		const data = encode(items);
		const root = open(data) as any[];

		for (let i = 0; i < 4; i++) {
			expect(root[i]["/data/alpha"]).toBe(i);
			expect(root[i]["/data/beta"]).toBe(i * 10);
			expect(root[i]["/data/gamma"]).toBe(i * 100);
		}
	});
});
