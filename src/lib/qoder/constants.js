// Re-export shim: qoder constants moved to open-sse/shared/qoder (open-sse self-contained, docs 00 §1b).
// This file exists so that src/lib/qoder/* modules can import shared constants
// without reaching into open-sse/ directly. Do NOT add new constants here —
// define them in open-sse/shared/qoder/constants.js and they will be re-exported.
export * from "../../../open-sse/shared/qoder/constants.js";
