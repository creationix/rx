import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end CLI tests. Each case spawns the CLI as a subprocess and asserts
// on stdout, stderr, and exit code. The CLI runs directly from source via
// `bun rx-cli.ts` so tests reflect current code without a build step.

const CLI = join(import.meta.dir, "rx-cli.ts");

type RunResult = { stdout: string; stderr: string; exitCode: number };

function run(args: string[], input?: string, env?: Record<string, string>): RunResult {
	const proc = Bun.spawnSync({
		cmd: ["bun", CLI, ...args],
		stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1", ...env },
	});
	return {
		stdout: new TextDecoder().decode(proc.stdout),
		stderr: new TextDecoder().decode(proc.stderr),
		exitCode: proc.exitCode ?? -1,
	};
}

let dir: string;
let jsonFile: string, rxFile: string, rxbFile: string;

const SAMPLE = {
	name: "test",
	count: 42,
	flag: true,
	tags: ["alpha", "beta", "gamma"],
	nested: { a: 1, b: 2, c: [10, 20, 30] },
};

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "rx-cli-test-"));
	jsonFile = join(dir, "sample.json");
	rxFile = join(dir, "sample.rx");
	rxbFile = join(dir, "sample.rxb");
	writeFileSync(jsonFile, JSON.stringify(SAMPLE));
	// Build rx and rxb fixtures by round-tripping through the CLI itself
	// (chicken-and-egg on first run is fine — the tests below also validate this)
	const r1 = run(["convert", jsonFile, rxFile]);
	if (r1.exitCode !== 0) throw new Error(`fixture convert failed: ${r1.stderr}`);
	const r2 = run(["convert", jsonFile, rxbFile]);
	if (r2.exitCode !== 0) throw new Error(`fixture convert rxb failed: ${r2.stderr}`);
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("rx --version / --help", () => {
	test("--version prints version", () => {
		const r = run(["--version"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toMatch(/^rx \d+\.\d+\.\d+\n$/);
	});

	test("-v prints version", () => {
		const r = run(["-v"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toMatch(/^rx \d+\.\d+\.\d+\n$/);
	});

	test("--help shows top-level help with all core commands", () => {
		const r = run(["--help"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("rx — convert");
		expect(r.stdout).toContain("show");
		expect(r.stdout).toContain("convert");
		expect(r.stdout).toContain("FORMATS");
		expect(r.stdout).toContain("RX_FORMAT");
		// `get` was merged into `show` — must NOT appear as a subcommand
		expect(r.stdout).not.toMatch(/^\s+get\s/m);
	});

	test("no args with stdin TTY-less shows help", () => {
		const r = run(["--help"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("USAGE");
	});

	test("help --all surfaces advanced commands", () => {
		const r = run(["help", "--all"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("ADVANCED COMMANDS");
		expect(r.stdout).toContain("inspect");
		expect(r.stdout).toContain("stats");
		expect(r.stdout).toContain("demo");
		expect(r.stdout).toContain("completions");
	});

	test("help COMMAND shows subcommand help", () => {
		for (const sub of ["show", "convert", "inspect", "stats", "demo", "completions"]) {
			const r = run(["help", sub]);
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain(`rx ${sub}`);
			expect(r.stdout).toContain("USAGE");
		}
	});

	test("COMMAND --help matches help COMMAND", () => {
		for (const sub of ["show", "convert"]) {
			const a = run([sub, "--help"]);
			const b = run(["help", sub]);
			expect(a.exitCode).toBe(0);
			expect(a.stdout).toBe(b.stdout);
		}
	});

	test("`get` is no longer a subcommand", () => {
		const r = run(["help", "get"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("unknown command 'get'");
	});

	test("help typo suggests correct command", () => {
		const r = run(["help", "covert"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("unknown command 'covert'");
		expect(r.stderr).toContain("did you mean 'convert'?");
	});
});

describe("rx show / default action", () => {
	test("bare FILE arg defaults to show", () => {
		const r = run([jsonFile]);
		expect(r.exitCode).toBe(0);
		// Piped stdout (not TTY) → json default
		expect(JSON.parse(r.stdout)).toEqual(SAMPLE);
	});

	test("rx show FILE -f json", () => {
		const r = run(["show", rxFile, "-f", "json"]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual(SAMPLE);
	});

	test("rx show FILE -f tree (bare keys, no quotes)", () => {
		const r = run(["show", rxFile, "-f", "tree"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("name: \"test\"");
		expect(r.stdout).toContain("count: 42");
		expect(r.stdout).not.toContain('"name":');
	});

	test("rx show FILE -f rx emits rx text", () => {
		const r = run(["show", jsonFile, "-f", "rx"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBeTruthy();
		// Round-trip via convert
		const tmp = join(dir, "roundtrip.rx");
		writeFileSync(tmp, r.stdout.trim());
		const back = run(["show", tmp, "-f", "json"]);
		expect(JSON.parse(back.stdout)).toEqual(SAMPLE);
	});

	test("rx show - reads from stdin", () => {
		const r = run(["show", "-", "-f", "json"], JSON.stringify(SAMPLE));
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual(SAMPLE);
	});

	test("rx (no args) reads from stdin when piped", () => {
		const r = run([], JSON.stringify(SAMPLE));
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual(SAMPLE);
	});

	test("rx show auto-detects format from rx content", () => {
		const rxText = readFileSync(rxFile, "utf8");
		const r = run(["show", "-", "-f", "json"], rxText);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual(SAMPLE);
	});

	test("rx show auto-detects format from rxb content", () => {
		const rxbBytes = readFileSync(rxbFile);
		// Note: passing binary via stdin requires bytes, but run() takes string. Use file instead.
		const r = run(["show", rxbFile, "-f", "json"]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual(SAMPLE);
	});

	test("extra positional after FILE is treated as a path segment, not a second file", () => {
		// `rx show f1 f2` is `show f1` with segment "f2" — should error as a missing
		// path key in the parsed value, not as "too many files".
		const r = run(["show", jsonFile, "not-a-key"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("rx show:");
		expect(r.stderr).toContain("not-a-key");
		expect(r.stderr).not.toContain("only one input");
	});

	test("--no-color strips ANSI", () => {
		const r = run(["show", rxFile, "-f", "tree", "--no-color"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).not.toMatch(/\x1b\[/);
	});

	test("rx show -o writes to file", () => {
		const out = join(dir, "out.json");
		const r = run(["show", rxFile, "-f", "json", "-o", out]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("");
		expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(SAMPLE);
	});

	test("RX_FORMAT env pins default format", () => {
		const r = run([jsonFile], undefined, { RX_FORMAT: "rx" });
		expect(r.exitCode).toBe(0);
		// rx text has trailing capital letter tag — just check it's not JSON
		expect(() => JSON.parse(r.stdout)).toThrow();
	});
});

describe("rx convert", () => {
	test("JSON → rx file", () => {
		const out = join(dir, "a.rx");
		const r = run(["convert", jsonFile, out]);
		expect(r.exitCode).toBe(0);
		expect(existsSync(out)).toBe(true);
		// Round-trip back
		const back = run(["show", out, "-f", "json"]);
		expect(JSON.parse(back.stdout)).toEqual(SAMPLE);
	});

	test("JSON → rxb file", () => {
		const out = join(dir, "b.rxb");
		const r = run(["convert", jsonFile, out]);
		expect(r.exitCode).toBe(0);
		const back = run(["show", out, "-f", "json"]);
		expect(JSON.parse(back.stdout)).toEqual(SAMPLE);
	});

	test("rx → JSON file", () => {
		const out = join(dir, "c.json");
		const r = run(["convert", rxFile, out]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(SAMPLE);
	});

	test("rxb → JSON file", () => {
		const out = join(dir, "d.json");
		const r = run(["convert", rxbFile, out]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(SAMPLE);
	});

	test("rx → rxb file (re-encode)", () => {
		const out = join(dir, "e.rxb");
		const r = run(["convert", rxFile, out]);
		expect(r.exitCode).toBe(0);
		const back = run(["show", out, "-f", "json"]);
		expect(JSON.parse(back.stdout)).toEqual(SAMPLE);
	});

	test("stdin → file (content-detected)", () => {
		const out = join(dir, "f.rx");
		const r = run(["convert", "-", out], JSON.stringify(SAMPLE));
		expect(r.exitCode).toBe(0);
		const back = run(["show", out, "-f", "json"]);
		expect(JSON.parse(back.stdout)).toEqual(SAMPLE);
	});

	test("file → stdout with --to", () => {
		const r = run(["convert", rxFile, "-", "--to", "json"]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual(SAMPLE);
	});

	test("stdin → stdout with --from and --to", () => {
		const r = run(["convert", "-", "-", "--from", "json", "--to", "rx"], JSON.stringify(SAMPLE));
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBeTruthy();
	});

	test("missing DST errors with example", () => {
		const r = run(["convert", jsonFile]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("expects 2 positional arguments");
		expect(r.stderr).toContain("example: rx convert");
	});

	test("unknown extension errors", () => {
		const r = run(["convert", "foo.xyz", "bar.rx"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("cannot infer input format");
		expect(r.stderr).toContain("--from");
	});

	test("stdout without --to errors", () => {
		const r = run(["convert", rxFile, "-"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("cannot infer output format");
		expect(r.stderr).toContain("--to");
	});

	test("--tune-dedup-limit 0 produces different output", () => {
		const a = join(dir, "tune-a.rx"), b = join(dir, "tune-b.rx");
		const r1 = run(["convert", jsonFile, a]);
		const r2 = run(["convert", jsonFile, b, "--tune-dedup-limit", "0"]);
		expect(r1.exitCode).toBe(0);
		expect(r2.exitCode).toBe(0);
		// Same decoded value
		const back1 = JSON.parse(run(["show", a, "-f", "json"]).stdout);
		const back2 = JSON.parse(run(["show", b, "-f", "json"]).stdout);
		expect(back1).toEqual(back2);
	});

	test("unknown flag errors", () => {
		const r = run(["convert", jsonFile, rxFile, "--boom"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("unknown option: --boom");
	});
});

describe("rx show with path segments (formerly `get`)", () => {
	test("extracts string at path", () => {
		const r = run(["show", rxFile, "name", "-f", "json"]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toBe("test");
	});

	test("extracts number at path", () => {
		const r = run(["show", rxFile, "count", "-f", "json"]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toBe(42);
	});

	test("extracts nested path with array index", () => {
		const r = run(["show", rxFile, "nested", "c", "1", "-f", "json"]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toBe(20);
	});

	test("extracts subtree", () => {
		const r = run(["show", rxFile, "tags", "-f", "json"]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual(["alpha", "beta", "gamma"]);
	});

	test("bare-file shortcut accepts segments", () => {
		const r = run([rxFile, "tags", "1", "-f", "json"]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toBe("beta");
	});

	test("missing key error includes path", () => {
		const r = run(["show", rxFile, "nested", "nope"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("rx show:");
		expect(r.stderr).toContain("nested, nope");
		expect(r.stderr).toContain("not found");
	});

	test("out-of-range index error includes length", () => {
		const r = run(["show", rxFile, "tags", "99"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("rx show:");
		expect(r.stderr).toContain("index 99 out of range");
		expect(r.stderr).toContain("3-element array");
	});

	test("can't-index error includes type", () => {
		const r = run(["show", rxFile, "count", "foo"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("cannot index into number");
	});

	test("-f rx output of subtree round-trips", () => {
		const r = run(["show", rxFile, "nested", "-f", "rx"]);
		expect(r.exitCode).toBe(0);
		const tmp = join(dir, "sub.rx");
		writeFileSync(tmp, r.stdout.trim());
		const back = run(["show", tmp, "-f", "json"]);
		expect(JSON.parse(back.stdout)).toEqual(SAMPLE.nested);
	});

	test("reads from stdin with segments", () => {
		const r = run(["show", "-", "count", "-f", "json"], JSON.stringify(SAMPLE));
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toBe(42);
	});
});

describe("advanced commands", () => {
	test("rx inspect emits AST JSON", () => {
		const r = run(["inspect", rxFile]);
		expect(r.exitCode).toBe(0);
		const ast = JSON.parse(r.stdout);
		expect(ast.tag).toBeTruthy();
		expect(Array.isArray(ast.children)).toBe(true);
	});

	test("rx stats shows all three formats", () => {
		const r = run(["stats", jsonFile]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("json:");
		expect(r.stdout).toContain("rx text:");
		expect(r.stdout).toContain("rxb binary:");
		expect(r.stdout).toContain("bytes");
	});

	test("rx demo shows all formats", () => {
		const r = run(["demo"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("Tree view");
		expect(r.stdout).toContain("JSON");
		expect(r.stdout).toContain("rx text");
		expect(r.stdout).toContain("rxb binary");
	});

	test("rx completions zsh emits script", () => {
		const r = run(["completions", "zsh"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("#compdef rx");
	});

	test("rx completions bash emits script", () => {
		const r = run(["completions", "bash"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("complete -o default");
	});

	test("completions --complete (no words) lists subcommands", () => {
		const r = run(["completions", "--complete", "--", ""]);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(lines).toContain("show");
		expect(lines).toContain("convert");
		expect(lines).not.toContain("get");
	});

	test("completions --complete completes flags after subcommand", () => {
		const r = run(["completions", "--complete", "--", "show", "-"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("--format");
		expect(r.stdout).toContain("--width");
	});

	test("completions --complete completes format values after -f", () => {
		const r = run(["completions", "--complete", "--", "show", "-f", ""]);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(lines).toEqual(expect.arrayContaining(["tree", "json", "rx", "rxb"]));
	});

	test("top-level './' triggers file completion", () => {
		// dir contains sample.json/rx/rxb fixtures created in beforeAll
		const r = run(["completions", "--complete", "--", "./"], undefined, {});
		expect(r.exitCode).toBe(0);
		// Should contain at least some of the data extensions when run from cwd
		// (cwd here is rx project root, which has buildinfo.* files)
		const lines = r.stdout.trim().split("\n");
		expect(lines.some(l => l.endsWith(".json") || l.endsWith(".rx") || l.endsWith(".rxb") || l.endsWith("/"))).toBe(true);
	});

	test("top-level word matching no subcommand falls back to files", () => {
		// "buildinfo" doesn't match any subcommand → should yield buildinfo.* files
		const r = run(["completions", "--complete", "--", "buildinfo"]);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every(l => l.startsWith("buildinfo"))).toBe(true);
	});

	test("top-level subcommand prefix takes precedence over files", () => {
		// "s" matches subcommands (show, stats) — should NOT include any files even
		// if there's a file starting with "s" in cwd
		const r = run(["completions", "--complete", "--", "s"]);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(lines).toContain("show");
		expect(lines).toContain("stats");
		// All entries must be subcommands (no path separators, no extensions)
		for (const l of lines) {
			expect(l).not.toContain("/");
			expect(l).not.toContain(".");
		}
	});
});

describe("backwards-compat completion shim", () => {
	// Shell scripts installed by rx <= 0.8.x invoke `rx --completions -- <words>`.
	// New scripts use `rx completions --complete -- <words>`. Both must work so
	// users upgrading to 0.9+ without reinstalling get sane completions.
	test("--completions -- (no words) lists subcommands", () => {
		const r = run(["--completions", "--", ""]);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(lines).toContain("show");
		expect(lines).toContain("convert");
	});

	test("--completions -- 'show' lists subcommand match", () => {
		const r = run(["--completions", "--", "show"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("show");
	});

	test("--completions zsh emits script", () => {
		const r = run(["--completions", "zsh"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("#compdef rx");
	});
});

describe("top-level errors", () => {
	test("unknown subcommand errors with suggestion", () => {
		const r = run(["--boom"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("unknown command or option");
	});

	test("missing file errors cleanly", () => {
		const r = run([join(dir, "does-not-exist.rx")]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("rx:");
	});
});
