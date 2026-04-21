# Low-Level Cursor API

For zero-allocation traversal — no Proxy, no objects created per node:

```ts
import {
  makeCursor, read, readStr, resolveStr,
  strEquals, strCompare, strHasPrefix, prepareKey,
  findKey, findByPrefix, seekChild, collectChildren,
  rawBytes,
} from "@creationix/rx";
```

## Reading nodes

```ts
const c = makeCursor(data);   // one allocation, reused for everything
read(c);                      // parse root node — always zero-alloc

// c.tag:  "int" | "float" | "str" | "true" | "false" | "null" | "array" | "object" | "ptr" | "chain"
// c.left: start offset    c.right: end offset    c.val: tag-dependent value
```

## Iterating containers

```ts
// After read() returns "array" or "object":
const end = c.left;
let right = c.val;
while (right > end) {
  c.right = right;
  read(c);
  // process node
  right = c.left;
}
```

## Key lookup and random access

```ts
const v = makeCursor(data);
if (findKey(v, container, "myKey")) {
  // v points at the value — O(log n) on indexed objects, O(n) otherwise
}

seekChild(c, container, 5);    // O(1) indexed array access

findByPrefix(c, container, "/api/", (key, value) => {
  console.log(resolveStr(key), value.val);
  // return false to stop early
});
```

## String operations

```ts
const key = prepareKey("myKey");   // encode once, compare many times
strEquals(c, key);                 // zero-alloc exact match
strCompare(c, key);                // zero-alloc ordering
strHasPrefix(c, key);              // zero-alloc prefix check
readStr(c);                        // decode to JS string (1 allocation)
```

## Allocation summary

| Operation | Allocations |
|-----------|-------------|
| `makeCursor` | 1 (reused) |
| `read`, `findKey`, `seekChild`, `strEquals`, `strCompare`, `strHasPrefix`, `collectChildren`, `rawBytes` | 0 |
| `readStr` | 1 string |

## B64 varint utilities

The variable-length base-64 integer encoding used internally by RX is also exported:

```ts
import { b64Stringify, b64Parse, b64Sizeof, toZigZag, fromZigZag } from "@creationix/rx";

b64Stringify(255)  // "3V"
b64Parse("3V")     // 255
b64Sizeof(255)     // 2 (digits needed)
toZigZag(-1)       // 1
fromZigZag(1)      // -1
```

Alphabet: `0-9a-zA-Z-_` (URL-safe, no padding). Big-endian. Zero is an empty string.

See [rx-perf.md](../rx-perf.md) for detailed design notes on the cursor internals, Proxy wrapper, and full allocation profile.

## RXB equivalents

The binary `.rxb` format exposes the same cursor API with an `rxb` prefix — `rxbMakeCursor`, `rxbRead`, `rxbResolveStr`, `rxbFindKey`, `rxbSeekChild`, etc. Semantics are identical; only the wire format differs. See [rxb-format.md](./rxb-format.md).
