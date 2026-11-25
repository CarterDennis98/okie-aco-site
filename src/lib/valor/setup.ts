import {
  ValorFormatError,
  checkValorBackup,
  parseValorBackup,
  serializeValorBackup,
  type ValorBackup,
} from "@/lib/valor/format";
import {
  ZipError,
  looksLikeZip,
  readZip,
  unzipEntry,
  withContents,
  writeZip,
  type ZipEntry,
} from "@/lib/valor/zip";

/**
 * A Valor setup file as the operator adds it, in either form Valor has written, and the same
 * form back out once the export has rebuilt it.
 *
 * THE ZIP, as Valor 3.0.241 exports it (read off the operator's own export, 2026-11-24): the
 * one-file backup's sections, one compact JSON file each (no indent, no trailing newline),
 *
 *   manifest.json        { format: 1, version: "3.0.241", createdAt }
 *   tasks.json  proxies.json  accounts.json  profiles.json     as format.ts describes them
 *   imapAccounts.json    the IMAP list, the backup's `imap`
 *   userSettings.json  captcha.json  automation.json           never read or written
 *   AccountSessions/<site>.json   each signed-in login's session, keyed by the login's id
 *
 * THE ONE FILE, as Valor 3.0 wrote it before: format.ts.
 *
 * Either way the export works on the same ValorBackup. A zip goes back out as a zip with the
 * same files in the same order: tasks, profiles, accounts and the IMAP list -- all the export
 * writes -- rewritten as Valor writes them, and only if the build changed them; every other
 * file exactly as it came, compressed bytes and all. A login the build takes out takes its
 * session with it, so no file holds a session for a login that isn't there.
 *
 * Pure apart from the platform's deflate, so it runs in the operator's browser and in the
 * tests alike.
 */

export type ValorSetup =
  { kind: "json"; backup: ValorBackup } | { kind: "zip"; backup: ValorBackup; entries: ZipEntry[] };

/** The zip layout the export was built against: manifest.json's `format`. */
export const VALOR_ZIP_FORMAT = 1;

const MANIFEST = "manifest.json";
const SESSIONS = "AccountSessions/";

/** The backup's sections, by the file each is in. */
const SECTION_FILES = {
  tasks: "tasks.json",
  proxies: "proxies.json",
  accounts: "accounts.json",
  profiles: "profiles.json",
  imap: "imapAccounts.json",
} as const;

/**
 * The sections an export writes back. Proxies are only read -- for "Target ISP" -- and the
 * build refuses to hand back a backup in which they moved.
 */
const WRITTEN = ["tasks", "profiles", "accounts", "imap"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

/** The setup in `bytes`: a Valor zip, or a one-file backup. */
export async function readValorSetup(bytes: Uint8Array<ArrayBuffer>): Promise<ValorSetup> {
  if (!looksLikeZip(bytes)) return { kind: "json", backup: parseValorBackup(utf8(bytes)) };

  let entries: ZipEntry[];
  try {
    entries = readZip(bytes);
  } catch (failure) {
    if (!(failure instanceof ZipError)) throw failure;
    throw new ValorFormatError(`That zip can't be read (${failure.message}).`);
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  if (byName.size !== entries.length)
    throw new ValorFormatError("That zip holds two files by one name, so it isn't Valor's.");

  const json = async (name: string): Promise<unknown> => {
    const entry = byName.get(name);
    if (!entry) {
      throw new ValorFormatError(
        `That zip has no ${name}, so it isn't a Valor setup the export knows. Nothing was read.`,
      );
    }
    let text: string;
    try {
      text = utf8(await unzipEntry(entry));
    } catch (failure) {
      if (!(failure instanceof ZipError)) throw failure;
      throw new ValorFormatError(`That zip can't be read (${failure.message}).`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ValorFormatError(`${name} in that zip isn't valid JSON. Nothing was read.`);
    }
  };

  const manifest = await json(MANIFEST);
  if (!isObject(manifest) || typeof manifest.version !== "string")
    throw new ValorFormatError("That zip's manifest.json doesn't say which Valor wrote it.");
  if (manifest.format !== VALOR_ZIP_FORMAT) {
    throw new ValorFormatError(
      `That zip is Valor's format ${String(manifest.format)}; the export knows format ${VALOR_ZIP_FORMAT}. ` +
        "Valor may have changed how it lays the zip out — nothing was read.",
    );
  }
  const names = Object.keys(SECTION_FILES) as (keyof typeof SECTION_FILES)[];
  const sections = await Promise.all(names.map((section) => json(SECTION_FILES[section])));
  const backup = checkValorBackup({
    version: manifest.version,
    ...Object.fromEntries(names.map((section, i) => [section, sections[i]])),
  });
  return { kind: "zip", backup, entries };
}

/** What the rebuilt setup downloads as: the form it came in. */
export function valorSetupFile(setup: ValorSetup): { extension: string; type: string } {
  return setup.kind === "zip"
    ? { extension: "zip", type: "application/zip" }
    : { extension: "json", type: "application/json" };
}

/** `built` -- the build's output from `setup.backup` -- written out in `setup`'s form. */
export async function writeValorSetup(
  setup: ValorSetup,
  built: ValorBackup,
): Promise<Uint8Array<ArrayBuffer>> {
  if (setup.kind === "json") return encode(serializeValorBackup(built));

  const logins = (b: ValorBackup) =>
    new Set(Object.values(b.accounts.lists).flatMap((list) => Object.keys(list)));
  const kept = logins(built);
  const gone = new Set([...logins(setup.backup)].filter((id) => !kept.has(id)));

  const entries = await Promise.all(
    setup.entries.map(async (entry): Promise<ZipEntry> => {
      const section = WRITTEN.find((s) => SECTION_FILES[s] === entry.name);
      if (section) {
        const text = JSON.stringify(built[section]);
        return text === JSON.stringify(setup.backup[section])
          ? entry
          : withContents(entry, encode(text));
      }
      if (gone.size > 0 && entry.name.startsWith(SESSIONS) && entry.name.endsWith(".json")) {
        let sessions: unknown = null;
        try {
          sessions = JSON.parse(utf8(await unzipEntry(entry)));
        } catch {
          // Not one this can read: it goes back as it came, which is all an orphan costs.
        }
        if (isObject(sessions) && Object.keys(sessions).some((id) => gone.has(id))) {
          const left = Object.fromEntries(Object.entries(sessions).filter(([id]) => !gone.has(id)));
          return withContents(entry, encode(JSON.stringify(left)));
        }
      }
      return entry;
    }),
  );
  return writeZip(entries);
}
