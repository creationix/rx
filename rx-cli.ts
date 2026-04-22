import {
	stringify, encode,
	tune,
	INDEX_THRESHOLD, STRING_CHAIN_THRESHOLD, STRING_CHAIN_DELIMITER, DEDUP_COMPLEXITY_LIMIT,
} from "./rx.ts";
import {
	open, inspect,
	makeCursor, read,
} from "./rx-read.ts";
import { encode as rxbEncode } from "./rxb.ts";
import { open as rxbOpen } from "./rxb-read.ts";
import { readdirSync } from "node:fs";
import { readFile, writeFile, mkdir, unlink, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename, extname } from "node:path";
import pkg from "./package.json" with { type: "json" };

const VERSION = pkg.version;

// ── Theme ────────────────────────────────────────────────────────────────────
// Semantic color tags interpolated into template strings.
// Reset to empty when color is off.

let tStr = "", tNum = "", tBool = "", tNull = "", tKey = "";
let tCmd = "", tArg = "", tDesc = "", tH1 = "", tH2 = "", tDim = "", tR = "";

function applyTheme(color: boolean) {
	if (!color) {
		tStr = tNum = tBool = tNull = tKey = "";
		tCmd = tArg = tDesc = tH1 = tH2 = tDim = tR = "";
		return;
	}
	const term = process.env.TERM ?? "";
	const ct = process.env.COLORTERM ?? "";
	const rich = term.includes("256color") || ct === "truecolor" || ct === "24bit";
	if (rich) {
		tStr = "\x1b[38;5;150m";  tNum = "\x1b[38;5;209m"; tBool = "\x1b[38;5;141m";
		tNull = "\x1b[38;5;60m";  tKey = "\x1b[38;5;39m";  tCmd = "\x1b[38;5;117m";
		tArg = "\x1b[38;5;179m";  tDesc = "\x1b[38;5;146m"; tH1 = "\x1b[1;38;5;189m";
		tH2 = "\x1b[4m";          tDim = "\x1b[38;5;60m";
	} else {
		tStr = "\x1b[32m";  tNum = "\x1b[33m";  tBool = "\x1b[33m";
		tNull = "\x1b[90m"; tKey = "\x1b[35m";  tCmd = "\x1b[34;1m";
		tArg = "\x1b[33m";  tDesc = "\x1b[37m"; tH1 = "\x1b[1;37m";
		tH2 = "\x1b[4m";    tDim = "\x1b[2m";
	}
	tR = "\x1b[0m";
}

// ── Formats & detection ──────────────────────────────────────────────────────

type Format = "json" | "rx" | "rxb";
type OutputFormat = Format | "tree";

const VALID_FORMATS: readonly OutputFormat[] = ["json", "rx", "rxb", "tree"] as const;

function formatFromExt(path: string): Format | undefined {
	if (path.endsWith(".json")) return "json";
	if (path.endsWith(".rx")) return "rx";
	if (path.endsWith(".rxb")) return "rxb";
	return undefined;
}

// Content-based format detection for stdin / unknown extensions.
function detectFormat(bytes: Uint8Array): Format {
	if (bytes.length === 0) return "rx";
	// rxb starts with a tag byte < 0x20 (control range) that JSON/rx never produce as first byte.
	const first = bytes[0]!;
	if (first < 0x20 && first !== 0x09 && first !== 0x0a && first !== 0x0d) return "rxb";
	// Try parsing as rx; if it consumes all bytes, it's rx.
	try {
		const trimmed = trimWhitespace(bytes);
		const c = makeCursor(trimmed);
		read(c);
		if (c.left === 0) return "rx";
	} catch { /* not rx */ }
	return "json";
}

function trimWhitespace(bytes: Uint8Array): Uint8Array {
	let start = 0, end = bytes.length;
	while (start < end && (bytes[start]! === 0x20 || bytes[start]! === 0x09 || bytes[start]! === 0x0a || bytes[start]! === 0x0d)) start++;
	while (end > start && (bytes[end - 1]! === 0x20 || bytes[end - 1]! === 0x09 || bytes[end - 1]! === 0x0a || bytes[end - 1]! === 0x0d)) end--;
	return start === 0 && end === bytes.length ? bytes : bytes.subarray(start, end);
}

// ── Input reading ────────────────────────────────────────────────────────────

async function readStdinBytes(): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return new Uint8Array(Buffer.concat(chunks));
}

function stripJsonComments(s: string): string {
	let out = "", i = 0;
	while (i < s.length) {
		if (s[i] === '"') {
			const start = i++;
			while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
			out += s.slice(start, ++i);
		} else if (s[i] === '/' && s[i + 1] === '/') {
			i += 2; while (i < s.length && s[i] !== '\n') i++;
		} else if (s[i] === '/' && s[i + 1] === '*') {
			i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
			i += 2;
		} else {
			out += s[i++];
		}
	}
	return out;
}

type ParsedInput = {
	value: unknown;
	inputFormat: Format;
	rxBytes?: Uint8Array;   // present when input was rx
	rxbBytes?: Uint8Array;  // present when input was rxb
};

function parseBytes(bytes: Uint8Array, format: Format): ParsedInput {
	if (format === "rxb") return { value: rxbOpen(bytes), inputFormat: "rxb", rxbBytes: bytes };
	if (format === "rx") {
		const trimmed = trimWhitespace(bytes);
		return { value: open(trimmed), inputFormat: "rx", rxBytes: trimmed };
	}
	const text = new TextDecoder().decode(bytes);
	return { value: JSON.parse(stripJsonComments(text)), inputFormat: "json" };
}

// Read and parse a single source. `source` is a file path or "-" for stdin.
// `forcedFormat` overrides ext/content detection.
async function readSource(source: string, forcedFormat?: Format): Promise<ParsedInput> {
	let bytes: Uint8Array;
	if (source === "-") {
		bytes = await readStdinBytes();
		if (bytes.length === 0) throw new Error("stdin is empty");
	} else {
		bytes = new Uint8Array(await readFile(source));
	}
	const format = forcedFormat ?? (source === "-" ? detectFormat(bytes) : formatFromExt(source) ?? detectFormat(bytes));
	return parseBytes(bytes, format);
}

// ── Tree pretty-printer ──────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	const p = Object.getPrototypeOf(v);
	return p === Object.prototype || p === null;
}

function isBareKey(k: string): boolean { return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k); }

function fmtKey(k: string): string {
	if (isBareKey(k)) return k;
	if (k !== "" && String(Number(k)) === k && Number.isFinite(Number(k))) return k;
	return JSON.stringify(k);
}

