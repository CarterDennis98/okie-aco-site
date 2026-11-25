/**
 * The synthetic backup (fixture.ts) as Valor 3.0.241 exports it: the layout of the operator's
 * own zip, read 2026-11-24, not their data. One compact JSON file per section, and each
 * signed-in login's session in AccountSessions/<site>.json, keyed by the login's id.
 *
 * Zipped the way Valor's yazl does it -- "made by" 0x033f, mode 0664, the mtime in a "UT"
 * extra field, the first two files with their checksum and sizes up front and the rest
 * streamed with a data descriptor after -- using node:zlib, so a test reading it proves the
 * export's reader on a zip the export didn't write. `localFiles` reads one back the same
 * independent way.
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import type { ValorBackup } from "@/lib/valor/format";
import { IDS, valorBackup } from "./fixture";

/** A file in the zip: JSON-stringified, or raw bytes as they are. */
export type ZipFile = [name: string, contents: unknown];

export const MANIFEST = { format: 1, version: "3.0.241", createdAt: "2026-11-25T03:51:48.671Z" };

const session = (domain: string) => ({
  cookies: [{ name: "session", value: `test-${domain}`, domain }],
  saved_at: "2026-11-20T18:00:00.000Z",
});

/** The fixture with Walmart's login signed in too, so a session file is no business of the export's. */
export function valorZipBackup(): ValorBackup {
  const b = valorBackup();
  b.accounts.lists[IDS.walmartLogins]["l-w-1"].session = true;
  return b;
}

export function valorZipFiles(b: ValorBackup = valorZipBackup()): ZipFile[] {
  const captcha = b.captchaHarvesters as { harvesters: unknown };
  return [
    ["manifest.json", MANIFEST],
    ["userSettings.json", b.settings],
    ["tasks.json", b.tasks],
    ["proxies.json", b.proxies],
    ["profiles.json", b.profiles],
    ["accounts.json", b.accounts],
    ["automation.json", b.automations],
    ["captcha.json", { harvesters: captcha.harvesters, providers: b.captchaProviders }],
    ["imapAccounts.json", b.imap],
    // Dave's Target login is the fixture's one signed in.
    ["AccountSessions/Target.json", { "l-dave": session(".target.com") }],
    ["AccountSessions/Walmart US.json", { "l-w-1": session(".walmart.com") }],
  ];
}

const DOS_TIME = 0xae78; // 21:51:48
const DOS_DATE = 0x5d78; // 2026-11-24
const MTIME = 0x6b065b54;

/** `files` zipped as Valor's yazl zips them. */
export function valorZip(files: ZipFile[]): Uint8Array<ArrayBuffer> {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  files.forEach(([name, value], i) => {
    const contents =
      value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value), "utf8");
    const data = deflateRawSync(contents);
    const crc = crc32(contents);
    const streamed = i >= 2;
    const flags = 0x800 | (streamed ? 0x8 : 0);
    const nameBytes = Buffer.from(name, "utf8");

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    if (!streamed) {
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(contents.length, 22);
    }
    header.writeUInt16LE(nameBytes.length, 26);
    const descriptor = Buffer.alloc(streamed ? 16 : 0);
    if (streamed) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(contents.length, 12);
    }
    local.push(header, nameBytes, data, descriptor);

    const extra = Buffer.alloc(9);
    extra.writeUInt16LE(0x5455, 0);
    extra.writeUInt16LE(5, 2);
    extra.writeUInt8(3, 4);
    extra.writeUInt32LE(MTIME, 5);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x033f, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(contents.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt16LE(extra.length, 30);
    record.writeUInt32LE(0x81b40000, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes, extra);
    offset += header.length + nameBytes.length + data.length + descriptor.length;
  });
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

/**
 * Every file in a zip the export WROTE, as text, read front to back by local header alone --
 * the way a streaming unzipper reads one, never looking at the directory -- and each checked
 * against its checksum with node:zlib. Throws on a local header without its sizes.
 */
export function localFiles(zip: Uint8Array): Map<string, string> {
  const bytes = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const files = new Map<string, string>();
  let p = 0;
  while (bytes.readUInt32LE(p) === 0x04034b50) {
    const flags = bytes.readUInt16LE(p + 6);
    if (flags & 0x8) throw new Error("a data descriptor: the sizes aren't up front");
    const method = bytes.readUInt16LE(p + 8);
    const crc = bytes.readUInt32LE(p + 14);
    const compressed = bytes.readUInt32LE(p + 18);
    const size = bytes.readUInt32LE(p + 22);
    const nameLength = bytes.readUInt16LE(p + 26);
    const extraLength = bytes.readUInt16LE(p + 28);
    const name = bytes.toString("utf8", p + 30, p + 30 + nameLength);
    const start = p + 30 + nameLength + extraLength;
    const data = bytes.subarray(start, start + compressed);
    const contents = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    if (contents.length !== size || crc32(contents) !== crc) throw new Error(`${name} is damaged`);
    files.set(name, contents.toString("utf8"));
    p = start + compressed;
  }
  if (bytes.readUInt32LE(p) !== 0x02014b50) throw new Error("no directory after the files");
  return files;
}
