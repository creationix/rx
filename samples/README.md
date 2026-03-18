# Sample Files

JSON documents with their `.rx` equivalents, demonstrating various data shapes:

| File | What it exercises |
|------|-------------------|
| **quest-log** | Deep nesting, repeated sub-objects (`rarity`, `reward`), unicode names, ZWJ emoji |
| **site-manifest** | Many string paths with shared prefixes, duplicated `auth`/`component` values |
| **emoji-census** | ZWJ family emoji, emoji object keys, mixed nested structures |
| **sensor-grid** | Packed integer arrays, negative decimals, empty arrays, ISO timestamps |

## Viewing

```sh
# Install `rx` CLI with `npm i -g @creationix/rx`

# Pretty-print as a tree
rx samples/quest-log.rx

# Convert between formats
rx samples/quest-log.rx -j    # rx → JSON
rx samples/quest-log.json -r  # JSON → rx

# Select into a value
rx samples/quest-log.rx -s hero stats
```

The `.rx` files also open in the Rex VS Code extension as an interactive data viewer.

## Regenerating

To regenerate all `.rx` files from their JSON sources:

```sh
for f in samples/*.json; do rx "$f" -w; done
```