function fmtInline(v: unknown): string {
	if (v === undefined) return "undefined";
	if (v === null) return "null";
	if (typeof v === "boolean") return String(v);
	if (typeof v === "number") {
		if (Number.isNaN(v)) return "nan";
		if (v === Infinity) return "inf";
		if (v === -Infinity) return "-inf";
		return String(v);
	}
	if (typeof v === "string") return JSON.stringify(v);
	if (Array.isArray(v)) {
		if (v.length === 0) return "[]";
		let s = "[ ";
		for (let i = 0; i < v.length; i++) s += (i ? " " : "") + fmtInline(v[i]);
		return s + " ]";
	}
	if (isObj(v)) {
		const ks = Object.keys(v);
		if (ks.length === 0) return "{}";
		let s = "{ ";
		for (let i = 0; i < ks.length; i++) {
			if (i) s += " ";
			s += fmtKey(ks[i]!) + ": " + fmtInline(v[ks[i]!]);
		}
		return s + " }";
	}
	return String(v);
}

function fmtPretty(v: unknown, depth: number, ind: number, maxW: number): string {
	if (v === undefined || v === null || typeof v !== "object") return fmtInline(v);
	const budget = maxW - depth * ind;
	if (Array.isArray(v)) {
		if (v.length === 0) return "[]";
		let s = "[ ", ok = true;
		for (let i = 0; i < v.length; i++) {
			if (typeof v[i] === "object" && v[i] !== null) { ok = false; break; }
			s += (i ? " " : "") + fmtInline(v[i]);
			if (s.length > budget) { ok = false; break; }
		}
		if (ok) { s += " ]"; if (s.length <= budget) return s; }
		const pad = " ".repeat(depth * ind), cp = " ".repeat((depth + 1) * ind);
		let r = "[\n";
		for (let i = 0; i < v.length; i++) {
			if (i) r += "\n";
			r += cp + fmtPretty(v[i], depth + 1, ind, maxW);
		}
		return r + "\n" + pad + "]";
	}
	if (isObj(v)) {
		const ks = Object.keys(v);
		if (ks.length === 0) return "{}";
		let s = "{ ", ok = true;
		for (const k of ks) {
			if (typeof v[k] === "object" && v[k] !== null) { ok = false; break; }
			if (s.length > 2) s += " ";
			s += fmtKey(k) + ": " + fmtInline(v[k]);
			if (s.length > budget) { ok = false; break; }
		}
		if (ok) { s += " }"; if (s.length <= budget) return s; }
		const pad = " ".repeat(depth * ind), cp = " ".repeat((depth + 1) * ind);
		let r = "{\n", first = true;
		for (const k of ks) {
			if (!first) r += "\n";
			first = false;
			r += cp + fmtKey(k) + ": " + fmtPretty(v[k], depth + 1, ind, maxW);
		}
		return r + "\n" + pad + "}";
	}
	return fmtInline(v);
}

function treeStringify(value: unknown, width: number): string {
	return fmtPretty(value, 0, 2, width);
}

// ── Syntax highlighting ──────────────────────────────────────────────────────

function highlightTree(line: string): string {
	let result = "", i = 0;
	const len = line.length;
	while (i < len) {
		if (line[i] === " " || line[i] === "\t") { result += line[i]; i++; continue; }
		const km = line.slice(i).match(/^([A-Za-z_][A-Za-z0-9_-]*|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\]|\\.)*")(\s*:)/);
		if (km) { result += tKey + km[1] + tR + km[2]; i += km[0].length; continue; }
		if (line[i] === '"') {
			const m = line.slice(i).match(/^"(?:[^"\\]|\\.)*"/);
			if (m) { result += tStr + m[0] + tR; i += m[0].length; continue; }
		}
		const bl = line.slice(i).match(/^(?:true|false)\b/);
		if (bl) { result += tBool + bl[0] + tR; i += bl[0].length; continue; }
		const nl = line.slice(i).match(/^(?:null|undefined|nan|-?inf)\b/);
		if (nl) { result += tNull + nl[0] + tR; i += nl[0].length; continue; }
		const nm = line.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?=[\s\]\}]|$)/);
		if (nm) { result += tNum + nm[0] + tR; i += nm[0].length; continue; }
		result += line[i]; i++;
	}
	return result;
}

const JSON_RE = /(?<key>"(?:[^"\\]|\\.)*")\s*:|(?<string>"(?:[^"\\]|\\.)*")|(?<number>-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|(?<bool>true|false)|(?<null>null)/g;

function highlightJSON(json: string): string {
	let result = "", last = 0;
	JSON_RE.lastIndex = 0;
	for (const m of json.matchAll(JSON_RE)) {
		result += json.slice(last, m.index);
		const g = m.groups!;
		if (g.key) result += tKey + g.key + tR + ":";
		else if (g.string) result += tStr + m[0] + tR;
		else if (g.number) result += tNum + m[0] + tR;
		else if (g.bool) result += tBool + m[0] + tR;
		else if (g.null) result += tNull + m[0] + tR;
		else result += m[0];
		last = m.index! + m[0].length;
	}
	return result + json.slice(last);
}

// ── Output formatting ────────────────────────────────────────────────────────

function normalizeForJson(value: unknown, inArray: boolean): unknown {
	if (value === undefined) return inArray ? null : undefined;
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(v => normalizeForJson(v, true));
	const obj = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		const n = normalizeForJson(obj[key], false);
		if (n !== undefined) out[key] = n;
	}
	return out;
}

// Render `value` in the requested format, returning bytes to write.
function render(value: unknown, format: OutputFormat, color: boolean, width: number): Uint8Array {
	if (format === "rxb") return rxbEncode(value);
	if (format === "rx") return new TextEncoder().encode(stringify(value) + "\n");
	if (format === "json") {
		const text = JSON.stringify(normalizeForJson(value, false), null, 2) ?? "null";
		return new TextEncoder().encode((color ? highlightJSON(text) : text) + "\n");
	}
	// tree
	const text = treeStringify(value, width);
	const finalText = color ? text.split("\n").map(highlightTree).join("\n") : text;
	return new TextEncoder().encode(finalText + "\n");
}

// ── Output format resolution ─────────────────────────────────────────────────
// Priority: explicit --format / -f > RX_FORMAT env > TTY default (tree/json).

function resolveOutputFormat(flag: OutputFormat | undefined, isTTY: boolean): OutputFormat {
	if (flag) return flag;
	const env = process.env.RX_FORMAT;
	if (env) {
		if (!VALID_FORMATS.includes(env as OutputFormat)) {
			throw new Error(`RX_FORMAT=${env} not recognized (expected one of: ${VALID_FORMATS.join(", ")})`);
		}
		return env as OutputFormat;
	}
	return isTTY ? "tree" : "json";
}

// Priority: --no-color > --color > NO_COLOR env > TTY.
function resolveColor(flag: boolean | undefined, isTTY: boolean): boolean {
	if (flag !== undefined) return flag;
	if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
	return isTTY;
}

// ── Error helpers ────────────────────────────────────────────────────────────

class CliError extends Error {
	constructor(public subcmd: string, message: string, public suggestion?: string) {
		super(message);
	}
}

function fail(subcmd: string, message: string, suggestion?: string): never {
	throw new CliError(subcmd, message, suggestion);
}

// Levenshtein distance for subcommand/option typo suggestion
function editDistance(a: string, b: string): number {
	const m = a.length, n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const prev = new Array<number>(n + 1);
	const curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
		}
		for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
	}
	return prev[n]!;
}

