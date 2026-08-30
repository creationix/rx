// rx-encode: convert JSON to RX format.
//
// Algorithm (from rx-format.md design discussion):
//
//   Pass 1: parse JSON into a tape (flat node array). For each node, record:
//           kind, source byte range (in input), parsed value, and a bottom-up
//           Merkle hash that uniquely identifies the structure.
//
//   Pass 2: walk the tape in DFS post-order, emitting RX bytes. Before emitting
//           a node, check the dedup table by hash. On hash hit, verify by
//           byte-comparing source ranges (cheap, conservative — pretty-printed
//           variants miss but that's accepted). On confirmed match, emit a
//           backward pointer instead of re-emitting bytes.
//
// The encoder is comptime-generic over a Source type so that the JSON tape is
// just one implementation. A future LiveValueSource backed by Zig structs (or
// any other in-memory representation) plugs into the same encoder by exposing
// the required methods (rootIdx, kind, intValue, stringBytes, childCount,
// childAt, nodeHash, verify).
//
// Not yet implemented: schema sharing, string chains, container indexes.
// These are pure-output optimizations; correctness holds without them.

const std = @import("std");
const Allocator = std.mem.Allocator;

// =============================================================================
// Common types
// =============================================================================

pub const NodeKind = enum(u8) {
    null_v,
    true_v,
    false_v,
    int_v,
    float_v,
    string_v,
    array_v,
    object_v,
};

const b64_chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

// =============================================================================
// JSON tokenizer
// =============================================================================

const Token = union(enum) {
    object_open,
    object_close,
    array_open,
    array_close,
    colon,
    comma,
    string: struct { start: u32, end: u32 }, // includes quotes
    number: struct { start: u32, end: u32 },
    true_lit,
    false_lit,
    null_lit,
    eof,
};

const Tokenizer = struct {
    input: []const u8,
    pos: u32 = 0,

    fn skipWs(self: *Tokenizer) void {
        while (self.pos < self.input.len) {
            const c = self.input[self.pos];
            if (c == ' ' or c == '\t' or c == '\n' or c == '\r') {
                self.pos += 1;
            } else break;
        }
    }

    fn peek(self: *Tokenizer) ?u8 {
        if (self.pos >= self.input.len) return null;
        return self.input[self.pos];
    }

    fn next(self: *Tokenizer) !Token {
        self.skipWs();
        if (self.pos >= self.input.len) return .eof;
        const c = self.input[self.pos];
        switch (c) {
            '{' => {
                self.pos += 1;
                return .object_open;
            },
            '}' => {
                self.pos += 1;
                return .object_close;
            },
            '[' => {
                self.pos += 1;
                return .array_open;
            },
            ']' => {
                self.pos += 1;
                return .array_close;
            },
            ':' => {
                self.pos += 1;
                return .colon;
            },
            ',' => {
                self.pos += 1;
                return .comma;
            },
            '"' => return try self.scanString(),
            't' => return try self.scanLit("true", .true_lit),
            'f' => return try self.scanLit("false", .false_lit),
            'n' => return try self.scanLit("null", .null_lit),
            '-', '0'...'9' => return self.scanNumber(),
            else => return error.UnexpectedChar,
        }
    }

    fn scanString(self: *Tokenizer) !Token {
        const start = self.pos;
        self.pos += 1; // opening quote
        while (self.pos < self.input.len) {
            const c = self.input[self.pos];
            if (c == '\\') {
                if (self.pos + 1 >= self.input.len) return error.UnterminatedString;
                self.pos += 2;
                continue;
            }
            if (c == '"') {
                self.pos += 1;
                return Token{ .string = .{ .start = start, .end = self.pos } };
            }
            self.pos += 1;
        }
        return error.UnterminatedString;
    }

    fn scanNumber(self: *Tokenizer) Token {
        const start = self.pos;
        if (self.input[self.pos] == '-') self.pos += 1;
        while (self.pos < self.input.len) {
            const c = self.input[self.pos];
            const valid = (c >= '0' and c <= '9') or c == '.' or
                c == 'e' or c == 'E' or c == '+' or c == '-';
            if (!valid) break;
            self.pos += 1;
        }
        return Token{ .number = .{ .start = start, .end = self.pos } };
    }

    fn scanLit(self: *Tokenizer, lit: []const u8, tok: Token) !Token {
        if (self.pos + lit.len > self.input.len) return error.UnexpectedEnd;
        if (!std.mem.eql(u8, self.input[self.pos .. self.pos + lit.len], lit)) {
            return error.BadLiteral;
        }
        self.pos += @intCast(lit.len);
        return tok;
    }
};

