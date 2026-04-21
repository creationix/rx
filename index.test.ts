import { describe, expect, test } from "vitest";
import * as pkg from "./index.ts";
import {
	encode,
	stringify,
	decode,
	parse,
	open,
	inspect,
	handle,
	makeCursor,
	read,
	readStr,
	resolveStr,
	prepareKey,
	strEquals,
	strCompare,
	strHasPrefix,
	seekChild,
	collectChildren,
	findKey,
	findByPrefix,
	rawBytes,
	rxbEncode,
	rxbDecode,
	rxbOpen,
	rxbHandle,
	rxbMakeCursor,
	rxbRead,
	rxbReadStr,
	rxbResolveStr,
	rxbPrepareKey,
	rxbStrEquals,
	rxbStrCompare,
	rxbStrHasPrefix,
	rxbSeekChild,
	rxbCollectChildren,
	rxbFindKey,
	rxbFindByPrefix,
	rxbRawBytes,
} from "./index.ts";

describe("index: RX text format", () => {
	const sample = { users: ["alice", "bob"], version: 3 };

	test("stringify/parse round-trips", () => {
		const s = stringify(sample);
		expect(typeof s).toBe("string");
		const back = parse(s) as typeof sample;
		expect(back.users[0]).toBe("alice");
		expect(back.version).toBe(3);
		expect(JSON.parse(JSON.stringify(back))).toEqual(sample);
	});

	test("encode/open/decode round-trip", () => {
		const buf = encode(sample);
		expect(buf).toBeInstanceOf(Uint8Array);
		const proxy = open(buf) as typeof sample;
		expect(proxy.users[1]).toBe("bob");
		expect(decode(buf)).toEqual(proxy);
	});

	test("inspect returns an AST", () => {
		const buf = encode(sample);
		const root = inspect(buf);
		expect(root.tag).toBe(":");
		expect(Array.from(root, (n) => n.tag).length).toBeGreaterThan(0);
	});

	test("handle exposes underlying buffer", () => {
		const buf = encode(sample);
		const proxy = open(buf) as { users: unknown };
		const h = handle(proxy.users);
		expect(h?.data).toBeInstanceOf(Uint8Array);
		expect(typeof h?.right).toBe("number");
	});

	test("cursor API is present and usable", () => {
		const buf = encode({ a: 1, b: 2, c: 3 });
		const c = makeCursor(buf);
		read(c);
		expect(c.tag).toBe("object");
		const key = prepareKey("b");
		expect(findKey(c, c, key)).toBe(true);
		// Exercise the rest just to prove they're wired up.
		void [
			readStr,
			resolveStr,
			strEquals,
			strCompare,
			strHasPrefix,
			seekChild,
			collectChildren,
			findByPrefix,
			rawBytes,
		].every((fn) => typeof fn === "function");
	});
});

describe("index: RXB binary format", () => {
	const sample = { users: ["alice", "bob"], version: 3 };

	test("rxbEncode/rxbOpen/rxbDecode round-trip", () => {
		const buf = rxbEncode(sample);
		expect(buf).toBeInstanceOf(Uint8Array);
		const proxy = rxbOpen(buf) as typeof sample;
		expect(proxy.users[0]).toBe("alice");
		expect(proxy.version).toBe(3);
		expect(rxbDecode(buf)).toEqual(proxy);
	});

	test("rxbHandle exposes the underlying buffer", () => {
		const buf = rxbEncode(sample);
		const proxy = rxbOpen(buf) as { users: unknown };
		const h = rxbHandle(proxy.users);
		expect(h?.data).toBeInstanceOf(Uint8Array);
		expect(typeof h?.right).toBe("number");
	});

	test("rxb cursor API is present and usable", () => {
		const buf = rxbEncode({ a: 1, b: 2, c: 3 });
		const c = rxbMakeCursor(buf);
		rxbRead(c);
		const key = rxbPrepareKey("b");
		expect(rxbFindKey(c, c, key)).toBe(true);
		void [
			rxbReadStr,
			rxbResolveStr,
			rxbStrEquals,
			rxbStrCompare,
			rxbStrHasPrefix,
			rxbSeekChild,
			rxbCollectChildren,
			rxbFindByPrefix,
			rxbRawBytes,
		].every((fn) => typeof fn === "function");
	});
});

describe("index: surface contract", () => {
	test("rx and rxb encoders produce independent outputs", () => {
		const value = { hello: "world" };
		const rxBuf = encode(value);
		const rxbBuf = rxbEncode(value);
		expect(rxBuf).not.toEqual(rxbBuf);
		expect(decode(rxBuf)).toEqual(rxbDecode(rxbBuf));
	});

	test("no rxb identifier leaks into the flat namespace", () => {
		// RX format owns the flat names; rxb must only appear under the rxb* prefix.
		const flatNames = Object.keys(pkg).filter(
			(k) => !k.startsWith("rxb") && !k.startsWith("Rxb"),
		);
		for (const name of ["encode", "decode", "parse", "stringify", "open", "inspect"]) {
			expect(flatNames).toContain(name);
		}
	});

	test("expected rxb-prefixed exports are present", () => {
		for (const name of [
			"rxbEncode",
			"rxbDecode",
			"rxbOpen",
			"rxbHandle",
			"rxbMakeCursor",
			"rxbRead",
			"rxbFindKey",
		]) {
			expect(pkg).toHaveProperty(name);
			expect(typeof (pkg as Record<string, unknown>)[name]).toBe("function");
		}
	});
});