function suggest(word: string, candidates: readonly string[]): string | undefined {
	let best: string | undefined, bestDist = Infinity;
	for (const c of candidates) {
		const d = editDistance(word, c);
		if (d < bestDist && d <= Math.max(2, Math.floor(c.length / 3))) { best = c; bestDist = d; }
	}
	return best;
}

// ── Parse helpers shared by subcommand parsers ───────────────────────────────

function parseFormatFlag(v: string | undefined, flag: string, subcmd: string): OutputFormat {
	if (!v) fail(subcmd, `${flag} requires a value`, `example: ${flag} json`);
	if (!VALID_FORMATS.includes(v as OutputFormat)) {
		fail(subcmd, `${flag} value '${v}' not recognized`, `expected one of: ${VALID_FORMATS.join(" | ")}`);
	}
	return v as OutputFormat;
}

function parseInputFormatFlag(v: string | undefined, flag: string, subcmd: string): Format {
	if (!v) fail(subcmd, `${flag} requires a value`, `example: ${flag} json`);
	if (v !== "json" && v !== "rx" && v !== "rxb") {
		fail(subcmd, `${flag} value '${v}' not recognized`, `expected one of: json | rx | rxb`);
	}
	return v;
}

function parseIntFlag(v: string | undefined, flag: string, subcmd: string): number {
	if (!v) fail(subcmd, `${flag} requires a value`, `example: ${flag} 16`);
	const n = Number(v);
	if (!Number.isInteger(n) || n < 0) fail(subcmd, `${flag} must be a non-negative integer (got '${v}')`);
	return n;
}

// ── Subcommand: show ─────────────────────────────────────────────────────────

function helpShow(): string {
	return `
${tH1}rx show${tR} — pretty-print a file.

${tH2}USAGE${tR}
  ${tCmd}rx show${tR} [${tArg}FILE${tR} | ${tArg}-${tR}]
  ${tCmd}rx${tR} ${tArg}FILE${tR}                            ${tDesc}# shortcut for ${tCmd}rx show FILE${tR}

${tH2}ARGUMENTS${tR}
  ${tArg}FILE${tR}                              Path to .json, .rx, or .rxb. Use ${tArg}-${tR} for stdin.
                                    Format auto-detected by extension then by content.

${tH2}OPTIONS${tR}
  ${tCmd}-f${tR}, ${tCmd}--format${tR} ${tArg}FMT${tR}                  Output format: ${tArg}tree${tR} | ${tArg}json${tR} | ${tArg}rx${tR} | ${tArg}rxb${tR}
  ${tCmd}-w${tR}, ${tCmd}--width${tR} ${tArg}N${tR}                     Target line width for tree output ${tDim}(default: 80)${tR}
  ${tCmd}-c${tR}, ${tCmd}--color${tR}                         Force ANSI color
      ${tCmd}--no-color${tR}                      Disable color
  ${tCmd}-o${tR}, ${tCmd}--output${tR} ${tArg}PATH${tR}                 Write to PATH instead of stdout
  ${tCmd}-h${tR}, ${tCmd}--help${tR}                          Show this help

${tH2}DEFAULTS${tR}
  Format: ${tArg}tree${tR} when stdout is a terminal, ${tArg}json${tR} when piped or redirected.
          Override with ${tCmd}-f${tR} or set ${tArg}RX_FORMAT${tR} env var.
  Color:  on when stdout is a terminal, off otherwise. ${tArg}NO_COLOR${tR} env disables.

${tH2}EXAMPLES${tR}
  ${tCmd}rx show${tR} ${tArg}data.rx${tR}
  ${tCmd}rx${tR} ${tArg}data.rx${tR}                         ${tDesc}# same thing${tR}
  ${tCmd}cat${tR} ${tArg}data.rx${tR} | ${tCmd}rx${tR}                   ${tDesc}# from stdin${tR}
  ${tCmd}rx show${tR} ${tArg}data.json${tR} ${tCmd}-f rx${tR}            ${tDesc}# JSON file displayed in rx text${tR}
  ${tCmd}rx show${tR} ${tArg}data.rx${tR} ${tCmd}-w${tR} ${tArg}120${tR}             ${tDesc}# wider terminal layout${tR}
  ${tCmd}rx show${tR} ${tArg}data.rx${tR} ${tCmd}--no-color${tR} ${tCmd}-o${tR} ${tArg}view.txt${tR}
`;
}

type ShowOpts = {
	file: string;
	format?: OutputFormat;
	width: number;
	color?: boolean;
	output?: string;
};

function parseShowArgs(argv: string[]): ShowOpts {
	const opts: ShowOpts = { file: "", width: 80 };
	let gotFile = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-h" || arg === "--help") { process.stdout.write(helpShow()); process.exit(0); }
		if (arg === "-c" || arg === "--color") { opts.color = true; continue; }
		if (arg === "--no-color") { opts.color = false; continue; }
		if (arg === "-f" || arg === "--format") { opts.format = parseFormatFlag(argv[++i], arg, "show"); continue; }
		if (arg === "-w" || arg === "--width") { opts.width = parseIntFlag(argv[++i], arg, "show"); continue; }
		if (arg === "-o" || arg === "--output") {
			const v = argv[++i]; if (!v) fail("show", `${arg} requires a value`, `example: ${arg} out.txt`);
			opts.output = v; continue;
		}
		if (arg === "-") { if (gotFile) fail("show", "takes only one input"); opts.file = "-"; gotFile = true; continue; }
		if (arg.startsWith("-")) fail("show", `unknown option: ${arg}`, `run 'rx show --help' for usage`);
		if (gotFile) fail("show", "takes only one input", `for batch, use shell: for f in *.rx; do rx show "$f"; done`);
		opts.file = arg; gotFile = true;
	}
	if (!gotFile) opts.file = process.stdin.isTTY ? "" : "-";
	return opts;
}

async function runShow(argv: string[]): Promise<void> {
	const opts = parseShowArgs(argv);
	if (!opts.file) { process.stdout.write(helpShow()); process.exit(0); }
	const isTTY = opts.output ? false : (process.stdout.isTTY ?? false);
	const color = resolveColor(opts.color, isTTY);
	const format = resolveOutputFormat(opts.format, isTTY);
	applyTheme(color);
	const parsed = await readSource(opts.file);
	const bytes = render(parsed.value, format, color && format !== "rxb", opts.width);
	if (opts.output) await writeFile(opts.output, bytes);
	else process.stdout.write(bytes);
}

