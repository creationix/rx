// Public npm entry for @creationix/rx.
//
// Re-exports the RX text format (flat) and the RXB binary format (rxb-prefixed).
// Source files remain standalone and vendor-friendly — copy rx.ts + rx-read.ts
// or rxb.ts + rxb-read.ts directly if you want only one format without the
// npm dependency.

export * from "./rx.ts";

export {
	type Tag,
	type Cursor,
	makeCursor,
	read,
	readStr,
	resolveStr,
	prepareKey,
	strCompare,
	strEquals,
	strHasPrefix,
	seekChild,
	collectChildren,
	findKey,
	findByPrefix,
	rawBytes,
	open,
	handle,
	type ASTNode,
	inspect,
	type DecodeOptions,
	decode,
	parse,
} from "./rx-read.ts";

export {
	type EncodeOptions as RxbEncodeOptions,
	encode as rxbEncode,
} from "./rxb.ts";

export {
	type Tag as RxbTag,
	type Cursor as RxbCursor,
	type Refs as RxbRefs,
	type DecodeOptions as RxbDecodeOptions,
	makeCursor as rxbMakeCursor,
	read as rxbRead,
	readStr as rxbReadStr,
	resolveStr as rxbResolveStr,
	prepareKey as rxbPrepareKey,
	strCompare as rxbStrCompare,
	strEquals as rxbStrEquals,
	strHasPrefix as rxbStrHasPrefix,
	seekChild as rxbSeekChild,
	collectChildren as rxbCollectChildren,
	findKey as rxbFindKey,
	findByPrefix as rxbFindByPrefix,
	rawBytes as rxbRawBytes,
	open as rxbOpen,
	handle as rxbHandle,
	decode as rxbDecode,
} from "./rxb-read.ts";
