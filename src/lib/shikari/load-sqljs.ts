import type { SqlJsStatic } from "sql.js";

/**
 * SQLite for the browser, loaded on demand.
 *
 * The WebAssembly is served from public/vendor under its version, rather than resolved out
 * of node_modules by the bundler: Turbopack documents no way to reference a package's
 * `.wasm` as an asset, and a file whose name carries its version can never be served stale
 * beside newer JavaScript. A test pins this path to the installed package, byte for byte.
 *
 * Imported dynamically, so the engine is fetched only when the operator opens a backup --
 * nobody else ever downloads it.
 */
export const SQLJS_WASM_PATH = "/vendor/sql-wasm-1.14.2.wasm";

let loading: Promise<SqlJsStatic> | null = null;

export function loadSqlJs(): Promise<SqlJsStatic> {
  loading ??= import("sql.js")
    .then(({ default: initSqlJs }) => initSqlJs({ locateFile: () => SQLJS_WASM_PATH }))
    .catch((error) => {
      // A failed load must not be cached: the next attempt should try again.
      loading = null;
      throw error;
    });
  return loading;
}
