# @creationix/rx

[![rx tests](https://github.com/creationix/rex/actions/workflows/rx-test.yml/badge.svg)](https://github.com/creationix/rex/actions/workflows/rx-test.yml)

REXC encoder, decoder, and data tool. Drop-in replacements for `JSON.stringify` and `JSON.parse` that produce smaller output, skip deserialization on read, and create near-zero heap allocations.

## Why

JSON forces a tradeoff: parse everything up front (slow, memory-heavy) or don't cache at all. REXC eliminates the tradeoff:

- **18x smaller** — binary-encoded numbers, de-duplicated strings, shared schemas, prefix-compressed paths.
- **23,000x faster single-key lookup** — O(log n) binary search on sorted indexes, directly on the encoded bytes. No parse step.
- **Near-zero heap pressure** — the parsed result is a Proxy over a flat byte buffer. The GC doesn't trace its contents.

Benchmarked on a real production dataset: a 35,000-key website deployment manifest.

## Install

```sh
npm install @creationix/rx     # library
npm install -g @creationix/rx  # CLI (global)
npx @creationix/rx data.rx     # CLI (one-off)
```

## Quick Start

### Encoding (drop-in for `JSON.stringify`)

```ts
import { stringify } from "@creationix/rx";

const payload = stringify({ users: ["alice", "bob"], version: 3 });
// Returns a string — store it anywhere you'd store JSON
```

### Decoding (drop-in for `JSON.parse`)

```ts
import { parse } from "@creationix/rx";

const data = parse(payload) as any;
data.users[0]         // "alice"
data.version          // 3
Object.keys(data)     // ["users", "version"]
JSON.stringify(data)  // works — full JS interop
```

The returned value supports property access, `Object.keys()`, `Object.entries()`, `for...of`, `for...in`, `Array.isArray()`, `.map()`, `.filter()`, `.find()`, `.reduce()`, spread, destructuring, and `JSON.stringify()`. Existing code that consumes the parsed result doesn't need to change.

## CLI Usage

```sh
rx data.rx                         # pretty-print as tree
rx data.rx -j                      # convert to JSON
rx data.json -r                    # convert to REXC
cat data.rx | rx                   # read from stdin (auto-detect)
rx data.rx -s key 0 sub            # select a sub-value
rx data.rx -o out.json             # write to file
```

See [CLI Reference](#cli-reference) below for full options.

**Tip:** Add a shell function for quick paged, colorized viewing that works on both `.json` and `.rx` files.  To install paste this into your shell profile. 

```sh
p() { rx "$1" -t -c | less -RFX; }
# p data.rx          — pretty-print with color, auto-pages large output
```

There is also a web-based viewer in development for inspecting REXC documents with expandable tree navigation, syntax-highlighted node types, and tabs for raw REXC, JSON, and ref dictionaries:

![REXC Viewer — interactive tree inspector showing a website deployment manifest with chain-compressed paths, pointer deduplication, and nested object metadata](rexc-viewer-screenshot.png)

### Binary API

For performance-critical paths or when working with `Uint8Array` buffers directly:

```ts
import { encode, decode, open } from "@creationix/rx";

// encode returns Uint8Array (no string conversion)
const buf = encode({ path: "/api/users", status: 200 });

// decode/open take Uint8Array, return Proxy-wrapped value
const data = open(buf) as any;
data.path    // "/api/users"
data.status  // 200
```

## Encoding Options

```ts
import { stringify, encode } from "@creationix/rx";

// Add sorted indexes to containers with >= 10 entries (enables O(log n) key lookup)
stringify(data, { indexes: 10 });

// Always index, even small containers
stringify(data, { indexes: 0 });

// Disable indexes entirely
stringify(data, { indexes: false });

// External refs — shared dictionary of known values
const refs = { R: ["/api/users", "/api/teams"] };
stringify(data, { refs });

// Streaming — receive chunks as they're produced
stringify(data, {
  onChunk: (chunk, offset) => process.stdout.write(chunk),
});
```

Both `stringify` and `encode` accept the same options. `stringify` returns a string; `encode` returns a `Uint8Array`.

## Decoding with Refs

If the encoder used external refs, pass the same dictionary to the decoder:

```ts
const refs = { R: ["/api/users", "/api/teams"] };
const data = parse(payload, { refs });
```

Ref values are returned as-is — they can be strings, numbers, objects, arrays, or even functions and symbols.

## Proxy Behavior

The Proxy returned by `parse`/`decode`/`open` is read-only and behaves like a frozen JS object:

```ts
const obj = parse(payload) as any;

obj.newKey = 1;     // throws TypeError("rexc data is read-only")
delete obj.key;     // throws TypeError("rexc data is read-only")

"key" in obj;       // works (uses zero-alloc key search)
```

Containers are memoized — repeated access to the same property returns the same Proxy instance:

```ts
obj.nested === obj.nested  // true
```

### Escape hatch to raw data

```ts
import { handle } from "@creationix/rx";

const h = handle(obj.nested);
// h.data: Uint8Array — the underlying buffer
// h.right: number — byte offset of this node
```

## Inspect API

The `inspect()` function returns a lazy AST that maps 1:1 to the REXC byte encoding. Each node corresponds to exactly one tag+b64 pair in the byte stream — pointers stay as pointers, chains stay as chains, `null` is a ref named `"n"`, etc.

```ts
import { encode, inspect } from "@creationix/rx";

const buf = encode({ name: "alice", scores: [10, 20, 30] });
const root = inspect(buf);
```

### Node properties

Each node exposes the raw encoding structure:

| Property | Type | Description |
|----------|------|-------------|
| `tag` | `string` | Single-character tag: `+` `*` `,` `'` `:` `;` `^` `.` `#` |
| `b64` | `number \| string \| {count, width}` | Decoded b64 payload (signed/unsigned/string/compound) |
| `left` | `number` | Byte offset of the tag byte |
| `right` | `number` | Byte offset after the node |
| `size` | `number` | Byte length of content preceding the tag |
| `data` | `Uint8Array` | Backing buffer (non-enumerable) |
| `value` | `unknown` | Resolved JS value via `open()` — lazy |

### Array-like children

Each node acts like an array of its structural children:

```ts
root.tag       // ":"
root[0].tag    // "," (first child — a string key)
root[0].value  // "name"
root.length    // 4 (key, value, key, value)

for (const child of root) {
  console.log(child.tag, child.b64);
}

JSON.stringify(root)  // recursive tree of {tag, b64, left, right, size, children}
```

Children are parsed lazily and cached incrementally — accessing `node[5]` only parses children 0–5. Subsequent access to `node[2]` is instant from cache.

Tags with parseable children: `:` (object), `;` (array), `.` (chain), `*` (decimal), `#` (index).
All other tags (`,` `+` `'` `^`) have zero children regardless of `size`.

### Structural vs semantic

The children array is purely structural — it yields whatever is in the bytes, in read order (right-to-left). For objects, this includes interleaved key/value nodes, `#` index nodes, and schema ref/pointer nodes as peers.

For semantic access, use the utility methods:

```ts
// Object utilities — return ASTNodes, not resolved values
for (const key of root.keys()) { ... }
for (const val of root.values()) { ... }
for (const [key, val] of root.entries()) {
  console.log(key.value, val.value);
}

// Prefix search — O(log n + m) on indexed objects
for (const [key, val] of root.filteredKeys("/api/")) { ... }

// Indexed access — O(1) on indexed containers
const node = root.index("name");   // object key lookup
const elem = root.index(2);        // array index
```

These methods understand schemas, use binary search on indexed containers, and skip metadata nodes.

### CLI

```sh
rx data.rexc --ast            # output the encoding structure as JSON
rx data.json --ast            # encode to rexc first, then inspect
echo '{"x":1}' | rx --ast    # from stdin
```

## Base64 Utilities

A compact base64 number encoding used internally by the REXC format, exported from the main module:

```ts
import { b64Stringify, b64Parse, b64Sizeof, toZigZag, fromZigZag } from "@creationix/rx";

b64Stringify(255)  // "3V"
b64Parse("3V")     // 255
b64Sizeof(255)     // 2 (digits needed)

toZigZag(-1)    // 1 (signed → unsigned)
fromZigZag(1)   // -1 (unsigned → signed)
```

The alphabet is `0-9a-zA-Z-_` (URL-safe, no padding). Numbers are big-endian with zero represented as an empty string. Zigzag encoding maps signed integers to unsigned values so negative numbers stay compact.

## Low-Level Cursor API

For zero-allocation traversal, streaming output, or byte-slicing passthrough, use the cursor API directly. The cursor is a mutable struct that the parser fills in — no objects are created per node visited.

```ts
import {
  makeCursor, read, readStr, resolveStr,
  strEquals, strCompare, strHasPrefix, prepareKey,
  findKey, findByPrefix, seekChild, collectChildren,
  rawBytes,
} from "@creationix/rx";
```

### Basics

```ts
const c = makeCursor(data);  // one allocation, c.right = data.length
read(c);                     // parse root node
// c.tag, c.left, c.right, c.val, c.ixWidth, c.ixCount, c.schema
```

`read()` is always zero-alloc. It classifies the node and sets cursor fields:

| Tag | `val` | Notes |
|-----|-------|-------|
| `"int"` | signed integer | zigzag decoded |
| `"float"` | float value | includes `Infinity`, `-Infinity`, `NaN` |
| `"str"` | byte length | raw UTF-8 at `data[left..left+val)` |
| `"true"` / `"false"` / `"null"` / `"undef"` | — | tag says it all |
| `"array"` / `"object"` | content boundary | iterate children below `val` |
| `"ptr"` | target offset | resolve: `c.right = c.val; read(c)` |
| `"chain"` | content boundary | concatenated string segments |

### Iterating containers

```ts
// After read() returned "array" or "object":
const end = c.left;
let right = c.val;
while (right > end) {
  c.right = right;
  read(c);
  // process c.tag, c.val, etc.
  right = c.left;
}
```

For objects without a schema, children alternate: key, value, key, value (in iteration order).

### Random access

```ts
// Indexed containers: O(1) access via index table
seekChild(child, container, index);

// Non-indexed: collect boundaries, then access by index
const offsets: number[] = [];
const count = collectChildren(container, offsets);
c.right = offsets[i];
read(c);
```

### String operations

All comparison functions take pre-encoded UTF-8 bytes for zero-alloc repeated use:

```ts
const key = prepareKey("myKey");     // encode once

strEquals(c, key);        // exact match, zero-alloc
strCompare(c, key);       // ordering (<0, 0, >0), zero-alloc
strHasPrefix(c, key);     // prefix check, zero-alloc

readStr(c);               // decode to JS string (1 allocation)
resolveStr(c);            // follow pointers/chains, then decode
```

`findKey` accepts either a string or pre-encoded bytes — it calls `prepareKey` internally when given a string:

```ts
findKey(c, container, "myKey");           // convenient
findKey(c, container, prepareKey("myKey")); // pre-encoded for hot loops
```

### Object key lookup

```ts
const v = makeCursor(data);
if (findKey(v, container, "key")) {
  // v now points at the value node
  // Works on inline keys, schema objects, pointer keys, and chain keys
  // O(log n) on sorted+indexed objects, O(n) linear scan otherwise
}
```

### Prefix search

```ts
findByPrefix(c, container, "/api/", (key, value) => {
  console.log(resolveStr(key), value.val);
  // return false to stop early
});
// O(log n + m) on indexed objects, O(n) on non-indexed
```

### Raw bytes

```ts
rawBytes(c)  // zero-copy Uint8Array view: data.subarray(c.left, c.right)
```

### Allocation summary

| Operation | Allocations |
|-----------|-------------|
| `makeCursor()` | 1 object (reused) |
| `read()` | 0 (always) |
| `readStr()` | 1 string |
| `strEquals()` / `strCompare()` / `strHasPrefix()` | 0 |
| `findKey()` | 0 |
| `seekChild()` | 0 |
| `collectChildren()` | 0 (fills caller-owned array) |
| `rawBytes()` | 0 (subarray view) |

## CLI Reference

### Input

| Form | Description |
|------|-------------|
| `<file>` | File (format auto-detected by contents) |
| `-` | Read from stdin explicitly |
| (no args, piped) | Read from stdin automatically |

### Format

| Flag | Description |
|------|-------------|
| `-j`, `--json` | Output as JSON |
| `-r`, `--rexc` | Output as REXC |
| `-t`, `--tree` | Output as tree (default on TTY) |
| `-a`, `--ast` | Output encoding structure as JSON |
| `--to json\|rexc\|tree\|ast` | Output format (long form) |

Format is auto-detected from file extension (`.json`, `.rx`, `.rexc`) or by content sniffing on stdin. Both `.rx` and `.rexc` are recognized as REXC. Output defaults to tree view on a TTY, JSON when piped.

### Filtering

| Flag | Description |
|------|-------------|
| `-s`, `--select <seg>...` | Select a sub-value (e.g. `-s foo bar 0 baz`) |

### Convert

| Flag | Description |
|------|-------------|
| `-w`, `--write` | Write converted file (`.json`↔`.rx`) |

### Output

| Flag | Description |
|------|-------------|
| `-o`, `--out <path>` | Write to file instead of stdout |
| `-c`, `--color` / `--no-color` | Force or disable ANSI color |
| `-h`, `--help` | Show help message |

### Tuning

| Flag | Default | Description |
|------|---------|-------------|
| `--index-threshold <n>` | 16 | Index objects/arrays above n values |
| `--string-chain-threshold <n>` | 64 | Split strings longer than n into chains |
| `--string-chain-delimiter <s>` | `/` | Delimiter for string chains |
| `--key-complexity-threshold <n>` | 100 | Max object complexity for dedupe keys |

### Shell completions

```sh
rx --completions setup [zsh|bash]    # install tab completions
rx --completions zsh|bash            # print completion script to stdout
```

### Run without installing

```sh
bun run rx data.rx                 # from repo root
```

## Architecture

See [rx-perf.md](rx-perf.md) for detailed design notes on the cursor API, Proxy wrapper internals, and performance characteristics.

## License

MIT