// ── Subcommand: convert ──────────────────────────────────────────────────────

function helpConvert(): string {
	return `
${tH1}rx convert${tR} — convert between JSON, rx, and rxb formats.

${tH2}USAGE${tR}
  ${tCmd}rx convert${tR} ${tArg}SRC${tR} ${tArg}DST${tR}
  ${tCmd}rx convert${tR} ${tArg}-${tR} ${tArg}DST${tR} [${tCmd}--from${tR} ${tArg}FMT${tR}]
  ${tCmd}rx convert${tR} ${tArg}SRC${tR} ${tArg}-${tR} ${tCmd}--to${tR} ${tArg}FMT${tR}
  ${tCmd}rx convert${tR} ${tArg}-${tR} ${tArg}-${tR} ${tCmd}--from${tR} ${tArg}FMT${tR} ${tCmd}--to${tR} ${tArg}FMT${tR}

${tH2}ARGUMENTS${tR}
  ${tArg}SRC${tR}                               Input path, or ${tArg}-${tR} for stdin
  ${tArg}DST${tR}                               Output path, or ${tArg}-${tR} for stdout

  Extension determines format: ${tArg}.json${tR}, ${tArg}.rx${tR}, ${tArg}.rxb${tR}.
  When either side is ${tArg}-${tR}, pass ${tCmd}--from${tR} or ${tCmd}--to${tR} to set its format.
  ${tCmd}--from${tR} may be omitted: stdin is content-detected.

${tH2}OPTIONS${tR}
  ${tCmd}--from${tR} ${tArg}FMT${tR}                       Input format: ${tArg}json${tR} | ${tArg}rx${tR} | ${tArg}rxb${tR}
  ${tCmd}--to${tR} ${tArg}FMT${tR}                         Output format: ${tArg}json${tR} | ${tArg}rx${tR} | ${tArg}rxb${tR}
  ${tCmd}--tune-index-threshold${tR} ${tArg}N${tR}         Index objects/arrays larger than N ${tDim}(default: ${INDEX_THRESHOLD})${tR}
  ${tCmd}--tune-chain-threshold${tR} ${tArg}N${tR}         Split strings longer than N ${tDim}(default: ${STRING_CHAIN_THRESHOLD})${tR}
  ${tCmd}--tune-chain-delimiter${tR} ${tArg}S${tR}         Delimiters for chain splitting ${tDim}(default: ${STRING_CHAIN_DELIMITER})${tR}
  ${tCmd}--tune-dedup-limit${tR} ${tArg}N${tR}             Max node count for structural dedup ${tDim}(default: ${DEDUP_COMPLEXITY_LIMIT})${tR}
  ${tCmd}-h${tR}, ${tCmd}--help${tR}                          Show this help

${tH2}EXAMPLES${tR}
  ${tCmd}rx convert${tR} ${tArg}data.json${tR} ${tArg}data.rx${tR}         ${tDesc}# JSON → rx${tR}
  ${tCmd}rx convert${tR} ${tArg}data.json${tR} ${tArg}data.rxb${tR}        ${tDesc}# JSON → rxb${tR}
  ${tCmd}rx convert${tR} ${tArg}data.rx${tR}   ${tArg}data.json${tR}       ${tDesc}# rx → JSON${tR}
  ${tCmd}rx convert${tR} ${tArg}data.rxb${tR}  ${tArg}data.json${tR}       ${tDesc}# rxb → JSON${tR}
  ${tCmd}rx convert${tR} ${tArg}data.rx${tR}   ${tArg}data.rxb${tR}        ${tDesc}# rx → rxb (re-encode)${tR}

  ${tCmd}cat${tR} ${tArg}data.json${tR} | ${tCmd}rx convert${tR} ${tArg}-${tR} ${tArg}data.rx${tR}
  ${tCmd}rx convert${tR} ${tArg}data.rx${tR} ${tArg}-${tR} ${tCmd}--to${tR} ${tArg}json${tR} > ${tArg}data.json${tR}
  ${tCmd}curl${tR} ${tArg}-s${tR} ${tArg}https://ex/api.json${tR} | ${tCmd}rx convert${tR} ${tArg}-${tR} ${tArg}snap.rxb${tR}

  ${tCmd}rx convert${tR} ${tArg}big.json${tR} ${tArg}big.rxb${tR} ${tCmd}--tune-dedup-limit${tR} ${tArg}128${tR}
`;
}

type ConvertOpts = {
	src: string;
	dst: string;
	from?: Format;
	to?: Format;
	tuneIndex?: number;
	tuneChain?: number;
	tuneDelim?: string;
	tuneDedup?: number;
};

function parseConvertArgs(argv: string[]): ConvertOpts {
	const opts: ConvertOpts = { src: "", dst: "" };
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-h" || arg === "--help") { process.stdout.write(helpConvert()); process.exit(0); }
		if (arg === "--from") { opts.from = parseInputFormatFlag(argv[++i], arg, "convert"); continue; }
		if (arg === "--to") { opts.to = parseInputFormatFlag(argv[++i], arg, "convert"); continue; }
		if (arg === "--tune-index-threshold") { opts.tuneIndex = parseIntFlag(argv[++i], arg, "convert"); continue; }
		if (arg === "--tune-chain-threshold") { opts.tuneChain = parseIntFlag(argv[++i], arg, "convert"); continue; }
		if (arg === "--tune-chain-delimiter") {
			const v = argv[++i]; if (v === undefined) fail("convert", `${arg} requires a value`);
			opts.tuneDelim = v; continue;
		}
		if (arg === "--tune-dedup-limit") { opts.tuneDedup = parseIntFlag(argv[++i], arg, "convert"); continue; }
		if (arg === "-") { positional.push("-"); continue; }
		if (arg.startsWith("-")) fail("convert", `unknown option: ${arg}`, `run 'rx convert --help' for usage`);
		positional.push(arg);
	}
	if (positional.length !== 2) {
		fail("convert", `expects 2 positional arguments (SRC and DST), got ${positional.length}`,
			`example: rx convert in.json out.rx`);
	}
	opts.src = positional[0]!;
	opts.dst = positional[1]!;
	return opts;
}

