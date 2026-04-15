import {
	stringify, encode,
	tune,
	INDEX_THRESHOLD, STRING_CHAIN_THRESHOLD, STRING_CHAIN_DELIMITER, DEDUP_COMPLEXITY_LIMIT
} from "./rx.ts";
import {
	open, inspect,
	makeCursor, read,
} from "./rx-read.ts";
import { encode as rxbEncode } from "./rxb.ts";
import {
	open as rxbOpen,
	makeCursor as rxbMakeCursor, read as rxbRead,
} from "./rxb-read.ts";
import { readdirSync } from "node:fs";
import { readFile, writeFile, mkdir, unlink, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename, extname } from "node:path";

// ── Theme ────────────────────────────────────────────────────
// Semantic color tags — interpolate directly in template strings.
// Monochrome (default), 16-color, or 256-color picked by applyTheme().

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
		// 256-color — Tokyo Night inspired
		tStr = "\x1b[38;5;150m";  // #9ece6a soft green
		tNum = "\x1b[38;5;209m";  // #ff9e64 orange
		tBool = "\x1b[38;5;141m";  // #bb9af7 purple
		tNull = "\x1b[38;5;60m";   // #565f89 blue-gray
		tKey = "\x1b[38;5;39m";   // #08f bright azure
		tCmd = "\x1b[38;5;117m";  // #75bffa light blue
		tArg = "\x1b[38;5;179m";  // #eeb260 warm gold
		tDesc = "\x1b[38;5;146m"; // #a9b1d6 muted lavender-gray
		tH1 = "\x1b[1;38;5;189m"; // #c0caf5 bold periwinkle
		tH2 = "\x1b[4m";         // underline
		tDim = "\x1b[38;5;60m";   // #565f89 blue-gray
	} else {
		// 16-color fallback
		tStr = "\x1b[32m";   // green
		tNum = "\x1b[33m";   // yellow
		tBool = "\x1b[33m";   // yellow
		tNull = "\x1b[90m";   // bright black
		tKey = "\x1b[35m";   // magenta
		tCmd = "\x1b[34;1m"; // bright blue
		tArg = "\x1b[33m";   // yellow
		tDesc = "\x1b[37m";  // white
		tH1 = "\x1b[1;37m";  // bold white
		tH2 = "\x1b[4m";    // underline
		tDim = "\x1b[2m";
	}
	tR = "\x1b[0m";
}

// ── Types & arg parsing ──────────────────────────────────────

type Format = "json" | "rexc" | "rxb";
type OutputFormat = "json" | "rexc" | "rxb" | "tree" | "ast" | "other";

type RxOptions = {
	files: string[];
	toFormat?: OutputFormat;
	select?: string[];
	out?: string;
	write: boolean;
	color: boolean;
	help: boolean;
	indexThreshold?: number;
	stringChainThreshold?: number;
	stringChainDelimiter?: string;
	dedupComplexityLimit?: number;
};

