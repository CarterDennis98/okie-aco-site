/**
 * The zip reader and writer the Valor export rides on, against a zip laid out as Valor's own
 * (tests/valor/zip-fixture.ts, zipped with node:zlib rather than this code).
 */
import { describe, expect, it } from "vitest";
import {
  ZipError,
  crc32,
  looksLikeZip,
  readZip,
  unzipEntry,
  withContents,
  writeZip,
} from "@/lib/valor/zip";
import { localFiles, valorZip, valorZipFiles } from "../../../tests/valor/zip-fixture";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytesOf = (s: string) => new TextEncoder().encode(s);

describe("the zip reader and writer", () => {
  it("computes the zip's CRC-32", () => {
    expect(crc32(bytesOf("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("tells a zip from a JSON file", () => {
    expect(looksLikeZip(valorZip(valorZipFiles()))).toBe(true);
    expect(looksLikeZip(bytesOf('{"version":"3.0"}'))).toBe(false);
    expect(looksLikeZip(new Uint8Array(0))).toBe(false);
  });

  it("reads a zip written the way Valor writes one, data descriptors and all", async () => {
    const files = valorZipFiles();
    const entries = readZip(valorZip(files));
    expect(entries.map((e) => e.name)).toEqual(files.map(([name]) => name));
    expect(entries.map((e) => e.flags)).toEqual(files.map((_, i) => (i < 2 ? 0x800 : 0x808)));
    for (const [i, entry] of entries.entries())
      expect(JSON.parse(text(await unzipEntry(entry)))).toEqual(files[i][1]);
  });

  it("writes each entry back as it came: the same bytes, checksum, time and attributes", () => {
    const entries = readZip(valorZip(valorZipFiles()));
    const again = readZip(writeZip(entries));
    expect(again).toEqual(entries.map((e) => ({ ...e, flags: e.flags & ~0x8 })));
  });

  it("writes a zip a streaming reader can take apart: every checksum and size up front", () => {
    const files = valorZipFiles();
    const read = localFiles(writeZip(readZip(valorZip(files))));
    expect([...read.keys()]).toEqual(files.map(([name]) => name));
    for (const [name, value] of files) expect(read.get(name)).toBe(JSON.stringify(value));
  });

  it("swaps one entry's contents and leaves every other alone", async () => {
    const entries = readZip(valorZip(valorZipFiles()));
    const i = entries.findIndex((e) => e.name === "tasks.json");
    const replaced = await withContents(entries[i], bytesOf('{"groups":{},"lists":{}}'));
    const out = readZip(writeZip(entries.map((e, j) => (j === i ? replaced : e))));
    expect(text(await unzipEntry(out[i]))).toBe('{"groups":{},"lists":{}}');
    expect(out[i]).toMatchObject({
      name: "tasks.json",
      method: 8,
      flags: 0x800,
      time: entries[i].time,
      date: entries[i].date,
      externalAttributes: entries[i].externalAttributes,
      extra: entries[i].extra,
    });
    out.forEach((e, j) => {
      if (j !== i) expect(e.data).toEqual(entries[j].data);
    });
  });

  it("refuses what it can't read rather than misreading it", async () => {
    expect(() => readZip(bytesOf("not a zip at all, just some text"))).toThrow(ZipError);
    const zip = valorZip(valorZipFiles());
    expect(() => readZip(zip.slice(0, zip.length - 30))).toThrow("not a zip file");

    const encrypted = zip.slice();
    const view = new DataView(encrypted.buffer);
    const directory = view.getUint32(encrypted.length - 22 + 16, true);
    view.setUint16(directory + 8, view.getUint16(directory + 8, true) | 0x1, true);
    expect(() => readZip(encrypted)).toThrow("manifest.json is encrypted");

    const damaged = zip.slice();
    damaged[30 + "manifest.json".length + 2] ^= 0xff;
    await expect(unzipEntry(readZip(damaged)[0])).rejects.toThrow("manifest.json is damaged");
  });
});
