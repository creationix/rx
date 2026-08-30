// Core round-trip tests for the new RX format.
// The cursor-based reader and rxb format have been removed; if you need to
// re-add those, restore the corresponding test suites.

import { describe, expect, test } from "vitest";
import { stringify } from "./rx.ts";
import { parse } from "./rx-read.ts";

function roundTrip(value: unknown) {
	const encoded = stringify(value);
	const decoded = parse(encoded);
	return { encoded, decoded };
}

describe("round-trip primitives", () => {
	test("integers", () => {
		for (const v of [0, 1, -1, 42, -256, 1000000, -1000000]) {
			const { decoded } = roundTrip(v);
			expect(decoded).toBe(v);
		}
	});

	test("floats", () => {
		for (const v of [3.14, -0.5, 1e6, 1.5]) {
			const { decoded } = roundTrip(v);
			expect(decoded).toBeCloseTo(v as number);
		}
	});

	test("special floats", () => {
		expect(roundTrip(Infinity).decoded).toBe(Infinity);
		expect(roundTrip(-Infinity).decoded).toBe(-Infinity);
		expect(Number.isNaN(roundTrip(NaN).decoded as number)).toBe(true);
	});

	test("strings", () => {
		for (const v of ["", "hi", "hello world", "café", "🎉", "with \"quotes\""]) {
			const { decoded } = roundTrip(v);
			expect(decoded).toBe(v);
		}
	});

	test("booleans and null", () => {
		expect(roundTrip(true).decoded).toBe(true);
		expect(roundTrip(false).decoded).toBe(false);
		expect(roundTrip(null).decoded).toBe(null);
	});
});

describe("round-trip arrays", () => {
	test("empty", () => {
		expect(roundTrip([]).decoded).toEqual([]);
	});

	test("flat int array", () => {
		expect(roundTrip([1, 2, 3]).decoded).toEqual([1, 2, 3]);
	});

	test("mixed types", () => {
		const v = [1, "hello", true, null, 3.14];
		expect(roundTrip(v).decoded).toEqual(v);
	});

	test("nested arrays", () => {
		const v = [[1, 2], [3, 4], [[5]]];
		expect(roundTrip(v).decoded).toEqual(v);
	});

	test("large indexed array", () => {
		const v = Array.from({ length: 100 }, (_, i) => i);
		const { decoded } = roundTrip(v);
		// Indexed arrays return a Proxy; check via explicit lookups + iteration
		expect((decoded as number[])[0]).toBe(0);
		expect((decoded as number[])[99]).toBe(99);
		expect((decoded as number[]).length).toBe(100);
	});
});

describe("round-trip objects", () => {
	test("empty", () => {
		expect(roundTrip({}).decoded).toEqual({});
	});

	test("flat object", () => {
		const v = { a: 1, b: 2 };
		expect(roundTrip(v).decoded).toEqual(v);
	});

	test("preserves insertion order", () => {
		const v = { z: 1, a: 2, m: 3 };
		const { decoded } = roundTrip(v);
		expect(Object.keys(decoded as object)).toEqual(["z", "a", "m"]);
	});

	test("nested object", () => {
		const v = { outer: { inner: { value: 42 } } };
		expect(roundTrip(v).decoded).toEqual(v);
	});

	test("schema-shared records", () => {
		const v = [
			{ a: 1, b: 2 },
			{ a: 3, b: 4 },
			{ a: 5, b: 6 },
		];
		expect(roundTrip(v).decoded).toEqual(v);
	});
});

describe("round-trip mixed", () => {
	test("realistic site manifest shape", () => {
		const v = {
			version: "1.0",
			routes: [
				{ path: "/api", action: "proxy" },
				{ path: "/static", action: "serve" },
			],
			flags: { cache: true, compress: true },
		};
		expect(roundTrip(v).decoded).toEqual(v);
	});

	test("path-keyed routes table", () => {
		const v: Record<string, { hash: string; size: number }> = {};
		for (let i = 0; i < 50; i++) {
			v[`/path/${i}`] = { hash: `h${i.toString(16)}`, size: i * 1000 };
		}
		const { decoded } = roundTrip(v);
		// Spot-check a few keys
		expect((decoded as any)["/path/0"]).toEqual({ hash: "h0", size: 0 });
		expect((decoded as any)["/path/49"]).toEqual({ hash: "h31", size: 49000 });
	});
});

describe("encoder options", () => {
	test("minIndexDepth=1 forces root index, blocks nested", () => {
		const v = { a: 1, b: { c: 2, d: 3, e: 4, f: 5, g: 6, h: 7 } };
		// With both depths set to 1: only root has an index, nothing nested
		const out = stringify(v, { minIndexDepth: 1, maxIndexDepth: 1 });
		const decoded = parse(out);
		expect(decoded).toEqual(v);
		// Root should have a `#` index tag near the end (rough sanity check)
		expect(out.includes("#")).toBe(true);
	});
});