async function runConvert(argv: string[]): Promise<void> {
	const opts = parseConvertArgs(argv);

	// Resolve input format
	let inFmt = opts.from;
	if (!inFmt && opts.src !== "-") inFmt = formatFromExt(opts.src);
	if (!inFmt && opts.src !== "-") {
		fail("convert", `cannot infer input format from '${opts.src}'`,
			`pass --from json|rx|rxb or use a .json/.rx/.rxb extension`);
	}
	// (src === "-" and !inFmt): we'll content-detect inside readSource

	// Resolve output format
	let outFmt = opts.to;
	if (!outFmt && opts.dst !== "-") outFmt = formatFromExt(opts.dst);
	if (!outFmt) {
		fail("convert", `cannot infer output format for '${opts.dst}'`,
			`pass --to json|rx|rxb or use a .json/.rx/.rxb extension`);
	}

	tune({
		indexThreshold: opts.tuneIndex,
		stringChainThreshold: opts.tuneChain,
		stringChainDelimiter: opts.tuneDelim,
		dedupComplexityLimit: opts.tuneDedup,
	});

	const parsed = await readSource(opts.src, inFmt);
	const bytes = render(parsed.value, outFmt, false, 80);
	// render() adds a newline for text formats; for rxb and stdout-piped rx, that's fine.
	// For file writes in rxb we want raw bytes:
	const toWrite = outFmt === "rxb" ? rxbEncode(parsed.value) : bytes;
	if (opts.dst === "-") process.stdout.write(toWrite);
	else await writeFile(opts.dst, toWrite);
}

// ── Subcommand: get ──────────────────────────────────────────────────────────

function helpGet(): string {
	return `
${tH1}rx get${tR} — extract a value at a path.

${tH2}USAGE${tR}
  ${tCmd}rx get${tR} ${tArg}FILE${tR} [${tArg}SEGMENT${tR}...]

${tH2}ARGUMENTS${tR}
  ${tArg}FILE${tR}                              Path to .json, .rx, or .rxb. Use ${tArg}-${tR} for stdin.
  ${tArg}SEGMENT${tR}                           One key or numeric index per segment.
                                    No segments = entire file.

${tH2}OPTIONS${tR}
  ${tCmd}-f${tR}, ${tCmd}--format${tR} ${tArg}FMT${tR}                  Output format: ${tArg}tree${tR} | ${tArg}json${tR} | ${tArg}rx${tR} | ${tArg}rxb${tR}
  ${tCmd}-w${tR}, ${tCmd}--width${tR} ${tArg}N${tR}                     Target line width for tree output ${tDim}(default: 80)${tR}
  ${tCmd}-c${tR}, ${tCmd}--color${tR}                         Force ANSI color
      ${tCmd}--no-color${tR}                      Disable color
  ${tCmd}-o${tR}, ${tCmd}--output${tR} ${tArg}PATH${tR}                 Write to PATH instead of stdout
  ${tCmd}-h${tR}, ${tCmd}--help${tR}                          Show this help

${tH2}DEFAULTS${tR}
  Format: ${tArg}tree${tR} when stdout is a terminal, ${tArg}json${tR} when piped or redirected.
          Override with ${tCmd}-f${tR} or set ${tArg}RX_FORMAT${tR} env var.

${tH2}EXAMPLES${tR}
  ${tCmd}rx get${tR} ${tArg}data.rx${tR} ${tArg}users${tR} ${tArg}0${tR} ${tArg}name${tR}           ${tDesc}# data.users[0].name${tR}
  ${tCmd}rx get${tR} ${tArg}data.rx${tR} ${tArg}config${tR}              ${tDesc}# data.config subtree${tR}
  ${tCmd}rx get${tR} ${tArg}data.rx${tR}                     ${tDesc}# whole file${tR}
  ${tCmd}rx get${tR} ${tArg}data.rx${tR} ${tArg}users${tR} ${tArg}0${tR} ${tCmd}-f${tR} ${tArg}rx${tR}        ${tDesc}# emit subtree as rx${tR}
  ${tCmd}cat${tR} ${tArg}data.rx${tR} | ${tCmd}rx get${tR} ${tArg}-${tR} ${tArg}foo${tR} ${tArg}bar${tR}       ${tDesc}# from stdin${tR}
  ${tCmd}rx get${tR} ${tArg}data.rx${tR} ${tArg}users${tR} ${tCmd}-f${tR} ${tArg}json${tR} | ${tCmd}jq${tR} ${tArg}length${tR}

${tH2}ERRORS${tR}
  ${tDim}rx get: path [users, 999] — index 999 out of range in 5-element array${tR}
  ${tDim}rx get: path [config, db] — 'db' not found in object at [config]${tR}
  ${tDim}rx get: path [count] — cannot index into number at []${tR}
`;
}

type GetOpts = {
	file: string;
	segments: string[];
	format?: OutputFormat;
	width: number;
	color?: boolean;
	output?: string;
};

function parseGetArgs(argv: string[]): GetOpts {
	const opts: GetOpts = { file: "", segments: [], width: 80 };
	let gotFile = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-h" || arg === "--help") { process.stdout.write(helpGet()); process.exit(0); }
		if (arg === "-c" || arg === "--color") { opts.color = true; continue; }
		if (arg === "--no-color") { opts.color = false; continue; }
		if (arg === "-f" || arg === "--format") { opts.format = parseFormatFlag(argv[++i], arg, "get"); continue; }
		if (arg === "-w" || arg === "--width") { opts.width = parseIntFlag(argv[++i], arg, "get"); continue; }
		if (arg === "-o" || arg === "--output") {
			const v = argv[++i]; if (!v) fail("get", `${arg} requires a value`);
			opts.output = v; continue;
		}
		if (arg === "-" && !gotFile) { opts.file = "-"; gotFile = true; continue; }
		if (arg.startsWith("-") && arg !== "-") {
			// Negative numeric segment (e.g. -1) — ambiguous with flags; disallow to keep parser simple
			fail("get", `unknown option: ${arg}`, `run 'rx get --help' for usage`);
		}
		if (!gotFile) { opts.file = arg; gotFile = true; continue; }
		opts.segments.push(arg);
	}
	if (!gotFile) fail("get", "missing FILE argument", `example: rx get data.rx users 0 name`);
	return opts;
}

function applyPath(value: unknown, segments: string[]): unknown {
	let current: unknown = value;
	const trail: string[] = [];
	for (const seg of segments) {
		if (Array.isArray(current)) {
			const idx = /^\d+$/.test(seg) ? parseInt(seg, 10) : NaN;
			if (!Number.isInteger(idx)) {
				fail("get", `path [${[...trail, seg].join(", ")}] — '${seg}' is not a numeric index (array at [${trail.join(", ")}] has length ${current.length})`);
			}
			if (idx < 0 || idx >= current.length) {
				fail("get", `path [${[...trail, seg].join(", ")}] — index ${idx} out of range in ${current.length}-element array`);
			}
			current = current[idx];
		} else if (isObj(current)) {
			if (!(seg in current)) {
				fail("get", `path [${[...trail, seg].join(", ")}] — '${seg}' not found in object at [${trail.join(", ")}]`);
			}
			current = current[seg];
		} else {
			fail("get", `path [${[...trail, seg].join(", ")}] — cannot index into ${typeLabel(current)} at [${trail.join(", ")}]`);
		}
		trail.push(seg);
	}
	return current;
}

