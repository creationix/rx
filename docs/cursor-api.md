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

See [rx-perf.md](../rx-perf.md) for detailed design notes on the cursor internals, Proxy wrapper, and full allocation profile.
