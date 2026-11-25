/**
 * A Valor setup in, the same kind of file out: the zip Valor exports from 3.0.241 on, and the
 * one-file backup before it. The properties with something behind them:
 *   - a zip reads into the very backup the one-file export held, so the build is unchanged;
 *   - a build that changes nothing hands back the same zip, file for file;
 *   - only the files the build changed are rewritten, compact as Valor writes them, and the
 *     rest go back byte for byte;
 *   - a login the build takes out takes its session with it, and no other session moves;
 *   - a zip laid out some other way is refused, not half-read.
 */
import { describe, expect, it } from "vitest";
import { buildValorInstance } from "@/lib/valor/build";
import { ValorFormatError, serializeValorBackup, type ValorBackup } from "@/lib/valor/format";
import { readValorSetup, valorSetupFile, writeValorSetup } from "@/lib/valor/setup";
import { summarizeValorBackup } from "@/lib/valor/summary";
import type { DesiredValorInstance } from "@/lib/valor/types";
import { readZip } from "@/lib/valor/zip";
import { desiredInstance, picker, sequence, valorBackup } from "../../../tests/valor/fixture";
import {
  MANIFEST,
  localFiles,
  valorZip,
  valorZipBackup,
  valorZipFiles,
  type ZipFile,
} from "../../../tests/valor/zip-fixture";

const ONE = "91000001";

/** The sections a zip holds, as the export reads them. */
const sections = (b: ValorBackup, version: string) => ({
  version,
  tasks: b.tasks,
  proxies: b.proxies,
  accounts: b.accounts,
  profiles: b.profiles,
  imap: b.imap,
});

const replace = (files: ZipFile[], name: string, contents: unknown): ZipFile[] =>
  files.map(([n, v]) => [n, n === name ? contents : v]);

/** The zip's files in, the build, and the rebuilt zip out. */
async function roundTrip(desiredFor: (b: ValorBackup) => DesiredValorInstance) {
  const b = valorZipBackup();
  const files = valorZipFiles(b);
  const zip = valorZip(files);
  const setup = await readValorSetup(zip);
  const built = buildValorInstance(setup.backup, desiredFor(b), { uuid: sequence() });
  const out = await writeValorSetup(setup, built.backup);
  return { files, zip, built, out };
}

/** Whether each named file went back as it came: the same compressed bytes and checksum. */
function sameEntries(before: Uint8Array<ArrayBuffer>, after: Uint8Array<ArrayBuffer>) {
  const was = new Map(readZip(before).map((e) => [e.name, e]));
  return Object.fromEntries(
    readZip(after).map((e) => {
      const old = was.get(e.name)!;
      return [e.name, old.crc32 === e.crc32 && Buffer.from(old.data).equals(e.data)];
    }),
  );
}

describe("readValorSetup: Valor's zip", () => {
  it("reads into the same backup the one-file export held", async () => {
    const b = valorZipBackup();
    const setup = await readValorSetup(valorZip(valorZipFiles(b)));
    expect(setup.kind).toBe("zip");
    expect(setup.backup).toEqual(sections(b, "3.0.241"));
    expect(valorSetupFile(setup)).toEqual({ extension: "zip", type: "application/zip" });
  });

  it("counts Valor 3.0.241 as the Valor the export was built against", async () => {
    const setup = await readValorSetup(valorZip(valorZipFiles()));
    expect(summarizeValorBackup(setup.backup, 2)).toMatchObject({
      version: "3.0.241",
      otherVersion: false,
      problems: [],
    });
    const { report } = buildValorInstance(setup.backup, desiredInstance(valorZipBackup()), {
      uuid: sequence(),
    });
    expect(report.warnings).toEqual([]);
    expect(summarizeValorBackup({ ...setup.backup, version: "3.1.0" }, 1).otherVersion).toBe(true);
  });

  it("refuses a zip that isn't a Valor setup it knows, rather than half-reading it", async () => {
    const files = valorZipFiles();
    const without = (name: string) => files.filter(([n]) => n !== name);
    await expect(readValorSetup(valorZip(without("manifest.json")))).rejects.toThrow(
      "That zip has no manifest.json",
    );
    await expect(readValorSetup(valorZip(without("tasks.json")))).rejects.toThrow(
      "That zip has no tasks.json",
    );
    await expect(
      readValorSetup(valorZip(replace(files, "manifest.json", { ...MANIFEST, format: 2 }))),
    ).rejects.toThrow("That zip is Valor's format 2; the export knows format 1");
    await expect(
      readValorSetup(valorZip(replace(files, "manifest.json", { format: 1 }))),
    ).rejects.toThrow("doesn't say which Valor wrote it");
    await expect(
      readValorSetup(valorZip(replace(files, "tasks.json", new TextEncoder().encode("{oops")))),
    ).rejects.toThrow("tasks.json in that zip isn't valid JSON");
    await expect(
      readValorSetup(valorZip(replace(files, "profiles.json", { groups: {} }))),
    ).rejects.toThrow("no profiles groups and lists");
    await expect(readValorSetup(valorZip([...files, ["tasks.json", {}]]))).rejects.toThrow(
      "two files by one name",
    );
    await expect(
      readValorSetup(new TextEncoder().encode("PK\u0003\u0004 and then nothing")),
    ).rejects.toThrow(ValorFormatError);
    await expect(readValorSetup(new TextEncoder().encode("not json"))).rejects.toThrow(
      "neither a zip nor valid JSON",
    );
  });
});