function typeLabel(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

async function runGet(argv: string[]): Promise<void> {
	const opts = parseGetArgs(argv);
	const isTTY = opts.output ? false : (process.stdout.isTTY ?? false);
	const color = resolveColor(opts.color, isTTY);
	const format = resolveOutputFormat(opts.format, isTTY);
	applyTheme(color);
	const parsed = await readSource(opts.file);
	const picked = applyPath(parsed.value, opts.segments);
	const bytes = render(picked, format, color && format !== "rxb", opts.width);
	if (opts.output) await writeFile(opts.output, bytes);
	else process.stdout.write(bytes);
}

// ── Subcommand: inspect ──────────────────────────────────────────────────────

function helpInspect(): string {
	return `
${tH1}rx inspect${tR} — dump the encoding AST (debug).

${tH2}USAGE${tR}
  ${tCmd}rx inspect${tR} [${tArg}FILE${tR} | ${tArg}-${tR}]

Outputs a JSON structure describing offsets, tags, and children.
Useful when developing or debugging the rx format itself.

${tH2}OPTIONS${tR}
  ${tCmd}-o${tR}, ${tCmd}--output${tR} ${tArg}PATH${tR}                 Write to PATH instead of stdout
      ${tCmd}--no-color${tR}                      Disable color
  ${tCmd}-h${tR}, ${tCmd}--help${tR}                          Show this help

${tH2}EXAMPLES${tR}
  ${tCmd}rx inspect${tR} ${tArg}data.rx${tR}
  ${tCmd}rx inspect${tR} ${tArg}data.json${tR}               ${tDesc}# encode first, then dump AST${tR}
`;
}

async function runInspect(argv: string[]): Promise<void> {
	let file = "";
	let output: string | undefined;
	let color: boolean | undefined;
	let gotFile = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-h" || arg === "--help") { process.stdout.write(helpInspect()); process.exit(0); }
		if (arg === "--no-color") { color = false; continue; }
		if (arg === "-o" || arg === "--output") {
			const v = argv[++i]; if (!v) fail("inspect", `${arg} requires a value`);
			output = v; continue;
		}
		if (arg === "-") { file = "-"; gotFile = true; continue; }
		if (arg.startsWith("-")) fail("inspect", `unknown option: ${arg}`);
		if (gotFile) fail("inspect", "takes only one input");
		file = arg; gotFile = true;
	}
	if (!gotFile) file = process.stdin.isTTY ? "" : "-";
	if (!file) { process.stdout.write(helpInspect()); process.exit(0); }
	const isTTY = output ? false : (process.stdout.isTTY ?? false);
	const useColor = resolveColor(color, isTTY);
	applyTheme(useColor);
	const parsed = await readSource(file);
	const rxBytes = parsed.rxBytes ?? encode(parsed.value);
	const ast = inspect(rxBytes);
	const text = JSON.stringify(ast, null, 2);
	const out = new TextEncoder().encode((useColor ? highlightJSON(text) : text) + "\n");
	if (output) await writeFile(output, out);
	else process.stdout.write(out);
}

// ── Subcommand: stats ────────────────────────────────────────────────────────

function helpStats(): string {
	return `
${tH1}rx stats${tR} — show size breakdown and compression ratios.

${tH2}USAGE${tR}
  ${tCmd}rx stats${tR} [${tArg}FILE${tR} | ${tArg}-${tR}]

${tH2}EXAMPLES${tR}
  ${tCmd}rx stats${tR} ${tArg}data.rx${tR}
  ${tCmd}rx stats${tR} ${tArg}data.json${tR}
`;
}

async function runStats(argv: string[]): Promise<void> {
	let file = "";
	let gotFile = false;
	for (const arg of argv) {
		if (arg === "-h" || arg === "--help") { process.stdout.write(helpStats()); process.exit(0); }
		if (arg.startsWith("-") && arg !== "-") fail("stats", `unknown option: ${arg}`);
		if (gotFile) fail("stats", "takes only one input");
		file = arg; gotFile = true;
	}
	if (!gotFile) file = process.stdin.isTTY ? "" : "-";
	if (!file) { process.stdout.write(helpStats()); process.exit(0); }
	const parsed = await readSource(file);
	const jsonBytes = new TextEncoder().encode(JSON.stringify(parsed.value)).length;
	const rxBytes = parsed.rxBytes ? parsed.rxBytes.length : new TextEncoder().encode(stringify(parsed.value)).length;
	const rxbBytes = parsed.rxbBytes ? parsed.rxbBytes.length : rxbEncode(parsed.value).length;
	const source = parsed.inputFormat;
	const pct = (n: number, base: number) => base === 0 ? "—" : `${((1 - n / base) * 100).toFixed(1)}% smaller`;
	process.stdout.write(
		`source format:  ${source}\n` +
		`json:           ${jsonBytes.toLocaleString()} bytes\n` +
		`rx text:        ${rxBytes.toLocaleString()} bytes  (${pct(rxBytes, jsonBytes)} than json)\n` +
		`rxb binary:     ${rxbBytes.toLocaleString()} bytes  (${pct(rxbBytes, jsonBytes)} than json, ${pct(rxbBytes, rxBytes)} than rx)\n`,
	);
}

// ── Subcommand: demo ─────────────────────────────────────────────────────────

function helpDemo(): string {
	return `
${tH1}rx demo${tR} — show an example value in all three formats side by side.

${tH2}USAGE${tR}
  ${tCmd}rx demo${tR}

Prints a built-in sample value in JSON, rx text, and rxb binary form.
Useful for learning what the formats look like.
`;
}

async function runDemo(argv: string[]): Promise<void> {
	for (const arg of argv) {
		if (arg === "-h" || arg === "--help") { process.stdout.write(helpDemo()); process.exit(0); }
		fail("demo", `unknown argument: ${arg}`);
	}
	const color = resolveColor(undefined, process.stdout.isTTY ?? false);
	applyTheme(color);
	const sample = {
		name: "rx-demo",
		version: "0.9.0",
		routes: [
			{ path: "/api", action: "proxy" },
			{ path: "/static", action: "serve" },
		],
		flags: { cache: true, compress: true },
	};
	const rxText = stringify(sample);
	const rxbBytes = rxbEncode(sample);
	const jsonText = JSON.stringify(sample, null, 2);
	const tree = treeStringify(sample, 80);
	const w = (title: string, body: string) => `${tH2}${title}${tR}\n${body}\n\n`;
	process.stdout.write("\n" + w("Tree view", color ? tree.split("\n").map(highlightTree).join("\n") : tree));
	process.stdout.write(w("JSON", color ? highlightJSON(jsonText) : jsonText));
	process.stdout.write(w(`rx text (${new TextEncoder().encode(rxText).length} bytes)`, rxText));
	process.stdout.write(w(`rxb binary (${rxbBytes.length} bytes, shown as hex)`, hex(rxbBytes)));
}