// =============================================================================
// JsonTape — concrete Source implementation
// =============================================================================

const Node = struct {
    kind: NodeKind,
    src_start: u32,
    src_end: u32,
    hash: u64 = 0,
    // For composites: range into children array
    child_start: u32 = 0,
    child_count: u32 = 0,
    // For primitives: parsed value
    int_val: i64 = 0,
    float_val: f64 = 0,
    // For strings: child_start/child_count are reused as offset/length into str_pool.
};

pub const JsonTape = struct {
    alloc: Allocator,
    input: []const u8,
    nodes: std.ArrayList(Node) = .{},
    children: std.ArrayList(u32) = .{},
    str_pool: std.ArrayList(u8) = .{},
    root_idx: u32 = 0,

    pub fn deinit(self: *JsonTape) void {
        self.nodes.deinit(self.alloc);
        self.children.deinit(self.alloc);
        self.str_pool.deinit(self.alloc);
    }

    pub fn parse(self: *JsonTape) !void {
        var tok = Tokenizer{ .input = self.input };
        self.root_idx = try self.parseValue(&tok);
    }

    fn parseValue(self: *JsonTape, tok: *Tokenizer) anyerror!u32 {
        tok.skipWs();
        const start = tok.pos;
        const t = try tok.next();
        const idx: u32 = @intCast(self.nodes.items.len);

        switch (t) {
            .null_lit => try self.nodes.append(self.alloc, .{
                .kind = .null_v,
                .src_start = start,
                .src_end = tok.pos,
            }),
            .true_lit => try self.nodes.append(self.alloc, .{
                .kind = .true_v,
                .src_start = start,
                .src_end = tok.pos,
            }),
            .false_lit => try self.nodes.append(self.alloc, .{
                .kind = .false_v,
                .src_start = start,
                .src_end = tok.pos,
            }),
            .number => |r| {
                const text = self.input[r.start..r.end];
                const looks_int = std.mem.indexOfAny(u8, text, ".eE") == null;
                if (looks_int) {
                    if (std.fmt.parseInt(i64, text, 10)) |n| {
                        try self.nodes.append(self.alloc, .{
                            .kind = .int_v,
                            .src_start = start,
                            .src_end = tok.pos,
                            .int_val = n,
                        });
                        return idx;
                    } else |_| {}
                }
                const f = try std.fmt.parseFloat(f64, text);
                try self.nodes.append(self.alloc, .{
                    .kind = .float_v,
                    .src_start = start,
                    .src_end = tok.pos,
                    .float_val = f,
                });
            },
            .string => |r| {
                const raw = self.input[r.start + 1 .. r.end - 1];
                const pool_start: u32 = @intCast(self.str_pool.items.len);
                try decodeJsonString(self.alloc, &self.str_pool, raw);
                const pool_len: u32 = @intCast(self.str_pool.items.len - pool_start);
                try self.nodes.append(self.alloc, .{
                    .kind = .string_v,
                    .src_start = start,
                    .src_end = tok.pos,
                    .child_start = pool_start,
                    .child_count = pool_len,
                });
            },
            .array_open => {
                try self.nodes.append(self.alloc, .{ .kind = .array_v, .src_start = start, .src_end = 0 });
                // Use a local list so nested containers don't pollute our child range.
                var local: std.ArrayList(u32) = .{};
                defer local.deinit(self.alloc);
                var first = true;
                while (true) {
                    tok.skipWs();
                    if (tok.peek() == @as(u8, ']')) {
                        _ = try tok.next();
                        break;
                    }
                    if (!first) {
                        const t2 = try tok.next();
                        if (t2 != .comma) return error.ExpectedComma;
                    }
                    first = false;
                    const ci = try self.parseValue(tok);
                    try local.append(self.alloc, ci);
                }
                const cstart: u32 = @intCast(self.children.items.len);
                try self.children.appendSlice(self.alloc, local.items);
                self.nodes.items[idx].child_start = cstart;
                self.nodes.items[idx].child_count = @intCast(local.items.len);
                self.nodes.items[idx].src_end = tok.pos;
            },
            .object_open => {
                try self.nodes.append(self.alloc, .{ .kind = .object_v, .src_start = start, .src_end = 0 });
                var local: std.ArrayList(u32) = .{};
                defer local.deinit(self.alloc);
                var first = true;
                while (true) {
                    tok.skipWs();
                    if (tok.peek() == @as(u8, '}')) {
                        _ = try tok.next();
                        break;
                    }
                    if (!first) {
                        const t2 = try tok.next();
                        if (t2 != .comma) return error.ExpectedComma;
                    }
                    first = false;
                    const ki = try self.parseValue(tok);
                    if (self.nodes.items[ki].kind != .string_v) return error.NonStringKey;
                    const t3 = try tok.next();
                    if (t3 != .colon) return error.ExpectedColon;
                    const vi = try self.parseValue(tok);
                    try local.append(self.alloc, ki);
                    try local.append(self.alloc, vi);
                }
                const cstart: u32 = @intCast(self.children.items.len);
                try self.children.appendSlice(self.alloc, local.items);
                self.nodes.items[idx].child_start = cstart;
                self.nodes.items[idx].child_count = @intCast(local.items.len);
                self.nodes.items[idx].src_end = tok.pos;
            },
            else => return error.UnexpectedToken,
        }
        return idx;
    }

    pub fn computeHashes(self: *JsonTape) void {
        _ = self.hashNode(self.root_idx);
    }

    fn hashNode(self: *JsonTape, idx: u32) u64 {
        const n = &self.nodes.items[idx];
        var h = std.hash.Wyhash.init(@intFromEnum(n.kind));
        switch (n.kind) {
            .null_v, .true_v, .false_v => {},
            .int_v => h.update(std.mem.asBytes(&n.int_val)),
            .float_v => h.update(std.mem.asBytes(&n.float_val)),
            .string_v => h.update(self.stringBytes(idx)),
            .array_v, .object_v => {
                var i: u32 = 0;
                while (i < n.child_count) : (i += 1) {
                    const ci = self.children.items[n.child_start + i];
                    const ch = self.hashNode(ci);
                    h.update(std.mem.asBytes(&ch));
                }
            },
        }
        n.hash = h.final();
        return n.hash;
    }

    // ---- Source interface -------------------------------------------------

    pub fn rootIdx(self: *const JsonTape) u32 {
        return self.root_idx;
    }

    pub fn kind(self: *const JsonTape, idx: u32) NodeKind {
        return self.nodes.items[idx].kind;
    }

    pub fn intValue(self: *const JsonTape, idx: u32) i64 {
        return self.nodes.items[idx].int_val;
    }

    pub fn floatValue(self: *const JsonTape, idx: u32) f64 {
        return self.nodes.items[idx].float_val;
    }

    pub fn stringBytes(self: *const JsonTape, idx: u32) []const u8 {
        const n = self.nodes.items[idx];
        return self.str_pool.items[n.child_start .. n.child_start + n.child_count];
    }

    pub fn childCount(self: *const JsonTape, idx: u32) u32 {
        return self.nodes.items[idx].child_count;
    }

    pub fn childAt(self: *const JsonTape, idx: u32, i: u32) u32 {
        const n = self.nodes.items[idx];
        return self.children.items[n.child_start + i];
    }

    pub fn nodeHash(self: *const JsonTape, idx: u32) u64 {
        return self.nodes.items[idx].hash;
    }

    /// Verify two nodes are structurally equal by comparing JSON source bytes.
    /// Conservative: bytes-equal → guaranteed value-equal. Bytes-different →
    /// might still be value-equal (pretty-print variance) but we treat as
    /// not-equal and skip the dedup. Lossless either way.
    pub fn verify(self: *const JsonTape, idx_a: u32, idx_b: u32) bool {
        const a = self.nodes.items[idx_a];
        const b = self.nodes.items[idx_b];
        const a_src = self.input[a.src_start..a.src_end];
        const b_src = self.input[b.src_start..b.src_end];
        return std.mem.eql(u8, a_src, b_src);
    }
};

