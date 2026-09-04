// The package's main entry (`pdf-parse`) runs a debug block that reads a sample
// file from disk when it thinks it is the main module. We import the inner
// function directly to avoid that; `@types/pdf-parse` only declares the main
// entry, so re-point the same signature at the lib path.
declare module "pdf-parse/lib/pdf-parse.js" {
  import pdf from "pdf-parse";
  export default pdf;
}
