# RXB Format Spec

This document is the formal grammar and encoding reference for the `.rxb` binary format. RXB is a binary variant of the [RX text format](./rx-format.md) — same right-to-left design and data model, but with binary tag+varint encoding for smaller size and faster parsing.

RXB covers the same data model as RX/JSON: maps, lists, strings, numbers, booleans, and `null`. It adds a **hexstring** type for efficient encoding of lowercase hexadecimal data (hashes, UUIDs, etc.).

---

## Reading direction

Like RX, RXB is parsed **right-to-left**. Every value has a **tag+varint** suffix at its right edge, and may have a **body** to its left:

```text
[body][tag+varint bytes]
       ◄── read this way ──
```

---

## Tag+Varint encoding

Tags and values are packed together into a variable-length byte sequence. The **tag byte** (leftmost) has bit 7 clear; **extension bytes** (to its right) have bit 7 set.

### Tag byte (MSB = 0)

```
bit 7     bit 4   bit 0
  0  v₂ v₁ v₀  t₃ t₂ t₁ t₀
  │  └──┬──┘   └────┬────┘
  │   value        tag
  │  bits 0-2    (4 bits)
  └── always 0
```

- **Low 4 bits**: tag type (0x0–0xF)
- **Bits 4–6**: lowest 3 bits of the value
- **Bit 7**: always 0

### Extension bytes (MSB = 1)

```
bit 7     bit 0
  1  d₆ d₅ d₄ d₃ d₂ d₁ d₀
  │  └────────┬────────┘
  │       7 value bits
  └── always 1
```

Extension bytes are written **big-endian** (most significant group leftmost, least significant rightmost). All have bit 7 set.

### Scanning right-to-left

1. Start at `right - 1`. Consume bytes while bit 7 is set — these are extension bytes.
2. First byte with bit 7 clear is the **tag byte**. Extract tag (low 4 bits) and value bits 0–2.
3. Reconstruct the full value:

```
value = tag_bits                          // 3 bits from tag byte
      | (ext_rightmost & 0x7F) << 3      // 7 bits
      | (ext_next      & 0x7F) << 10     // 7 bits
      | ...
```

Body bytes (to the left of the tag byte) are never scanned, so arbitrary body content — including bytes with bit 7 set (e.g., UTF-8 multibyte sequences) — is safe.

### Value ranges

| Bytes | Value range  | Total bits |
|-------|--------------|------------|
| 1     | 0–7          | 3          |
| 2     | 0–1,023      | 10         |
| 3     | 0–131,071    | 17         |
| 4     | 0–16,777,215 | 24         |
| 5+    | up to 2⁵³    | 31+        |

---

## Tags at a glance

| Tag   | Name    | Layout                                  | Varint meaning       |
|-------|---------|-----------------------------------------|----------------------|
| `0x0` | Integer | `[tag+varint]`                          | zigzag(value)        |
| `0x1` | Decimal | `[base_int][tag+varint]`                | zigzag(exponent)     |
| `0x2` | String  | `[UTF-8 body][tag+varint]`              | byte length          |
| `0x3` | Hexstr  | `[packed bytes][tag+varint]`            | hex character count  |
| `0x4` | Ref     | `[tag+varint]`                          | ref code (see below) |
| `0x5` | List    | `[children][tag+varint]`                | content byte size    |
| `0x6` | Map     | `[kv pairs][idx?][schema?][tag+varint]` | content byte size    |
| `0x7` | Pointer | `[tag+varint]`                          | backward delta       |
| `0x8` | Chain   | `[segments][tag+varint]`                | content byte size    |
| `0x9` | Index   | `[binary entries][tag+varint]`          | packed count+width   |
| `0xA` | B64str  | `[packed bytes][tag+varint]`            | character count      |

---

## Primitives

### Integer — tag `0x0`

```
[tag+varint(zigzag(value))]
```

Signed integers use zigzag encoding: 0 → 0, -1 → 1, 1 → 2, -2 → 3, …

