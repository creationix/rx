// Public npm entry for @creationix/rx.
//
// Re-exports the RX text format. Source files remain standalone and
// vendor-friendly — copy rx.ts + rx-read.ts directly if you want to embed
// without the npm dependency.

export * from "./rx.ts";
export * from "./rx-read.ts";
