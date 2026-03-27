import { encode } from "./rx";
import { encode as rxbEncode } from "./rxb";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

// ── Benchmark harness ──

function bench(name: string, fn: () => unknown, iterations = 100) {
  // Warmup
  for (let i = 0; i < 5; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  const p95 = times[Math.floor(times.length * 0.95)]!;
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(
    `  ${name.padEnd(30)} median=${median.toFixed(3)}ms  mean=${mean.toFixed(3)}ms  p95=${p95.toFixed(3)}ms`
  );
  return median;
}

// ── Generate synthetic datasets ──

function makeFlatObject(n: number): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    obj[`key-${i.toString(36)}-${Math.random().toString(36).slice(2, 10)}`] =
      i % 3 === 0
        ? `value-${i}-${"x".repeat(20 + (i % 50))}`
        : i % 3 === 1
          ? i * 1.1
          : i % 2 === 0;
  }
  return obj;
}

function makeRecordArray(n: number): unknown[] {
  const arr: unknown[] = [];
  for (let i = 0; i < n; i++) {
    arr.push({
      id: i,
      name: `User ${i}`,
      email: `user${i}@example.com`,
      active: i % 3 !== 0,
      score: Math.round(Math.random() * 10000) / 100,
      tags: ["alpha", "beta", "gamma"].slice(0, (i % 3) + 1),
      meta: { created: `2025-01-${(i % 28 + 1).toString().padStart(2, "0")}`, version: i % 5 },
    });
  }
  return arr;
}

function makeDeepNested(depth: number, breadth: number): unknown {
  if (depth === 0) return `leaf-${Math.random().toString(36).slice(2, 8)}`;
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < breadth; i++) {
    obj[`d${depth}-b${i}`] = makeDeepNested(depth - 1, breadth);
  }
  return obj;
}

function makePathObject(n: number): Record<string, string> {
  const segments = ["api", "v1", "v2", "users", "posts", "comments", "auth", "static", "assets", "img", "css", "js", "chunks", "media"];
  const obj: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const parts: string[] = [];
    const len = 3 + (i % 5);
    for (let j = 0; j < len; j++) {
      parts.push(segments[(i * 7 + j * 13) % segments.length]!);
    }
    parts.push(`file-${i.toString(36)}.${i % 2 === 0 ? "js" : "css"}`);
    obj["/" + parts.join("/")] = `content-${i}-${"z".repeat(10 + (i % 30))}`;
  }
  return obj;
}

// ── Run benchmarks ──

interface Dataset {
  name: string;
  data: unknown;
}

const datasets: Dataset[] = [
  { name: "flat-1k", data: makeFlatObject(1000) },
  { name: "flat-10k", data: makeFlatObject(10_000) },
  { name: "records-1k", data: makeRecordArray(1000) },
  { name: "records-10k", data: makeRecordArray(10_000) },
  { name: "deep-6x4", data: makeDeepNested(6, 4) },
  { name: "paths-5k", data: makePathObject(5000) },
];

// Load real sample files
const samplesDir = join(import.meta.dirname!, "samples");
for (const file of readdirSync(samplesDir).filter((f) => f.endsWith(".json"))) {
  const raw = readFileSync(join(samplesDir, file), "utf-8");
  datasets.push({ name: `file:${file}`, data: JSON.parse(raw) });
}

// Load large JSON sample if present
const largeSamplePath = join(import.meta.dirname!, "large-sample.json");
if (existsSync(largeSamplePath)) {
  console.log("Loading large-sample.json...");
  const data = JSON.parse(readFileSync(largeSamplePath, "utf-8"));
  console.log("Done.\n");
  datasets.push({ name: "large-sample", data });
}

console.log("=== RX / RXB Encode Benchmark ===\n");

for (const { name, data } of datasets) {
  const jsonStr = JSON.stringify(data);
  const jsonBytes = Buffer.byteLength(jsonStr, "utf-8");
  const iters = jsonBytes > 10_000_000 ? 5 : jsonBytes > 500_000 ? 50 : 200;

  console.log(`\n── ${name} (JSON: ${(jsonBytes / 1024).toFixed(1)} KB) ──`);
  bench("JSON.stringify", () => JSON.stringify(data), iters);

  const rxBytes = encode(data);
  const rxSize = `${(rxBytes.length / 1024).toFixed(1)} KB`;
  bench(`rx encode`.padEnd(24) + ` [${rxSize}]`, () => encode(data), iters);

  const rxbBytes = rxbEncode(data);
  const rxbSize = `${(rxbBytes.length / 1024).toFixed(1)} KB`;
  bench(`rxb encode`.padEnd(24) + `[${rxbSize}]`, () => rxbEncode(data), iters);
}