fn decodeJsonString(alloc: Allocator, out: *std.ArrayList(u8), raw: []const u8) !void {
    var i: usize = 0;
    while (i < raw.len) {
        const c = raw[i];
        if (c != '\\') {
            try out.append(alloc, c);
            i += 1;
            continue;
        }
        if (i + 1 >= raw.len) return error.BadEscape;
        const e = raw[i + 1];
        switch (e) {
            '"' => try out.append(alloc, '"'),
            '\\' => try out.append(alloc, '\\'),
            '/' => try out.append(alloc, '/'),
            'b' => try out.append(alloc, 0x08),
            'f' => try out.append(alloc, 0x0c),
            'n' => try out.append(alloc, '\n'),
            'r' => try out.append(alloc, '\r'),
            't' => try out.append(alloc, '\t'),
            'u' => {
                if (i + 6 > raw.len) return error.BadEscape;
                const hex = raw[i + 2 .. i + 6];
                const cp = try std.fmt.parseInt(u21, hex, 16);
                var buf: [4]u8 = undefined;
                const n = try std.unicode.utf8Encode(cp, &buf);
                try out.appendSlice(alloc, buf[0..n]);
                i += 6;
                continue;
            },
            else => return error.BadEscape,
        }
        i += 2;
    }
}

// =============================================================================
// Encoder helpers
// =============================================================================