function hex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 16) {
		const row: string[] = [];
		for (let j = 0; j < 16 && i + j < bytes.length; j++) row.push(bytes[i + j]!.toString(16).padStart(2, "0"));
		out += row.join(" ") + "\n";
	}
	return out;
}

// ── Subcommand: completions ──────────────────────────────────────────────────

const ZSH_COMPLETION = `#compdef rx
_rx() {
	local -a results
	results=("\${(@f)$(rx completions --complete -- "\${(@)words[2,$CURRENT]}" 2>/dev/null)}")
	(( \${#results} == 0 )) && return
	local last="\${words[$CURRENT]}"
	if [[ "$last" == -* ]]; then
		compadd -Q -S '' -- "\${results[@]}"
	elif [[ "$last" == '~'* ]]; then
		compadd -U -Q -S '' -- "\${results[@]}"
	else
		compadd -Q -f -S '' -- "\${results[@]}"
	fi
}
_rx "$@"`;

const BASH_COMPLETION = `_rx() {
	local IFS=$'\\n'
	COMPREPLY=($(rx completions --complete -- "\${COMP_WORDS[@]:1}" 2>/dev/null))
	[[ \${#COMPREPLY[@]} -gt 0 ]] && compopt -o nospace
}
complete -o default -F _rx rx`;

type Shell = "zsh" | "bash";

function detectShell(): Shell | undefined {
	const shell = process.env.SHELL ?? "";
	if (shell.endsWith("/zsh")) return "zsh";
	if (shell.endsWith("/bash")) return "bash";
	return undefined;
}

async function removeIfSymlink(path: string) {
	try { const st = await lstat(path); if (st.isSymbolicLink()) await unlink(path); } catch {}
}

async function installCompletions(shell: Shell | undefined) {
	shell ??= detectShell();
	if (!shell) fail("completions", "cannot auto-detect shell", `specify explicitly: rx completions install zsh|bash`);
	const home = homedir();
	const isZsh = shell === "zsh";
	const dir = isZsh
		? join(home, ".local", "share", "zsh", "site-functions")
		: join(home, ".local", "share", "bash-completion", "completions");
	const dest = join(dir, isZsh ? "_rx" : "rx");
	const script = isZsh ? ZSH_COMPLETION : BASH_COMPLETION;
	await mkdir(dir, { recursive: true });
	await removeIfSymlink(dest);
	await writeFile(dest, script + "\n", "utf8");
	const hint = isZsh
		? `Ensure this is in your ~/.zshrc:\n\n  fpath=(${dir} $fpath)\n  autoload -Uz compinit && compinit\n\nThen: exec zsh`
		: `Ensure in your ~/.bashrc:\n\n  [[ -r ${dest} ]] && source ${dest}\n\nThen: source ~/.bashrc`;
	process.stderr.write(`Installed ${shell} completions to ${dest}\n\n${hint}\n`);
}

function helpCompletions(): string {
	return `
${tH1}rx completions${tR} — shell tab completion.

${tH2}USAGE${tR}
  ${tCmd}rx completions zsh${tR}                  Print zsh completion script
  ${tCmd}rx completions bash${tR}                 Print bash completion script
  ${tCmd}rx completions install${tR} [${tArg}SHELL${tR}]     Install to the standard location

${tH2}EXAMPLES${tR}
  ${tCmd}rx completions zsh${tR} > ~/.zsh/_rx
  ${tCmd}rx completions install${tR}              ${tDesc}# auto-detects shell${tR}
  ${tCmd}rx completions install bash${tR}
`;
}

const SUBCOMMANDS = ["show", "convert", "get", "inspect", "stats", "demo", "completions", "help"] as const;

async function runCompletions(argv: string[]): Promise<void> {
	const sub = argv[0];
	if (!sub || sub === "-h" || sub === "--help") { process.stdout.write(helpCompletions()); return; }
	if (sub === "zsh") { process.stdout.write(ZSH_COMPLETION + "\n"); return; }
	if (sub === "bash") { process.stdout.write(BASH_COMPLETION + "\n"); return; }
	if (sub === "install") { await installCompletions(argv[1] as Shell | undefined); return; }
	if (sub === "--complete") {
		// Called by shell completion scripts with remaining args as the word list.
		const dashDash = argv.indexOf("--");
		const words = dashDash >= 0 ? argv.slice(dashDash + 1) : [];
		await handleCompleteRequest(words);
		return;
	}
	fail("completions", `unknown action: ${sub}`, `expected: zsh | bash | install`);
}

async function handleCompleteRequest(words: string[]): Promise<void> {
	const current = words[words.length - 1] ?? "";
	const prev = words.length >= 2 ? words[words.length - 2] : undefined;
	// First word: subcommand
	if (words.length <= 1) {
		const matches = [...SUBCOMMANDS].filter(s => s.startsWith(current));
		if (matches.length) process.stdout.write(matches.join("\n") + "\n");
		return;
	}
	const sub = words[0];
	if (current.startsWith("-")) {
		const flags = FLAGS_BY_SUB[sub!] ?? [];
		const matches = flags.filter(f => f.startsWith(current));
		if (matches.length) process.stdout.write(matches.join("\n") + "\n");
		return;
	}
	if (prev === "-f" || prev === "--format") {
		process.stdout.write(["tree", "json", "rx", "rxb"].filter(s => s.startsWith(current)).join("\n") + "\n");
		return;
	}
	if (prev === "--from" || prev === "--to") {
		process.stdout.write(["json", "rx", "rxb"].filter(s => s.startsWith(current)).join("\n") + "\n");
		return;
	}
	// File completion with data-extension priority
	const files = listFiles(current);
	if (files.length) process.stdout.write(files.join("\n") + "\n");
}

const FLAGS_BY_SUB: Record<string, string[]> = {
	show: ["-f", "--format", "-w", "--width", "-c", "--color", "--no-color", "-o", "--output", "-h", "--help"],
	convert: ["--from", "--to", "--tune-index-threshold", "--tune-chain-threshold", "--tune-chain-delimiter", "--tune-dedup-limit", "-h", "--help"],
	get: ["-f", "--format", "-w", "--width", "-c", "--color", "--no-color", "-o", "--output", "-h", "--help"],
	inspect: ["-o", "--output", "--no-color", "-h", "--help"],
	stats: ["-h", "--help"],
	demo: ["-h", "--help"],
	completions: ["-h", "--help"],
	help: ["--all"],
};

const DATA_EXTENSIONS = [".json", ".rx", ".rxb"];

