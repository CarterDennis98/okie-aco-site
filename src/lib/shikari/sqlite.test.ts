import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SQLJS_WASM_PATH } from "@/lib/shikari/load-sqljs";
import { NotABackupError, looksLikeSqlite, openBackup } from "@/lib/shikari/sqlite";
import { sqljs } from "../../../tests/shikari/fixture";

describe("the vendored SQLite build", () => {
  /**
   * The browser loads its WebAssembly from public/, not from node_modules, so upgrading
   * sql.js without copying the new file across would pair new JavaScript with an old binary
   * -- which fails at load, on the export page only, on drop night. This fails first.
   */
  it("is byte for byte the one the installed sql.js expects", () => {
    const root = process.cwd();
    const pkg = JSON.parse(
      readFileSync(path.join(root, "node_modules/sql.js/package.json"), "utf8"),
    );
    expect(SQLJS_WASM_PATH).toBe(`/vendor/sql-wasm-${pkg.version}.wasm`);
    const vendored = readFileSync(path.join(root, "public", SQLJS_WASM_PATH));
    const installed = readFileSync(
      path.join(root, "node_modules/sql.js/dist/sql-wasm-browser.wasm"),
    );
    expect(vendored.equals(installed)).toBe(true);
  });
});

describe("openBackup", () => {
  it("refuses a file that isn't a SQLite database at all", async () => {
    const SQL = await sqljs();
    const notSqlite = new TextEncoder().encode(
      "PK\u0003\u0004 a zip, or anything else".padEnd(200, "."),
    );
    expect(looksLikeSqlite(notSqlite)).toBe(false);
    expect(() => openBackup(SQL, notSqlite)).toThrow(NotABackupError);
  });
});