fn b64Width(value: u64) u32 {
    if (value == 0) return 0;
    var n: u32 = 0;
    var v = value;
    while (v > 0) : (n += 1) v /= 64;
    return n;
}

fn writeB64(out: *std.ArrayList(u8), alloc: Allocator, value: u64) !void {
    if (value == 0) return;
    var temp: [16]u8 = undefined;
    var i: usize = 0;
    var v = value;
    while (v > 0) : (i += 1) {
        temp[i] = b64_chars[v % 64];
        v /= 64;
    }
    while (i > 0) {
        i -= 1;
        try out.append(alloc, temp[i]);
    }
}

fn zigzagEncode(n: i64) u64 {
    const shifted = @as(u64, @bitCast(n)) << 1;
    const sign = @as(u64, @bitCast(n >> 63));
    return shifted ^ sign;
}

// =============================================================================
// Encoder — generic over Source type (comptime dispatch, zero overhead)
// =============================================================================

const DedupEntry = struct {
    src_idx: u32, // node index in source — used for verify()
    output_offset: u32,
    output_size: u32,
};

pub fn Encoder(comptime Source: type) type {
    return struct {
        alloc: Allocator,
        source: *const Source,
        output: std.ArrayList(u8) = .{},
        dedup: std.AutoHashMap(u64, DedupEntry),

        const Self = @This();

        pub fn init(alloc: Allocator, source: *const Source) Self {
            return .{
                .alloc = alloc,
                .source = source,
                .dedup = std.AutoHashMap(u64, DedupEntry).init(alloc),
            };
        }

        pub fn deinit(self: *Self) void {
            self.output.deinit(self.alloc);
            self.dedup.deinit();
        }

        pub fn encode(self: *Self) ![]const u8 {
            try self.emitNode(self.source.rootIdx());
            return self.output.items;
        }

        fn emitNode(self: *Self, idx: u32) anyerror!void {
            const k = self.source.kind(idx);
            const node_hash = self.source.nodeHash(idx);

            // Cheap leaves never benefit from a pointer (^ + at-least-1-byte = 2+ bytes).
            const skip_dedup = switch (k) {
                .null_v, .true_v, .false_v => true,
                else => false,
            };

            if (!skip_dedup) {
                if (self.dedup.get(node_hash)) |existing| {
                    if (self.source.verify(idx, existing.src_idx)) {
                        const here: u32 = @intCast(self.output.items.len);
                        const delta: u32 = here - existing.output_offset;
                        const ptr_size = b64Width(@intCast(delta)) + 1;
                        if (ptr_size < existing.output_size) {
                            try self.output.append(self.alloc, '^');
                            try writeB64(&self.output, self.alloc, @intCast(delta));
                            return;
                        }
                    }
                    // Hash hit but verify failed (collision) or pointer not profitable.
                    // Either way, fall through to fresh emit.
                }
            }

            const before: u32 = @intCast(self.output.items.len);
            try self.emitFresh(idx);
            const size: u32 = @intCast(self.output.items.len - before);

            if (!skip_dedup and !self.dedup.contains(node_hash) and size > 2) {
                try self.dedup.put(node_hash, .{
                    .src_idx = idx,
                    .output_offset = before,
                    .output_size = size,
                });
            }
        }

        fn emitFresh(self: *Self, idx: u32) anyerror!void {
            const k = self.source.kind(idx);
            switch (k) {
                .null_v => try self.output.appendSlice(self.alloc, "'n"),
                .true_v => try self.output.appendSlice(self.alloc, "'t"),
                .false_v => try self.output.appendSlice(self.alloc, "'f"),
                .int_v => {
                    const v = self.source.intValue(idx);
                    try self.output.append(self.alloc, '+');
                    try writeB64(&self.output, self.alloc, zigzagEncode(v));
                },
                .float_v => try self.emitFloat(self.source.floatValue(idx)),
                .string_v => {
                    const body = self.source.stringBytes(idx);
                    try self.output.appendSlice(self.alloc, body);
                    try self.output.append(self.alloc, ',');
                    try writeB64(&self.output, self.alloc, body.len);
                },
                .array_v => {
                    try self.output.append(self.alloc, '[');
                    const n = self.source.childCount(idx);
                    var i = n;
                    while (i > 0) {
                        i -= 1;
                        const ci = self.source.childAt(idx, i);
                        try self.emitNode(ci);
                    }
                    try self.output.append(self.alloc, ']');
                },
                .object_v => {
                    try self.output.append(self.alloc, '{');
                    const n = self.source.childCount(idx);
                    // Children are alternating (key, value, key, value, ...) in input order.
                    // Emit pairs in REVERSE order (so R-to-L parse yields natural).
                    // Within a pair, value first L-to-R then key.
                    const pairs = n / 2;
                    var pi = pairs;
                    while (pi > 0) {
                        pi -= 1;
                        const ki = self.source.childAt(idx, pi * 2);
                        const vi = self.source.childAt(idx, pi * 2 + 1);
                        try self.emitNode(vi);
                        try self.emitNode(ki);
                    }
                    try self.output.append(self.alloc, '}');
                },
            }
        }

        fn emitFloat(self: *Self, val: f64) !void {
            if (std.math.isNan(val)) {
                try self.output.appendSlice(self.alloc, "'nan");
                return;
            }
            if (val == std.math.inf(f64)) {
                try self.output.appendSlice(self.alloc, "'inf");
                return;
            }
            if (val == -std.math.inf(f64)) {
                try self.output.appendSlice(self.alloc, "'nif");
                return;
            }

            // Decompose val ≈ base × 10^exp via scientific notation parsing.
            // Format: <-?><digits>.<digits>e<-?><digits>
            var buf: [64]u8 = undefined;
            const text = try std.fmt.bufPrint(&buf, "{e}", .{val});

            var i: usize = 0;
            var sign_neg = false;
            if (text.len > 0 and text[0] == '-') {
                sign_neg = true;
                i = 1;
            }

            const int_start = i;
            while (i < text.len and text[i] >= '0' and text[i] <= '9') : (i += 1) {}
            const int_part = text[int_start..i];

            var frac_part: []const u8 = "";
            if (i < text.len and text[i] == '.') {
                i += 1;
                const frac_start = i;
                while (i < text.len and text[i] >= '0' and text[i] <= '9') : (i += 1) {}
                frac_part = text[frac_start..i];
            }

            var exp10: i64 = 0;
            if (i < text.len and (text[i] == 'e' or text[i] == 'E')) {
                i += 1;
                exp10 = try std.fmt.parseInt(i64, text[i..], 10);
            }

            // Combine integer and fractional digit sequences, adjusting exponent.
            var digits_buf: [64]u8 = undefined;
            const total = int_part.len + frac_part.len;
            if (total == 0 or total > digits_buf.len) {
                // Fallback: truncate to integer
                try self.output.append(self.alloc, '+');
                try writeB64(&self.output, self.alloc, zigzagEncode(@intFromFloat(val)));
                return;
            }
            std.mem.copyForwards(u8, digits_buf[0..int_part.len], int_part);
            std.mem.copyForwards(u8, digits_buf[int_part.len .. int_part.len + frac_part.len], frac_part);
            const all_digits = digits_buf[0..total];

            // Trim trailing zeros (folding back into exponent)
            var trim_end = all_digits.len;
            var trailing: i64 = 0;
            while (trim_end > 1 and all_digits[trim_end - 1] == '0') {
                trim_end -= 1;
                trailing += 1;
            }
            const final_digits = all_digits[0..trim_end];
            const final_exp = exp10 - @as(i64, @intCast(frac_part.len)) + trailing;

            var base = std.fmt.parseInt(i64, final_digits, 10) catch {
                try self.output.append(self.alloc, '+');
                try writeB64(&self.output, self.alloc, zigzagEncode(@intFromFloat(val)));
                return;
            };
            if (sign_neg) base = -base;

            try self.output.append(self.alloc, '+');
            try writeB64(&self.output, self.alloc, zigzagEncode(base));
            if (final_exp != 0) {
                try self.output.append(self.alloc, '*');
                try writeB64(&self.output, self.alloc, zigzagEncode(final_exp));
            }
        }
    };
}

// =============================================================================
// Main
// =============================================================================

pub fn main() !void {
    var gpa: std.heap.GeneralPurposeAllocator(.{}) = .{};
    defer _ = gpa.deinit();
    const alloc = gpa.allocator();

    const args = try std.process.argsAlloc(alloc);
    defer std.process.argsFree(alloc, args);

    const input: []u8 = blk: {
        if (args.len > 1) {
            const file = try std.fs.cwd().openFile(args[1], .{});
            defer file.close();
            break :blk try file.readToEndAlloc(alloc, 1 << 30);
        } else {
            const stdin = std.fs.File.stdin();
            break :blk try stdin.readToEndAlloc(alloc, 1 << 30);
        }
    };
    defer alloc.free(input);

    var tape = JsonTape{ .alloc = alloc, .input = input };
    defer tape.deinit();
    try tape.parse();
    tape.computeHashes();

    var encoder = Encoder(JsonTape).init(alloc, &tape);
    defer encoder.deinit();
    const out = try encoder.encode();

    const stdout = std.fs.File.stdout();
    try stdout.writeAll(out);
}
