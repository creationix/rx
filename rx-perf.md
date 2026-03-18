# RX Architecture

Zero-allocation cursor-based REXC parser with a Proxy wrapper for transparent JS interop.

## Design Principles

- **Zero heap allocations per node visited.** `read()` fills a mutable cursor struct — no objects created.
- **Portable to LuaJIT.** Simple functions, no closures in the hot path, no object creation. Lua metatables replicate the Proxy layer.
- **Interned string tags.** Short strings (`"int"`, `"str"`, `"array"`, etc.) are cheap as identifiers in both V8 and LuaJIT, but readable in debuggers.
- **Lazy everything.** The Proxy layer does no work until a property is accessed. A 35K-key manifest can be "parsed" and a single key looked up in 3 microseconds.

## Layers

```
┌─────────────────────────────────────────┐
│  JS code: data.routes[0].handler        │  ← normal property access
├─────────────────────────────────────────┤
│  Proxy layer (open)                     │  ← metatables in Lua
│  - wraps NodeInfo in Proxy/metatable    │
│  - resolves pointers, refs, schemas     │
│  - memoizes container Proxies           │
│  - delegates Array.prototype methods    │
├─────────────────────────────────────────┤
│  Cursor API                             │  ← the core
│  - read(), findKey(), seekChild()       │
│  - strEquals(), strCompare()            │
│  - collectChildren(), findByPrefix()    │
├─────────────────────────────────────────┤
│  Uint8Array buffer                      │  ← the data
│  (one flat allocation, no GC pointers)  │
└─────────────────────────────────────────┘
```

## Cursor

A cursor is a mutable struct with 8 fields. `read()` fills it in, `makeCursor()` creates one:

```ts
interface Cursor {
  data: Uint8Array;  // buffer reference
  left: number;      // start of this node (output of read)
  right: number;     // end of this node (input to read)
  tag: Tag;          // node type
  val: number;       // tag-dependent value
  ixWidth: number;   // index entry width (0 = no index)
  ixCount: number;   // number of index entries
  schema: number;    // right-offset of schema node (0 = none)
}
```

All fields are monomorphic numbers (except `data` and `tag`). This gives V8 a stable hidden class and LuaJIT a predictable layout.

### Tag semantics

| Tag | `val` | How to read further |
|-----|-------|---------------------|
| `"int"` | signed integer (zigzag decoded) | Done — `val` is the value |
| `"float"` | float value | Done — includes `Infinity`, `-Infinity`, `NaN` |
| `"str"` | byte length | Raw UTF-8 at `data[left..left+val)`. Call `readStr(c)` to decode |
| `"ref"` | byte length | Name at `data[left+1..left+1+val)`. Builtins (`'t`,`'f`,`'n`,`'u`,`'inf`,`'nif`,`'nan`) resolve to their tag during `read()` |
| `"true"` / `"false"` / `"null"` / `"undef"` | — | Tag is the value |
| `"array"` | content boundary | Iterate: set `right`, call `read()`, advance to `left` |
| `"object"` | content boundary | Same, but key/value interleaved. `schema` and `ixWidth`/`ixCount` may be set |
| `"ptr"` | target offset | Resolve: `c.right = c.val; read(c)` |
| `"chain"` | content boundary | Concatenated string segments — iterate like a container |

### Internal scratch cursors

Three module-level cursors avoid allocations in internal functions:

- `_k` — key/temp cursor (used by `findKey`, `read` for index/schema parsing)
- `_s` — schema cursor (used by `findKey` for schema traversal)
- `_cc` — collectChildren cursor (separate from `_k` to avoid conflict)

Safe because JS is single-threaded and these functions don't re-enter each other on the same cursor.

## Container Iteration

REXC is read right-to-left in byte order. The natural read direction (decreasing byte offsets) yields children in their original logical order — first child first:

```ts
const end = c.left;
let right = c.val;
while (right > end) {
  c.right = right;
  read(c);
  // process node
  right = c.left;
}
```

For objects without a schema, children alternate: key, value, key, value. Use two cursors for simultaneous key+value access.

## Indexed Containers

Containers with `ixWidth > 0` have a sorted index table embedded after the content. Each entry is a fixed-width b64 delta from the content boundary.

- **`seekChild(c, container, index)`** — O(1) random access via the index table.
- **`ixCount`** — number of entries.
- Object indexes point to keys; keys are sorted in UTF-8 byte order.

## String Operations

All comparison functions operate on raw buffer bytes — zero allocations:

- **`prepareKey(target)`** — encode a JS string to UTF-8 bytes once. Pass the result to comparison functions.
- **`strEquals(c, key)`** — exact match.
- **`strCompare(c, key)`** — ordering (`<0`, `0`, `>0`). Used for binary search.
- **`strHasPrefix(c, prefix)`** — prefix match.

All three handle `str`, `ptr`, and `chain` nodes transparently via `nodeCompare`, which walks chain segments and follows pointers without allocating.

- **`readStr(c)`** — decode to JS string (1 allocation). Only when you need the actual string.
- **`resolveStr(c)`** — follow pointers, concatenate chains, then decode.

## Key Lookup: `findKey`

`findKey(c, container, target)` finds a key in an object and positions `c` at the value node.

**Strategy selection is automatic:**

1. **Sorted + indexed, no schema** (`ixWidth > 0`, `schema === 0`): Binary search via `seekChild` + `strCompare`. O(log n). ~15 comparisons for 35K keys.