function listFiles(prefix: string): string[] {
	const home = homedir();
	let p = prefix;
	const tildePrefix = p.startsWith("~/");
	if (p === "~") return ["~/"];
	if (tildePrefix) p = join(home, p.slice(2));
	let dir: string, partial: string;
	if (p.endsWith("/")) { dir = p.slice(0, -1); partial = ""; }
	else if (p.includes("/")) { dir = dirname(p); partial = basename(p); }
	else { dir = "."; partial = p; }
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		const results: string[] = [];
		for (const entry of entries) {
			if (!entry.name.startsWith(partial)) continue;
			if (entry.name.startsWith(".") && !partial.startsWith(".")) continue;
			const rel = dir === "." ? entry.name : join(dir, entry.name);
			const render = tildePrefix ? "~/" + rel.slice(home.length + 1) : rel;
			if (entry.isDirectory()) results.push(render + "/");
			else if (DATA_EXTENSIONS.some(ext => entry.name.endsWith(ext))) results.push(render);
		}
		return results.sort();
	} catch { return []; }
}

// ── Top-level help & version ─────────────────────────────────────────────────

function helpTop(): string {
	return `
${tH1}rx${tR} — convert, inspect, and query compact JSON-shaped data.

${tH2}USAGE${tR}
  ${tCmd}rx${tR} ${tArg}FILE${tR}                           ${tDesc}# Pretty-print FILE (default action)${tR}
  ${tCmd}rx${tR} [${tArg}COMMAND${tR}] [${tArg}ARGS${tR}...]

${tH2}COMMANDS${tR}
  ${tCmd}show${tR}      Pretty-print a file
  ${tCmd}convert${tR}   Convert between JSON, rx, and rxb
  ${tCmd}get${tR}       Extract a value at a path
  ${tCmd}help${tR}      Show help for a command (${tCmd}rx help${tR} ${tArg}COMMAND${tR})

${tH2}FORMATS${tR}
  ${tArg}.json${tR}  JSON text
  ${tArg}.rx${tR}    rx text format (compact, human-readable)
  ${tArg}.rxb${tR}   rx binary format (smallest)

${tH2}GLOBAL OPTIONS${tR}
  ${tCmd}-h${tR}, ${tCmd}--help${tR}                          Show this help
  ${tCmd}-v${tR}, ${tCmd}--version${tR}                       Print version (${VERSION})

${tH2}ENVIRONMENT${tR}
  ${tArg}RX_FORMAT${tR}                         Pin default output format (${tArg}tree${tR} | ${tArg}json${tR} | ${tArg}rx${tR} | ${tArg}rxb${tR})
  ${tArg}NO_COLOR${tR}                          Disable ANSI color when set

${tH2}EXAMPLES${tR}
  ${tCmd}rx${tR} ${tArg}data.rx${tR}                         ${tDesc}# Pretty-print${tR}
  ${tCmd}cat${tR} ${tArg}data.rx${tR} | ${tCmd}rx${tR}                   ${tDesc}# From stdin${tR}
  ${tCmd}rx convert${tR} ${tArg}data.json${tR} ${tArg}data.rx${tR}       ${tDesc}# Convert${tR}
  ${tCmd}rx get${tR} ${tArg}data.rx${tR} ${tArg}users${tR} ${tArg}0${tR} ${tArg}name${tR}         ${tDesc}# Extract a value${tR}

Run ${tCmd}rx help${tR} ${tArg}COMMAND${tR} for details, or ${tCmd}rx help --all${tR} for advanced commands.
`;
}

function helpAll(): string {
	return helpTop() + `
${tH2}ADVANCED COMMANDS${tR}
  ${tCmd}inspect${tR}       Dump the encoding AST as JSON (debug)
  ${tCmd}stats${tR}         Size breakdown and compression ratios
  ${tCmd}demo${tR}          Built-in sample value in all three formats
  ${tCmd}completions${tR}   Shell tab completion (zsh, bash)
`;
}

function runHelp(argv: string[]): void {
	if (argv.length === 0) { process.stdout.write(helpTop()); return; }
	const topic = argv[0];
	if (topic === "--all" || topic === "-a") { process.stdout.write(helpAll()); return; }
	const helps: Record<string, () => string> = {
		show: helpShow, convert: helpConvert, get: helpGet,
		inspect: helpInspect, stats: helpStats, demo: helpDemo,
		completions: helpCompletions, help: () => helpTop(),
	};
	const h = helps[topic!];
	if (!h) {
		const hint = suggest(topic!, SUBCOMMANDS);
		fail("help", `unknown command '${topic}'`, hint ? `did you mean '${hint}'?` : `known: ${SUBCOMMANDS.join(", ")}`);
	}
	process.stdout.write(h());
}

// ── Main dispatcher ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const first = argv[0];

	// Global --version / -v (anywhere before a subcommand)
	if (first === "-v" || first === "--version") {
		process.stdout.write(`rx ${VERSION}\n`);
		return;
	}

	// Global --help / -h → top-level help
	if (first === "-h" || first === "--help") {
		applyTheme(resolveColor(undefined, process.stdout.isTTY ?? false));
		process.stdout.write(helpTop());
		return;
	}

	// Explicit subcommand
	if (first === "show") return runShow(argv.slice(1));
	if (first === "convert") return runConvert(argv.slice(1));
	if (first === "get") return runGet(argv.slice(1));
	if (first === "help") {
		applyTheme(resolveColor(undefined, process.stdout.isTTY ?? false));
		return runHelp(argv.slice(1));
	}
	if (first === "inspect") return runInspect(argv.slice(1));
	if (first === "stats") return runStats(argv.slice(1));
	if (first === "demo") return runDemo(argv.slice(1));
	if (first === "completions") return runCompletions(argv.slice(1));

	// No args: show from stdin if piped, else print help
	if (first === undefined) {
		applyTheme(resolveColor(undefined, process.stdout.isTTY ?? false));
		if (process.stdin.isTTY) { process.stdout.write(helpTop()); return; }
		return runShow(["-"]);
	}

	// Bare file-like arg → show
	if (first === "-" || !first.startsWith("-")) return runShow(argv);

	// Unknown option at top level
	const hint = suggest(first.replace(/^-+/, ""), SUBCOMMANDS);
	fail("rx", `unknown command or option: ${first}`,
		hint ? `did you mean '${hint}'?` : `run 'rx --help' for usage`);
}

main().catch((error) => {
	if (error instanceof CliError) {
		const prefix = error.subcmd === "rx" ? "rx" : `rx ${error.subcmd}`;
		process.stderr.write(`${prefix}: ${error.message}`);
		if (error.suggestion) process.stderr.write(`\n  — ${error.suggestion}`);
		process.stderr.write("\n");
		process.exit(2);
	}
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`rx: ${message}\n`);
	process.exit(1);
});