describe("writeValorSetup: back out as a zip", () => {
  it("hands an unchanged build back as the same zip, file for file", async () => {
    const { files, zip, out } = await roundTrip((b) => desiredInstance(b));
    expect(sameEntries(zip, out)).toEqual(Object.fromEntries(files.map(([n]) => [n, true])));
  });

  it("rewrites only the files the build changed, compact as Valor writes them", async () => {
    const { files, zip, built, out } = await roundTrip((b) => {
      const desired = desiredInstance(b);
      desired.main.pop();
      return desired;
    });
    expect(built.report.pkc.profiles.removed).toHaveLength(1);
    const read = localFiles(out);
    expect([...read.keys()]).toEqual(files.map(([n]) => n));
    expect(read.get("profiles.json")).toBe(JSON.stringify(built.backup.profiles));
    expect(read.get("tasks.json")).toBe(JSON.stringify(built.backup.tasks));
    expect(sameEntries(zip, out)).toEqual({
      ...Object.fromEntries(files.map(([n]) => [n, true])),
      "profiles.json": false,
      "tasks.json": false,
    });
    const again = await readValorSetup(out);
    expect(again.backup).toEqual(sections(built.backup, "3.0.241"));
  });

  it("takes a removed login's session out with it, and moves no other", async () => {
    // Erin picks; Dave, the one signed in, no longer does -- so his login goes.
    const { zip, built, out } = await roundTrip((b) =>
      desiredInstance(b, [picker(b, "p-t-erin-1", [{ sku: ONE, qty: 2 }])]),
    );
    expect(built.report.misc?.accounts.removed).toBe(1);
    const read = localFiles(out);
    expect(JSON.parse(read.get("AccountSessions/Target.json")!)).toEqual({});
    expect(read.get("accounts.json")).toBe(JSON.stringify(built.backup.accounts));
    expect(sameEntries(zip, out)).toMatchObject({
      "AccountSessions/Target.json": false,
      "AccountSessions/Walmart US.json": true,
      "proxies.json": true,
      "userSettings.json": true,
    });
  });

  it("keeps a kept login's session exactly as it was", async () => {
    const { zip, built, out } = await roundTrip((b) =>
      desiredInstance(b, [
        picker(b, "p-t-dave-1", [{ sku: ONE, qty: 2 }]),
        picker(b, "p-t-erin-1", [{ sku: ONE, qty: 2 }]),
      ]),
    );
    expect(built.report.misc?.accounts.removed).toBe(0);
    expect(sameEntries(zip, out)).toMatchObject({
      "AccountSessions/Target.json": true,
      "AccountSessions/Walmart US.json": true,
    });
  });
});

describe("the one-file backup", () => {
  it("still reads, and goes back out as one file, written as before", async () => {
    const b = valorBackup();
    const text = serializeValorBackup(b);
    const setup = await readValorSetup(new TextEncoder().encode(text));
    expect(setup).toEqual({ kind: "json", backup: b });
    expect(valorSetupFile(setup)).toEqual({ extension: "json", type: "application/json" });
    expect(new TextDecoder().decode(await writeValorSetup(setup, setup.backup))).toBe(text);
  });
});