2. **Schema objects** (`schema !== 0`): Linear scan that reads keys from the schema node (which may be a pointer to another object's key layout, or a ref to an external dictionary) while stepping through values in the content. Handles both object-shaped and array-shaped schemas.

3. **Non-indexed, no schema**: Linear scan through interleaved key/value pairs. O(n).

All paths handle pointer keys, chain keys, and ref keys.

## Prefix Search: `findByPrefix`

`findByPrefix(c, container, prefix, visitor)` calls `visitor(key, value)` for each key matching the prefix.

- **Indexed**: Binary search to find the first key `>= prefix`, then iterate forward while `strHasPrefix` matches. O(log n + m).
- **Non-indexed**: Linear scan with `strHasPrefix` on each key. O(n).

The visitor can return `false` to stop early.

## Proxy Layer: `open()`

`open(buffer, refs?)` returns a Proxy-wrapped root value that behaves like a normal JS object.

### NodeInfo

Each Proxy wraps a `NodeInfo` — a frozen snapshot of cursor state at the time of first access:

```ts
type NodeInfo = {
  data: Uint8Array;
  right: number;
  tag: Tag;
  val: number;
  left: number;
  ixWidth: number;
  ixCount: number;
  schema: number;
  // Lazily populated caches:
  _count?: number;        // child count
  _offsets?: number[];     // collectChildren result
  _keys?: string[];        // enumerated key strings
  _keyMap?: Map<string, number>;  // key → value right-offset
};
```

A single shared `scratch` cursor (per `open()` call) is reused across all trap operations.

### Proxy target trick

Arrays use `[]` as the Proxy target; objects use `Object.create(null)`. This makes `Array.isArray()` return `true` for array Proxies. The actual `NodeInfo` is stored in a `WeakMap<object, NodeInfo>`.

### Memoization

- **Container Proxies** are cached by `right`-offset in a `Map<number, unknown>`. Repeated access to `obj.nested` returns the same Proxy instance.
- **Pointer dedup** is free — pointers resolve to the same `right`-offset, so the cache deduplicates automatically.
- Primitives are not cached (cheap to recreate).

### Trap behavior

**`get(target, prop)`**:
- `HANDLE` symbol → return `{ data, right }` escape hatch
- `Symbol.iterator` → generator yielding values (arrays) or `[key, value]` pairs (objects)
- `"length"` → child count (arrays and objects)
- Number string on array → `getChild` (indexed: `seekChild`, non-indexed: `collectChildren` + offset lookup)
- String on object → `getValue` (non-schema: `findKey` with O(log n) binary search; schema: lazy `ensureKeyMap` then map lookup)
- Array.prototype method name → materialize array, delegate to method

**`has(target, prop)`**:
- Object: `findKey` (zero-alloc, no value read) or `_keyMap.has()`
- Array: bounds check

**`ownKeys(target)`**:
- Object: `ensureKeyMap()` → return cached `_keys` array
- Array: `["0", "1", ..., "length"]`

**`set` / `deleteProperty`**: throw `TypeError("rexc data is read-only")`

### Schema and ref resolution

Schema objects store only values in their content — keys come from the schema node. The Proxy layer's `ensureKeyMap` resolves schemas:

- **Pointer schema** (`^` tag): follow pointer to the referenced object, read its keys.
- **Ref schema** (`'` tag): look up in the `refs` dictionary. If it's an array, use as key list. If it's an object, use `Object.keys()`.
- **Inline schema** (object or array): read keys directly from the schema's content.

The resolved keys are cached in `_keys` and `_keyMap` for subsequent access.

### Array.prototype delegation

When an array Proxy receives a method name like `map`, `filter`, `find`, `reduce`, `slice`, etc., the `get` trap materializes the array into a plain JS array and delegates the method call. This is a one-shot cost per method invocation — the materialized array is not cached.

### Escape hatch

```ts
import { handle } from "@creationix/rx";

const h = handle(proxyValue);
// h.data: Uint8Array — the buffer
// h.right: number — byte offset of this node
// Use with makeCursor + read for performance-critical code
```

## Allocation Profile

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
| Proxy `get` on primitive | 0 or 1 string |
| Proxy `get` on container (first) | 1 NodeInfo + 1 Proxy |
| Proxy `get` on container (repeat) | 0 (cached) |
| `ownKeys` / `Object.keys()` | 1 string[] + N strings (cached for repeat) |
| `has` / `in` operator | 0 |

For a single key lookup on a 35K-key indexed object: `open()` + one property access = 1 Proxy (root) + 1 `findKey` (0 alloc) + 1 `readStr` (1 string) = **2 allocations total**.

## Encoder

`stringify(value, options?)` and `encode(value, options?)` serialize JS values to REXC.

### Automatic optimizations

- **String deduplication**: identical strings are written once; subsequent occurrences become `^` pointers.
- **Shared schemas**: objects with identical key sets share a schema pointer — later objects store only values, referencing the first object's key layout.
- **Path chains**: strings containing a `chainSplit` delimiter (default `"/"`) with shared prefixes are split into chain nodes, compressing URL paths and file paths.
- **Sorted indexes**: when `indexes` is set, containers at or above the threshold get a sorted index table enabling O(log n) lookup.
- **Exponent encoding**: integers with trailing zeroes (e.g. `1000000`) and all floats use `mantissa * 10^exponent` form.

### External refs

```ts
const refs = { R: someValue };
stringify(data, { refs });
```

When a value matches a ref entry (by identity via `makeKey`), it's encoded as `'R` instead of the full value. Refs can be strings, numbers, objects, arrays, functions, or symbols — anything matchable by identity.

Ref arrays/objects can also serve as schema targets: `stringify({ a: 1, b: 2 }, { refs: { S: ["a", "b"] } })` encodes the object with `'S` as its schema.