| Value | Zigzag | Tag+varint bytes  |
|-------|--------|-------------------|
| 0     | 0      | `00` (1 byte)     |
| 1     | 2      | `20` (1 byte)     |
| -1    | 1      | `10` (1 byte)     |
| 42    | 84     | `40 8a` (2 bytes) |

### Decimal — tag `0x1`

```
[base_integer_node][tag+varint(zigzag(exponent))]
```

Represents `base × 10^exp`. The base is an integer node (tag `0x0`) immediately to the left.

Small non-negative exponents (0–4) are folded into the base and omit the decimal tag, same as RX.

Special float values use refs: `+Infinity` (ref 4), `-Infinity` (ref 5), `NaN` (ref 6).

### String — tag `0x2`

```
[UTF-8 bytes][tag+varint(byte_length)]
```

Raw UTF-8 body. The varint gives the **byte length** (not character count).

### Hexstring — tag `0x3`

```
[packed bytes][tag+varint(hex_char_count)]
```

For strings that are 100% lowercase hexadecimal (`[0-9a-f]`) and at least 4 characters long. Each byte packs two hex digits (high nibble first). Saves ~50% vs regular string encoding.

- **Even length**: `ceil(N/2)` packed bytes
- **Odd length**: leading byte has high nibble = 0 (padding)
- **Decoding**: expand packed bytes to hex, take last `hex_char_count` characters

| Hex string   | Chars | Packed bytes              | Total bytes |
|--------------|-------|---------------------------|-------------|
| `"deadbeef"` | 8     | `DE AD BE EF`             | 4 + 2 = 6   |
| `"abcde"`    | 5     | `0A BC DE`                | 3 + 2 = 5   |
| (as string)  | 8     | `64 65 61 64 62 65 65 66` | 8 + 2 = 10  |

### B64str — tag `0xA`

```
[packed bytes][tag+varint(char_count)]
```

For strings composed entirely of URL-safe base64 characters (`[0-9a-zA-Z-_]`) and at least 4 characters long. Each character is packed as 6 bits (MSB first), saving 25% vs regular string encoding.

- **Packed size**: `ceil(N × 6 / 8)` bytes
- **Trailing bits** in the last byte are zero-padded
- **Decoding**: extract 6-bit groups, map each to the alphabet

| String             | Chars | Regular bytes | Packed bytes | Savings |
|--------------------|-------|---------------|--------------|---------|
| `"hello-world_42"` | 15    | 15            | 12           | 20%     |
| `"abcdefgh"`       | 8     | 8             | 6            | 25%     |

Hex strings (`[0-9a-f]` only) use the hexstr type instead (50% savings beats 25%).

### Ref — tag `0x4`

```
[tag+varint(code)]
```

No body. Built-in codes:

| Code | Value        |
|------|--------------|
| 0    | `null`       |
| 1    | `true`       |
| 2    | `false`      |
| 3    | `undefined`  |
| 4    | `+Infinity`  |
| 5    | `-Infinity`  |
| 6    | `NaN`        |
| 7+   | External ref |

External refs use index `code - 7` into a sorted array of ref names shared between encoder and decoder.

---

## Containers

### List — tag `0x5`

```
[children in reverse][tag+varint(content_byte_size)]
```

Children are written in reverse order so that right-to-left parsing yields them in forward order. Large lists may include an **index** between the last child and the tag.

### Map — tag `0x6`

```
[kv pairs in reverse][optional index][optional schema][tag+varint(content_byte_size)]
```

Key-value pairs are written in reverse order. Key order is preserved. Large maps may include an index and/or schema.

---

## Sharing and random access

### Pointer — tag `0x7`

```
[tag+varint(delta)]
```

Backward delta to an earlier value: `target = tag_position - delta`. Enables value deduplication and schema sharing.

### Chain — tag `0x8`

```
[segments in reverse][tag+varint(content_byte_size)]
```

Concatenated string segments. Segments are string-like nodes (strings, pointers, or other chains). Compresses shared prefixes.

### Index — tag `0x9`

```
[fixed-width binary entries][tag+varint(packed)]
```

Lookup table for a container. The packed varint encodes:

```
packed = (count << 3) | (width - 1)
```