function parseArgs(argv: string[]): RxOptions {
	const opts: RxOptions = {
		files: [],
		write: false,
		color: process.stdout.isTTY ?? false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-h" || arg === "--help") { opts.help = true; continue; }
		if (arg === "-c" || arg === "--color") { opts.color = true; continue; }
		if (arg === "--no-color") { opts.color = false; continue; }
		if (arg === "-w" || arg === "--write") { opts.write = true; continue; }
		if (arg === "-j" || arg === "--json") { opts.toFormat = "json"; continue; }
		if (arg === "-r" || arg === "--rexc") { opts.toFormat = "rexc"; continue; }
		if (arg === "-b" || arg === "--rxb") { opts.toFormat = "rxb"; continue; }
		if (arg === "-t" || arg === "--tree") { opts.toFormat = "tree"; continue; }
		if (arg === "-a" || arg === "--ast") { opts.toFormat = "ast"; continue; }
		if (arg === "--to") {
			const v = argv[++i];
			if (v !== "json" && v !== "rexc" && v !== "rxb" && v !== "tree" && v !== "ast") throw new Error("--to must be 'json', 'rexc', 'rxb', 'tree', or 'ast'");
			opts.toFormat = v;
			continue;
		}
		if (arg === "-s" || arg === "--select") {
			const segments: string[] = [];
			while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
				segments.push(argv[++i]!);
			}
			if (segments.length === 0) throw new Error("Missing value for --select");
			opts.select = segments;
			continue;
		}
		if (arg === "-o" || arg === "--out") {
			const v = argv[++i];
			if (!v) throw new Error("Missing value for --out");
			opts.out = v;
			continue;
		}
		if (arg === "--index-threshold") {
			const v = argv[++i];
			if (!v) throw new Error("Missing value for --index-threshold");
			const n = Number(v);
			if (!Number.isInteger(n) || n < 0) throw new Error("--index-threshold must be a non-negative integer");
			opts.indexThreshold = n;
			continue;
		}
		if (arg === "--string-chain-threshold") {
			const v = argv[++i];
			if (!v) throw new Error("Missing value for --string-chain-threshold");
			const n = Number(v);
			if (!Number.isInteger(n) || n < 0) throw new Error("--string-chain-threshold must be a non-negative integer");
			opts.stringChainThreshold = n;
			continue;
		}
		if (arg === "--string-chain-delimiter") {
			const v = argv[++i];
			if (v === undefined) throw new Error("Missing value for --string-chain-delimiter");
			opts.stringChainDelimiter = v;
			continue;
		}
		if (arg === "--dedup-complexity-limit") {
			const v = argv[++i];
			if (!v) throw new Error("Missing value for --dedup-complexity-limit");
			const n = Number(v);
			if (!Number.isInteger(n) || n < 0) throw new Error("--dedup-complexity-limit must be a non-negative integer");
			opts.dedupComplexityLimit = n;
			continue;
		}
if (!arg.startsWith("-") || arg === "-") {
			opts.files.push(arg);
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	return opts;
}

function usage(): string {
	return [
		"",
		`${tH1}rx${tR} — inspect, convert, and filter REXC & JSON data.`,
		"",
		`${tH2}Usage:${tR}`,
		`  ${tCmd}rx${tR} ${tArg}data.rx${tR}                         ${tDesc}Pretty-print as a tree${tR}`,
		`  ${tCmd}rx${tR} ${tArg}data.rx${tR} ${tCmd}-j${tR}                      ${tDesc}Convert to JSON${tR}`,
		`  ${tCmd}rx${tR} ${tArg}data.json${tR} ${tCmd}-r${tR}                    ${tDesc}Convert to REXC${tR}`,
		`  ${tCmd}rx${tR} ${tArg}data.json${tR} ${tCmd}-b${tR}                    ${tDesc}Convert to RXB (binary)${tR}`,
		`  ${tCmd}cat${tR} ${tArg}data.rx${tR} | ${tCmd}rx${tR}                   ${tDesc}Read from stdin (auto-detect)${tR}`,
		`  ${tCmd}rx${tR} ${tArg}data.rx${tR} ${tCmd}-s${tR} ${tArg}key 0 sub${tR}            ${tDesc}Select a sub-value${tR}`,
		"",
		`${tH2}Input:${tR}`,
		`  ${tArg}<file>${tR}                             ${tDesc}File (format auto-detected by contents)${tR}`,
		`  ${tCmd}-${tR}                                  ${tDesc}Read from stdin explicitly${tR}`,
		`  ${tDim}(no args, piped)${tR}                   ${tDesc}Read from stdin automatically${tR}`,
		"",
		`${tH2}Format:${tR}`,
		`  ${tCmd}-j${tR}, ${tCmd}--json${tR}                         ${tDesc}Output as JSON${tR}`,
		`  ${tCmd}-r${tR}, ${tCmd}--rexc${tR}                         ${tDesc}Output as REXC${tR}`,
		`  ${tCmd}-b${tR}, ${tCmd}--rxb${tR}                          ${tDesc}Output as RXB (binary)${tR}`,
		`  ${tCmd}-t${tR}, ${tCmd}--tree${tR}                         ${tDesc}Output as tree (default on TTY)${tR}`,
		`  ${tCmd}-a${tR}, ${tCmd}--ast${tR}                          ${tDesc}Output encoding structure as JSON${tR}`,
		"",
		`${tH2}Filtering:${tR}`,
		`  ${tCmd}-s${tR}, ${tCmd}--select${tR} ${tArg}<seg>...${tR}              ${tDesc}Select a sub-value (e.g. ${tCmd}-s${tR} ${tArg}foo bar 0 baz${tR}${tDesc})${tR}`,
		"",
		`${tH2}Convert:${tR}`,
		`  ${tCmd}-w${tR}, ${tCmd}--write${tR}                        ${tDesc}Write converted file (.json↔.rx)${tR}`,
		"",
		`${tH2}Output:${tR}`,
		`  ${tCmd}-o${tR}, ${tCmd}--out${tR} ${tArg}<path>${tR}                   ${tDesc}Write to file instead of stdout${tR}`,
		`  ${tCmd}-c${tR}, ${tCmd}--color${tR} / ${tCmd}--no-color${tR}           ${tDesc}Force or disable ANSI color${tR}`,
		`  ${tCmd}-h${tR}, ${tCmd}--help${tR}                         ${tDesc}Show this message${tR}`,
		"",
		`${tH2}Tuning:${tR}`,
		`  ${tCmd}--index-threshold${tR} ${tArg}<n>${tR}              ${tDesc}Index objects/arrays above n values${tR} ${tDim}(default: ${INDEX_THRESHOLD})${tR}`,
		`  ${tCmd}--string-chain-threshold${tR} ${tArg}<n>${tR}       ${tDesc}Split strings longer than n into chains${tR} ${tDim}(default: ${STRING_CHAIN_THRESHOLD})${tR}`,
		`  ${tCmd}--string-chain-delimiter${tR} ${tArg}<s>${tR}       ${tDesc}Delimiter for string chains${tR} ${tDim}(default: ${STRING_CHAIN_DELIMITER})${tR}`,
		`  ${tCmd}--dedup-complexity-limit${tR} ${tArg}<n>${tR}      ${tDesc}Max node count for structural dedup${tR} ${tDim}(default: ${DEDUP_COMPLEXITY_LIMIT})${tR}`,
		"",
		`${tH2}Shell completions:${tR}`,
		`  ${tCmd}rx --completions setup${tR} ${tArg}[zsh|bash]${tR}  ${tDesc}Install tab completions${tR}`,
		`  ${tCmd}rx --completions${tR} ${tArg}zsh|bash${tR}          ${tDesc}Print completion script to stdout${tR}`,
		""
	].join("\n");
}

// ── Format detection & input reading ─────────────────────────

function formatFromExt(path: string): Format | undefined {
	if (path.endsWith(".json")) return "json";
	if (path.endsWith(".rexc") || path.endsWith(".rx")) return "rexc";
	if (path.endsWith(".rxb")) return "rxb";
	return undefined;
}

function detectFormat(content: string): Format {
	const bytes = new TextEncoder().encode(content.trim());
	if (bytes.length === 0) return "rexc";
	try {
		const c = makeCursor(bytes);
		read(c);
		if (c.left === 0) return "rexc";
	} catch { /* not valid rexc */ }
	return "json";
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

type ParsedInput = { value: unknown; rexcBytes?: Uint8Array; rxbBytes?: Uint8Array };

function stripJsonComments(s: string): string {
	let out = "", i = 0;
	while (i < s.length) {
		if (s[i] === '"') {
			const start = i++;
			while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
			out += s.slice(start, ++i);
		} else if (s[i] === '/' && s[i + 1] === '/') {
			i += 2;
			while (i < s.length && s[i] !== '\n') i++;
		} else if (s[i] === '/' && s[i + 1] === '*') {
			i += 2;
			while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
			i += 2;
		} else {
			out += s[i++];
		}
	}
	return out;
}

function parseRawBytes(bytes: Uint8Array, format: Format): ParsedInput {
	if (format === "rxb") return { value: rxbOpen(bytes), rxbBytes: bytes };
	const raw = new TextDecoder().decode(bytes);
	if (format === "json") return { value: JSON.parse(stripJsonComments(raw)) };
	const trimmed = new TextEncoder().encode(raw.trim());
	return { value: open(trimmed), rexcBytes: trimmed };
}

function parseRaw(raw: string, format: Format): ParsedInput {
	if (format === "json") return { value: JSON.parse(stripJsonComments(raw)) };
	const bytes = new TextEncoder().encode(raw.trim());
	return { value: open(bytes), rexcBytes: bytes };
}

async function readOne(file: string): Promise<ParsedInput> {
	const ext = file === "-" ? undefined : formatFromExt(file);
	if (ext === "rxb") {
		const bytes = new Uint8Array(await readFile(file));
		return parseRawBytes(bytes, "rxb");
	}
	const raw = file === "-" ? await readStdin() : await readFile(file, "utf8");
	const format = file === "-" ? detectFormat(raw) : ext ?? detectFormat(raw);
	return parseRaw(raw, format);
}

async function readInput(opts: RxOptions): Promise<ParsedInput> {
	if (opts.files.length === 0) {
		if (process.stdin.isTTY) {
			process.stderr.write([
				`${tH1}rx${tR} — inspect, convert, and filter REXC & JSON data.`,
				"",
				`${tH2}Usage:${tR} (file can be .json, .rx, or .rxb)`,
				`  ${tCmd}rx${tR} ${tArg}<file>${tR}                Pretty-print as a tree`,
				`  ${tCmd}rx${tR} ${tArg}<file>${tR} ${tCmd}-j${tR}             Convert to JSON`,
				`  ${tCmd}rx${tR} ${tArg}<file>${tR} ${tCmd}-r${tR}             Convert to REXC`,
				`  ${tCmd}rx${tR} ${tArg}<file>${tR} ${tCmd}-b${tR}             Convert to RXB (binary)`,
				`  ${tCmd}cat${tR} ${tArg}data.rx${tR} | ${tCmd}rx${tR}         Read from stdin`,
				`  ${tCmd}rx${tR} ${tArg}<file>${tR} ${tCmd}-s${tR} ${tArg}key 0 sub${tR}   Select a sub-value`,
				`  ${tCmd}rx${tR} ${tArg}<file>${tR} ${tCmd}-o${tR} ${tArg}out.json${tR}    Write to file`,
				"",
				`Run ${tCmd}rx --help${tR} for full options.`,
				"",
			].join("\n"));
			process.exit(1);
		}
		const raw = await readStdin();
		if (!raw.trim()) throw new Error("Empty stdin.");
		return parseRaw(raw, detectFormat(raw));
	}

	if (opts.files.length === 1) return readOne(opts.files[0]!);

	const values: unknown[] = [];
	for (const file of opts.files) values.push((await readOne(file)).value);
	return { value: values };
}

// ── Selector ─────────────────────────────────────────────────

function applySelector(value: unknown, segments: string[]): unknown {
	let current = value;
	let path = "";
	for (const seg of segments) {
		const idx = /^\d+$/.test(seg) ? parseInt(seg, 10) : undefined;
		if (Array.isArray(current) && idx !== undefined) {
			path += `[${idx}]`;
			if (idx < 0 || idx >= current.length) {
				throw new Error(`Selector ${path}: index ${idx} out of range (length ${current.length})`);
			}
			current = current[idx];
		} else if (isObj(current)) {
			path += `.${seg}`;
			if (!(seg in current)) throw new Error(`Selector${path}: property '${seg}' not found`);
			current = current[seg];
		} else {
			throw new Error(`Selector${path}.${seg}: cannot index into ${typeLabel(current)}`);
		}
	}
	return current;
}

function typeLabel(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

// ── Tree pretty-printer ──────────────────────────────────────
// Rex-style: bare keys, space-separated arrays, inline-first

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
		// try inline (bail on nested objects/arrays)
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

function treeStringify(value: unknown, onLine?: (line: string) => void): string {
	const text = fmtPretty(value, 0, 2, 80);
	if (onLine) { for (const line of text.split("\n")) onLine(line); return ""; }
	return text;
}

// ── Syntax highlighting ──────────────────────────────────────

function highlightTree(line: string): string {
	let result = "", i = 0;
	const len = line.length;
	while (i < len) {
		if (line[i] === " " || line[i] === "\t") { result += line[i]; i++; continue; }
		// key followed by ':'
		const km = line.slice(i).match(/^([A-Za-z_][A-Za-z0-9_-]*|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\]|\\.)*")(\s*:)/);
		if (km) { result += tKey + km[1] + tR + km[2]; i += km[0].length; continue; }
		// string
		if (line[i] === '"') {
			const m = line.slice(i).match(/^"(?:[^"\\]|\\.)*"/);
			if (m) { result += tStr + m[0] + tR; i += m[0].length; continue; }
		}
		// keywords
		const bl = line.slice(i).match(/^(?:true|false)\b/);
		if (bl) { result += tBool + bl[0] + tR; i += bl[0].length; continue; }
		const nl = line.slice(i).match(/^(?:null|undefined|nan|-?inf)\b/);
		if (nl) { result += tNull + nl[0] + tR; i += nl[0].length; continue; }
		// numbers
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

// ── Output formatting ────────────────────────────────────────

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

function formatOutputBinary(value: unknown, format: OutputFormat): Uint8Array | null {
	if (format === "rxb") return rxbEncode(value);
	return null;
}

function formatOutput(value: unknown, format: OutputFormat, color: boolean, rexcBytes?: Uint8Array): string {
	if (format === "tree") {
		const text = treeStringify(value);
		if (!color) return text;
		return text.split("\n").map(highlightTree).join("\n");
	}
	if (format === "json") {
		const text = JSON.stringify(normalizeForJson(value, false), null, 2) ?? "null";
		return color ? highlightJSON(text) : text;
	}
	if (format === "ast") {
		const bytes = rexcBytes ?? encode(value);
		const ast = inspect(bytes);
		const text = JSON.stringify(ast, null, 2);
		return color ? highlightJSON(text) : text;
	}
	if (format === "rexc") {
		return stringify(value) ?? "";
	}
	throw new Error(`Unsupported output format: ${format}`);
}

// ── Shell completions ────────────────────────────────────────

const FLAGS_WITH_VALUE = new Set(["-o", "--out", "--to", "--index-threshold", "--string-chain-threshold", "--string-chain-delimiter", "--dedup-complexity-limit"]);
const ALL_FLAGS = ["-h", "--help", "-w", "--write", "-j", "--json", "-r", "--rexc", "-b", "--rxb", "-t", "--tree", "-a", "--ast",
	"--to", "-s", "--select", "-o", "--out", "-c", "--color", "--no-color",
	"--index-threshold", "--string-chain-threshold", "--string-chain-delimiter", "--dedup-complexity-limit"];
const DATA_EXTENSIONS = [".json", ".rexc", ".rx", ".rxb"];

function findSelectIndex(words: string[]): number {
	for (let i = 0; i < words.length - 1; i++) {
		const w = words[i]!;
		if (w === "-s" || w === "--select") return i;
		if (FLAGS_WITH_VALUE.has(w)) { i++; continue; }
	}
	return -1;
}

function extractFiles(words: string[]): string[] {
	const files: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		if (w === "-s" || w === "--select") break;
		if (FLAGS_WITH_VALUE.has(w)) { i++; continue; }
		if (w.startsWith("-")) continue;
		files.push(w);
	}
	return files;
}

function shellUnescape(s: string): string { return s.replace(/\\(.)/g, "$1"); }
function shellEscape(s: string): string { return s.replace(/([ ()\[\]{}'"\\!#$&*?;<>|`^~])/g, "\\$1"); }

function listFiles(prefix: string, dataOnly: boolean): string[] {
	prefix = shellUnescape(prefix);
	const home = homedir();
	// Normalize expanded home dir back to ~ (bun may expand ~ in argv)
	if (prefix === home) return ["~/"];
	if (prefix.startsWith(home + "/")) prefix = "~/" + prefix.slice(home.length + 1);
	if (prefix === "~") return ["~/"];
	const tildePrefix = prefix.startsWith("~/");
	if (tildePrefix) {
		const rest = prefix.slice(2);
		prefix = rest ? join(home, rest) : home + "/";
	}
	let dir: string, partial: string;
	if (prefix.endsWith("/")) {
		dir = prefix.slice(0, -1);
		partial = "";
	} else if (prefix.includes("/")) {
		dir = dirname(prefix);
		partial = basename(prefix);
	} else {
		dir = ".";
		partial = prefix;
	}
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		const results: string[] = [];
		// readdirSync omits . and .., so offer them as navigation targets
		if (!prefix.includes("/")) {
			if (".".startsWith(partial)) results.push("./");
			if ("..".startsWith(partial)) results.push("../");
		}
		for (const entry of entries) {
			if (!entry.name.startsWith(partial)) continue;
			if (entry.name.startsWith(".") && !partial.startsWith(".")) continue;
			let rel = dir === "." ? entry.name : join(dir, entry.name);
			const escaped = tildePrefix
				? "~/" + shellEscape(rel.slice(home.length + 1))
				: shellEscape(rel);
			if (entry.isDirectory()) {
				results.push(escaped + "/");
			} else if (!dataOnly || DATA_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
				results.push(escaped);
			}
		}
		return results.sort();
	} catch { return []; }
}

function printCompletions(completions: string[]) {
	if (completions.length > 0) process.stdout.write(completions.join("\n") + "\n");
}

function walkSegments(value: unknown, segments: string[]): unknown {
	let current = value;
	for (const seg of segments) {
		const idx = /^\d+$/.test(seg) ? parseInt(seg, 10) : undefined;
		if (Array.isArray(current) && idx !== undefined) {
			if (idx < 0 || idx >= current.length) return undefined;
			current = current[idx];
		} else if (isObj(current)) {
			if (!(seg in current)) return undefined;
			current = current[seg];
		} else {
			return undefined;
		}
	}
	return current;
}

const MAX_COMPLETIONS = 50;

function collapseCompletions(matches: string[], partial: string): string[] {
	if (matches.length <= MAX_COMPLETIONS) return matches;
	matches.sort();
	const maxLen = matches[matches.length - 1]!.length;
	function distinctAt(len: number): number {
		let count = 1;
		for (let i = 1; i < matches.length; i++) {
			const a = matches[i - 1]!, b = matches[i]!;
			let same = a.length >= len && b.length >= len;
			if (same) {
				for (let j = 0; j < len; j++) {
					if (a.charCodeAt(j) !== b.charCodeAt(j)) { same = false; break; }
				}
			} else {
				const end = Math.min(a.length, b.length);
				for (let j = 0; j < end; j++) {
					if (a.charCodeAt(j) !== b.charCodeAt(j)) { same = false; break; }
				}
				if (same) same = a.length === b.length;
			}
			if (!same) count++;
		}
		return count;
	}
	let lo = partial.length + 1;
	let hi = maxLen;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (distinctAt(mid) <= MAX_COMPLETIONS) lo = mid;
		else hi = mid - 1;
	}
	const result: string[] = [matches[0]!.slice(0, lo)];
	for (let i = 1; i < matches.length; i++) {
		const p = matches[i]!.slice(0, lo);
		if (p !== result[result.length - 1]) result.push(p);
	}
	return result;
}

function generateCompletions(value: unknown, segments: string[], partial: string): string[] {
	const target = walkSegments(value, segments);
	if (target === null || target === undefined || typeof target !== "object") return [];
	let matches: string[];
	if (Array.isArray(target)) {
		matches = target.map((_, i) => String(i)).filter(s => s.startsWith(partial));
	} else {
		matches = Object.keys(target as Record<string, unknown>).filter(k => k.startsWith(partial));
	}
	return collapseCompletions(matches, partial);
}

async function handleCompletions(argv: string[]) {
	const words = argv.length > 0 ? argv : [""];
	const current = words[words.length - 1]!;
	const prev = words.length >= 2 ? words[words.length - 2] : undefined;

	if (prev === "--to") return printCompletions(["json", "rexc", "rxb", "tree", "ast"]);
	if (prev === "-o" || prev === "--out") return printCompletions(listFiles(current, false));

	const selectIdx = findSelectIndex(words);
	if (selectIdx >= 0 && !current.startsWith("-")) {
		const files = extractFiles(words.slice(0, selectIdx));
		if (files.length > 0) {
			const segments = words.slice(selectIdx + 1, -1);
			try {
				const raw = await readFile(files[0]!, "utf8");
				const format = formatFromExt(files[0]!) ?? detectFormat(raw);
				const { value } = parseRaw(raw, format);
				return printCompletions(generateCompletions(value, segments, current));
			} catch { /* can't parse, no completions */ }
		}
		return printCompletions([]);
	}

	if (current.startsWith("-")) return printCompletions(ALL_FLAGS.filter(f => f.startsWith(current)));
	return printCompletions(listFiles(current, true));
}

// ── Shell completion scripts & setup ─────────────────────────

const ZSH_COMPLETION = `#compdef rx
_rx() {
	local -a results
	results=("\${(@f)$(rx --completions -- "\${(@)words[2,$CURRENT]}" 2>/dev/null)}")
	(( \${#results} == 0 )) && return
	local in_select=0
	local i
	for (( i=2; i < CURRENT; i++ )); do
		[[ "\${words[$i]}" == (-s|--select) ]] && in_select=1 && break
	done
	local last="\${words[$CURRENT]}"
	if [[ "$last" == -* ]] || (( in_select )); then
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
	COMPREPLY=($(rx --completions -- "\${COMP_WORDS[@]:1}" 2>/dev/null))
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
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink()) await unlink(path);
	} catch { /* doesn't exist */ }
}

async function setupCompletions(args: string[]) {
	let shell = args[0] as Shell | undefined;
	if (shell && shell !== "zsh" && shell !== "bash") {
		throw new Error(`Unsupported shell: ${shell}. Use 'zsh' or 'bash'.`);
	}
	shell ??= detectShell();
	if (!shell) throw new Error("Cannot detect shell. Specify: rx setup-completions zsh|bash");

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

	const instructions = isZsh
		? `\nEnsure this is in your ~/.zshrc:\n\n  fpath=(${dir} $fpath)\n  autoload -Uz compinit && compinit\n\nThen restart your shell or run: exec zsh`
		: `\nEnsure bash-completion is loaded in your ~/.bashrc:\n\n  [[ -r ${dir}/rx ]] && source ${dir}/rx\n\nThen restart your shell or run: source ~/.bashrc`;

	process.stderr.write(`Installed ${shell} completions to ${dest}${instructions}\n`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
	const argv = process.argv.slice(2);

	if (argv[0] === "--completions") {
		const sub = argv[1];
		if (sub === "setup") { await setupCompletions(argv.slice(2)); return; }
		if (sub === "zsh" || sub === "bash") {
			process.stdout.write((sub === "zsh" ? ZSH_COMPLETION : BASH_COMPLETION) + "\n");
			return;
		}
		const dashDash = argv.indexOf("--");
		await handleCompletions(dashDash >= 0 ? argv.slice(dashDash + 1) : []);
		return;
	}

	const opts = parseArgs(argv);
	applyTheme(opts.color);
	if (opts.help) { console.log(usage()); return; }

	tune({
		indexThreshold: opts.indexThreshold,
		stringChainThreshold: opts.stringChainThreshold,
		stringChainDelimiter: opts.stringChainDelimiter,
		dedupComplexityLimit: opts.dedupComplexityLimit,
	});

	const { value: parsed, rexcBytes, rxbBytes } = await readInput(opts);
	const inputIsRx = !!(rexcBytes || rxbBytes);

	if (opts.write) {
		if (opts.files.length !== 1) throw new Error("--write requires exactly one input file");
		const file = opts.files[0]!;
		const ext = extname(file);
		const value = opts.select ? applySelector(parsed, opts.select) : parsed;
		let outPath: string;
		let outFormat: OutputFormat;
		if (ext === ".json") {
			// Default: json → rx. With -b flag: json → rxb.
			outFormat = opts.toFormat === "rxb" ? "rxb" : "rexc";
			outPath = file.slice(0, -ext.length) + (outFormat === "rxb" ? ".rxb" : ".rx");
		} else if (ext === ".rx" || ext === ".rexc") {
			outFormat = opts.toFormat === "rxb" ? "rxb" : "json";
			outPath = file.slice(0, -ext.length) + (outFormat === "rxb" ? ".rxb" : ".json");
		} else if (ext === ".rxb") {
			outFormat = opts.toFormat === "rexc" ? "rexc" : "json";
			outPath = file.slice(0, -ext.length) + (outFormat === "rexc" ? ".rx" : ".json");
		} else {
			throw new Error(`--write: unsupported extension '${ext}' (expected .json, .rx, .rexc, or .rxb)`);
		}
		const bin = formatOutputBinary(value, outFormat);
		if (bin) {
			await writeFile(outPath, bin);
		} else {
			const out = formatOutput(value, outFormat, false, rexcBytes);
			await writeFile(outPath, out + "\n", "utf8");
		}
		return;
	}

	const toFormat: OutputFormat = opts.toFormat === "other"
		? (inputIsRx ? "json" : "rexc")
		: opts.toFormat ?? (process.stdout.isTTY ? "tree" : (inputIsRx ? "json" : "rexc"));
	const value = opts.select ? applySelector(parsed, opts.select) : parsed;

	// Binary output (rxb)
	const bin = formatOutputBinary(value, toFormat);
	if (bin) {
		if (opts.out) {
			await writeFile(opts.out, bin);
		} else {
			process.stdout.write(bin);
		}
		return;
	}

	// Stream tree to stdout line-by-line
	if (toFormat === "tree" && !opts.out) {
		treeStringify(value, opts.color
			? (line: string) => { process.stdout.write(highlightTree(line) + "\n"); }
			: (line: string) => { process.stdout.write(line + "\n"); },
		);
		return;
	}

	const out = formatOutput(value, toFormat, opts.color, rexcBytes);

	if (opts.out) {
		await writeFile(opts.out, out + "\n", "utf8");
	} else {
		process.stdout.write(out + "\n");
	}
}

await main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`rx: ${message}\n`);
	process.exit(1);
});
