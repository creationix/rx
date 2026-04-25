# RX Format Spec

RX is a compact text encoding for JSON-shaped data — objects, arrays, strings, numbers, booleans, `null`. Pointers, chains, refs, and indexes add structural sharing and random access without changing what values can be represented.

RX is the data-layer subset of [REXC bytecode](https://github.com/creationix/rex/blob/rusty/docs/rexc-bytecode.md). REXC adds program-execution tags (variables, opcodes, calls, control flow) on top; every valid RX document is a valid REXC document.

> Paste RX or JSON into **[rx.run](https://rx.run/)** for interactive inspection.

---

## Parsing model

RX is parsed **right-to-left**. Every value has a **tag** character with a **b64 varint** to its right, and optionally a **body** to its left:

```text
[body][tag][b64 varint]
           ◄── read this way ──
```

The parser scans left past b64 digits until it hits a non-b64 byte — that byte is the tag. The tag determines how to interpret the varint and whether a body sits to its left.

The three container tags (`]` `}` `>`) are paired: the parser reads child values right-to-left until it hits the matching opener (`[` `{` `<`).

### Tags

| Tag     | Name    | Layout               | Varint meaning          |
|---------|---------|----------------------|-------------------------|
| `+`     | Integer | `+[varint]`          | zigzag signed           |
| `*`     | Decimal | `[+base]*[varint]`   | zigzag exponent         |
| `,`     | String  | `[utf8],[varint]`    | byte length             |
| `'`     | Ref     | `'[name]`            | b64 name (not a number) |
| `^`     | Pointer | `^[varint]`          | byte offset delta       |
| `[` `]` | Array   | `[children]`         | — (paired)              |
| `{` `}` | Object  | `{children}`         | — (paired)              |
| `<` `>` | Chain   | `<segments>`         | — (paired)              |
| `.`     | Schema  | `[keys].[varint]`    | byte length             |
| `#`     | Index   | `[entries]#[varint]` | packed count+width      |
| `@`     | Bytes   | `[b64body]@[varint]` | byte length of body     |

Eleven tag characters total (`]` `}` `>` are the tags; `[` `{` `<` are end markers for the container scan).

### Worked example

Parse `[world,5hi,2]` right-to-left:

| Scan       | Tag | Varint | Action                          |
|------------|-----|--------|---------------------------------|
| `…]`       | `]` | —      | array open; read children       |
| `…hi,2`    | `,` | `2`    | read 2 bytes left → `"hi"`      |
| `…world,5` | `,` | `5`    | read 5 bytes left → `"world"`   |
| `[…`       | `[` | —      | array close → `["hi", "world"]` |

Children are written in reverse byte order so that R-to-L parsing yields them in natural forward order.

### Why right-to-left

The root of a document is its rightmost byte. Appending bytes to the right produces a new valid document whose root is the new content — and pointers in the appended bytes can reference any earlier byte via a backward delta. This makes RX naturally append-only: revisions deduplicate against all prior bytes for free, with no rewriting.

It also keeps encoding simple: the encoder writes left-to-right via depth-first, post-order traversal.

---

## Building blocks

### B64 alphabet

```
0-9 a-z A-Z - _
```

64 URL-safe characters, ordering extends hexadecimal.

### Varint

Zero or more b64 digits, big-endian. **Zero is the empty string.** Signed values use zigzag on top: `0 → 0, -1 → 1, 1 → 2, -2 → 3, …`.

| Decimal | Zigzag | B64        |
|---------|--------|------------|
| 0       | 0      | *(empty)*  |
| 1       | 2      | `2`        |
| -1      | 1      | `1`        |
| 42      | 84     | `1k`       |
| -256    | 511    | `7_`       |

---

## Primitives

### Integer `+`

Zigzag-encoded signed integer.

| JSON   | RX    |
|--------|-------|
| `0`    | `+`   |
| `1`    | `+2`  |
| `-1`   | `+1`  |
| `42`   | `+1k` |
| `-256` | `+7_` |

### Decimal `*`

A decimal requires an adjacent `+` value to its left. The varint to the right of `*` is the zigzag exponent; the `+` value to the left is the base. Value is `base × 10^exp`.

Special floats use refs: `'inf` (+∞), `'nif` (−∞), `'nan` (NaN).

| JSON   | RX      | Base | Exp |
|--------|---------|------|-----|
| `1000` | `+vg`   | 1000 | —   |
| `3.14` | `+9Q*3` | 314  | -2  |
| `-0.5` | `+9*1`  | -5   | -1  |
| `1e6`  | `+2*c`  | 1    | 6   |

### String `,`

Raw UTF-8 body. The varint is the **byte length** (not character count).

| JSON            | RX              |
|-----------------|-----------------|
| `""`            | `,`             |
| `"hi"`          | `hi,2`          |
| `"hello world"` | `hello world,b` |
| `"café"`        | `café,5`        |
| `"🎉"`          | `🎉,4`          |

### Ref `'`

The bytes to the right of `'` form a **name** of b64 characters, not a numeric value. Built-in names resolve to literals (`'t`, `'f`, `'n`, `'u`, `'inf`, `'nif`, `'nan`). Other names are application-defined; they may resolve to a value from a shared external dictionary, or to an opaque host symbol (e.g. a JS `Symbol`, an interned token) that the application uses as an identity marker. The encoder and decoder need only agree on the meaning of each name they use.

| Value       | RX     |
|-------------|--------|
| `true`      | `'t`   |
| `false`     | `'f`   |
| `null`      | `'n`   |
| `undefined` | `'u`   |
| `+Infinity` | `'inf` |
| `-Infinity` | `'nif` |
| `NaN`       | `'nan` |

---

## Containers

Containers use paired delimiters — no length prefix. Children are written in reverse byte order so that R-to-L parsing yields them forward.

### Array `[` `]`

Ordered children.

An array may have an optional [index](#index-) at the right end of the body for O(1) random access.

| JSON                          | RX              |
|-------------------------------|-----------------|
| `[]`                          | `[]`            |
| `[1, 2, 3]`                   | `[+6+4+2]`      |
| `[1, 2, 3]` with forced index | `[+6+4+2420#o]` |

### Object `{` `}`

Ordered key/value pairs. Keys are typically strings but may be pointers or chains resolving to strings.

An object may have an optional [index](#index-) for O(log n) key lookup, **or** a [schema](#schema) for shape sharing.

| JSON                                    | RX                                   |
|-----------------------------------------|--------------------------------------|
| `{}`                                    | `{}`                                 |
| `{"a":1,"b":2}`                         | `{+4b,1+2a,1}`                       |
| `{"users":["alice","bob"],"version":3}` | `{+6version,7[bob,3alice,5]users,5}` |
| `{"z":1,"a":2,"m":3}`with forced index  | `{+6m,1+4a,1+2z,10a5#o}`             |
| `[{"a":1,"b":2},{"a":3,"b":4}]`         | `[{+8+6b,a.3}{+4+2^6}]`              |

### Chain `<` `>`

A concatenated value built from string and bytes segments. Each segment is a string, bytes, a pointer to one of these, or a nested chain.

The result type is determined by segment composition: **if any segment resolves to bytes, the result is bytes** (string segments are taken as their UTF-8 byte representation). Otherwise the result is a string (UTF-8 concatenation).

Chains let scattered values share common substrings or byte sequences via pointers — useful for path-like values (URLs, file paths, identifiers) and for binary protocols where many blobs share a header, signature, IV, or other prefix.

| Value                     | RX                                       |
|---------------------------|------------------------------------------|
| `"/docs/getting-started"` | `<getting-started,f/docs/,6>`            |
| `"/docs/encoding"`        | `<encoding,8^k>` (`^k` → `/docs/` above) |

---

## Sharing and random access

### Pointer `^`

Backward delta in bytes from the left of the pointer's tag to the target's right edge:

```
target_right = tag_position - delta
```

Parse R-to-L from `target_right`. Pointers enable value deduplication, schema sharing, chain prefix sharing, and cross-revision dedup.

| JSON                                      | RX                     |
|-------------------------------------------|------------------------|
| `["word","salad","word","salad","salad"]` | `[salad,5^word,4^7^2]` |

The first `"salad"` is written once at the left; each duplicate becomes a pointer back to an earlier copy. `^` with an empty varint is a valid pointer with delta 0 — used when the duplicate sits immediately to the right of its source.

### Index `#`

Lookup table for a container, appearing as the rightmost child inside the container body.

The compound varint packs:

```
compound = (count << 3) | (width - 1)
```

Each entry is a fixed-width b64 backward delta from the **index base** (the right edge of the child immediately to the left of the index). To resolve entry *i*: `target_right = index_base - entry[i]`.

Entries are stored in reverse natural order so that R-to-L scanning yields them forward — the rightmost entry holds the delta for element 0 (arrays) or for the first sorted key (objects). For random access, entry *i* sits at position `ix_tag - (i+1) * width`, where `ix_tag` is the position of the `#` byte.

| Container | R-to-L entry order | Access                 |
|-----------|--------------------|------------------------|
| Array     | element order      | O(1)                   |
| Object    | UTF-8 key order    | O(log n) binary search |

Examples:

```
[+6+4+2420#o]           → [1, 2, 3]          R-to-L deltas [0, 2, 4], width 1
{+6m,1+4a,1+2z,10a5#o}  → {z:1, a:2, m:3}    R-to-L sorted by key (body keeps insertion order)
```

### Schema

The schema tag `.` encodes a comma-delimited list of keys as the body. The varint is the body's byte length, same as a string.

Keys are stored in **reverse natural order** so that scanning the body R-to-L for delimiters yields keys in lockstep with R-to-L value parsing — the parser pairs each key with the next value as it goes.

| Keys                  | RX schema        |
|-----------------------|------------------|
| `["a"]`               | `a.1`            |
| `["a", "b"]`          | `b,a.3`          |
| `["color", "fruits"]` | `fruits,color.c` |

A schema object stores only its values, with a schema reference as its rightmost child — either an inline schema (`.`) or a pointer (`^`) that resolves to one.

A schema object cannot also carry an index; its values are read sequentially. Keys cannot contain commas (the schema delimiter).

The encoder detects shared key sets automatically. The first object with a given key set embeds the schema inline; subsequent objects with the same keys store only values plus a pointer to that schema.

```json
[{"z":1,"a":2,"m":3},{"z":4,"a":5,"m":6}]
```

```
[{+c+a+8m,a,z.5}{+6+4+2^8}]
```

- Left object embeds schema `m,a,z.5` (keys reversed) followed by its values.
- Right object stores only values plus `^8`, a pointer to the schema in the left object.

Key lookup in a schema object is O(n) — scan the schema for the key's position, then walk N values to reach the corresponding value.

### Bytes `@`

A binary data value. The body is URL-safe b64 chars (no padding); the varint is the body's length in chars (same convention as a string's byte length).

Decoders b64-decode the body to recover the original bytes. The b64 alphabet is the same one RX uses for varints — `0-9 a-z A-Z - _` — so the body is parser-safe: the parser hits `@` before scanning into the body, identical to how strings work.

Decoded byte count derives from the body length L:

| L mod 4 | Decoded bytes        |
|---------|----------------------|
| 0       | L × 3 / 4            |
| 2       | (3L − 2) / 4         |
| 3       | (3L − 1) / 4         |
| 1       | invalid (no padding) |

| Decoded    | Body chars | Total RX                |
|------------|-----------:|-------------------------|
| `[]` (0B)  |          0 | `@` (1 byte)            |
| 1 byte     |          2 | `[b64×2]@2` (4 bytes)   |
| 16B (UUID) |         22 | `[b64×22]@m` (24 bytes) |
| 32B (hash) |         43 | `[b64×43]@H` (45 bytes) |

Use the bytes tag for hashes, UUIDs, signatures, encrypted payloads, image thumbnails, and other binary blobs that would otherwise be wrapped in a hex or base64 string. Tooling can render bytes nodes distinctly from strings (hex view, hex-dump, raw bytes), and applications receive a typed bytes value (`Uint8Array`, `bytes`, `[]u8`, etc.) rather than a string they have to decode.

### External refs

Encoders and decoders can share a dictionary of values. When a value matches a dictionary entry by structural equality, the encoder writes `'name` instead of embedding it; the decoder reconstructs from the same dictionary.

Pointers already dedup within a document. Refs are for:

- Opaque values that aren't directly serializable
- Values shared across multiple documents

---

## Append-only revisions

Publishing a new revision:

1. Start with the existing bytes.
2. Append new bytes to the right.
3. The new root is whatever value the new rightmost bytes form.

Appended content can point back to old content for free — backward deltas naturally span revisions because old bytes stay at their original offsets. Readers who want an older revision truncate at that byte offset; earlier bytes are still a valid RX document for that revision.

---

## Relationship to REXC

RX defines these eleven tags for data:

```
+ * , . ' ^ # @ ] } >
```

plus three opener markers (`[ { <`) that close container scans.

REXC extends RX with bytecode tags for computation (variables, opcodes, calls, control flow) in a disjoint character set (`$ % ( ) ? & | : = …`) — these never appear in pure RX. Both formats share parse rules, so every RX document parses identically as a REXC document with no bytecode features.