- **Low 3 bits**: `width - 1` (bytes per entry, supports widths 1–8)
- **Upper bits**: `count` (number of entries)

Each entry is a fixed-width **big-endian unsigned integer** giving the backward delta from the content boundary to the child's right edge.

| Width | Max delta     |
|-------|---------------|
| 1     | 255           |
| 2     | 65,535        |
| 3     | 16,777,215    |
| 4     | 4,294,967,295 |

- **Indexed lists**: entries in element order → O(1) access
- **Indexed maps**: entries point to keys in UTF-8 sorted order → O(log n) lookup

### Schema

Maps can reference a shared key layout via a pointer or ref appearing as the rightmost item inside the map body. Same as RX — see the [RX format spec](./rx-format.md#schema) for details.

---

## Comparison with RX text format

| Feature         | RX (text)         | RXB (binary)                |
|-----------------|-------------------|-----------------------------|
| Tags            | ASCII chars       | 4-bit integers              |
| Varints         | Base-64 digits    | Base-128 + tag (packed)     |
| Hex strings     | —                 | Dedicated type (50% saving) |
| B64 strings     | —                 | Dedicated type (25% saving) |
| Index entries   | Fixed-width b64   | Fixed-width binary          |
| Refs            | Inline names      | Integer codes               |
| Value 0         | 1 byte (tag only) | 1 byte (tag only)           |
| Values 1–7      | 2 bytes           | 1 byte                      |
| Values 8–63     | 2 bytes           | 2 bytes                     |
| Values 64–127   | 2 bytes           | 2 bytes                     |
| Values 128–1023 | 2–3 bytes         | 2 bytes                     |

---

## Benchmarks

Encoded size and encoding speed for JSON vs RX vs RXB across a range of datasets. Measured on Apple M3 with Bun.

### Encoded size

| Dataset                     |      JSON |       RX |      RXB | RXB vs JSON | RXB vs RX |
|-----------------------------|----------:|---------:|---------:|------------:|----------:|
| flat-1k (mixed keys/values) |   42.1 KB |  40.4 KB |  31.2 KB |    **-26%** |  **-23%** |
| flat-10k                    |  433.5 KB | 426.8 KB | 326.1 KB |    **-25%** |  **-24%** |
| records-1k (table-like)     |  151.5 KB |  58.1 KB |  50.8 KB |    **-66%** |      -13% |
| records-10k                 |  1,544 KB |   620 KB |   555 KB |    **-64%** |      -11% |
| deep-6x4 (nested objects)   |  101.3 KB |  60.4 KB |  50.8 KB |    **-50%** |  **-16%** |
| paths-5k (URL-like keys)    |  407.7 KB | 417.4 KB | 368.9 KB |        -10% |      -12% |
| large-sample (93 MB JSON)   | 93,917 KB | 8,894 KB | 7,007 KB |    **-93%** |  **-21%** |

RX's biggest wins come from schema sharing and dedup (records, large-sample). RXB adds further savings from binary varints, b64str packing (keys like `d5-b2`), and hexstr packing.

### Encoding speed

| Dataset      | JSON.stringify | RX encode | RXB encode |
|--------------|---------------:|----------:|-----------:|
| flat-1k      |        0.03 ms |   0.53 ms |    0.56 ms |
| flat-10k     |        0.18 ms |    5.7 ms |     6.3 ms |
| records-1k   |        0.14 ms |    1.3 ms |     1.3 ms |
| records-10k  |         1.4 ms |   15.2 ms |    16.3 ms |
| deep-6x4     |        0.08 ms |   0.63 ms |    0.71 ms |
| paths-5k     |        0.06 ms |    4.4 ms |     4.7 ms |
| large-sample |          29 ms |    370 ms |     385 ms |

RXB encoding speed is within ~10% of RX. Both are slower than `JSON.stringify` because they perform structural dedup, schema detection, and index building — features that enable smaller output and O(1)/O(log n) random access without parsing.

---

## Versioning

This document describes the initial RXB encoding. Tags `0xB`–`0xF` are reserved for future use.
