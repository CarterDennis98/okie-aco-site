/**
 * Just enough of the zip format for Valor's setup export: read every entry of a zip, and write
 * one back that keeps each entry it isn't given new contents for exactly as it came -- the same
 * compressed bytes, checksum, timestamps and attributes -- so nothing the export doesn't touch
 * is so much as recompressed.
 *
 * Valor (3.0.241, read 2026-11-24) writes its zip with yazl: UTF-8 names, Unix mode 0664,
 * "made by" 0x033f, the Unix mtime in each central record's extra field; its two small files
 * carry their checksum and sizes up front, the rest are streamed with a data descriptor after.
 * Reading goes by the central directory, so both kinds read alike. Writing always puts the
 * checksum and sizes in the local header -- the form Valor's own manifest.json takes -- and
 * writes no data descriptor.
 *
 * Deflate is the platform's own ("deflate-raw" Compression/DecompressionStream), the same in
 * the operator's browser and in Node. Zip64, encryption and split archives are none of them
 * anything Valor writes: each is refused rather than misread.
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export type ZipEntry = {
  /** As stored; Valor's are all ASCII paths like "AccountSessions/Walmart US.json". */
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** The compressed bytes as they sit in the zip. */
  data: Uint8Array<ArrayBuffer>;
  // Carried over as they are when the zip is written back.
  nameBytes: Uint8Array<ArrayBuffer>;
  versionMadeBy: number;
  versionNeeded: number;
  flags: number;
  /** MS-DOS time and date, as the zip holds them. */
  time: number;
  date: number;
  internalAttributes: number;
  externalAttributes: number;
  /** The central record's extra field: Valor's holds the Unix mtime. */
  extra: Uint8Array<ArrayBuffer>;
  comment: Uint8Array<ArrayBuffer>;
};

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED = 0x1;
const DATA_DESCRIPTOR = 0x8;
/** Where a zip64 archive keeps a size or offset that didn't fit. */
const ZIP64_32 = 0xffffffff;
const ZIP64_16 = 0xffff;

/** A zip starts with a file's local header -- or, holding nothing, with the end record. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const signature = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  return signature === LOCAL || signature === END;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The zip's CRC-32 (IEEE 802.3) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function through(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/** Every entry in `bytes`, in the central directory's order. Nothing is inflated yet. */
export function readZip(bytes: Uint8Array<ArrayBuffer>): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is the last 22 bytes, unless a comment of up to 64 KB follows it.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - ZIP64_16); i--) {
    if (view.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError("not a zip file");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== count
  )
    throw new ZipError("a zip split across several files");
  if (count === ZIP64_16 || directorySize === ZIP64_32 || directoryStart === ZIP64_32)
    throw new ZipError("a zip64 file");
  if (directoryStart + directorySize > end) throw new ZipError("its directory is cut short");

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = directoryStart;
  for (let n = 0; n < count; n++) {
    if (p + 46 > end || view.getUint32(p, true) !== CENTRAL)
      throw new ZipError("its directory is damaged");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localStart = view.getUint32(p + 42, true);
    const nameEnd = p + 46 + nameLength;
    const extraEnd = nameEnd + extraLength;
    const recordEnd = extraEnd + commentLength;
    if (recordEnd > end) throw new ZipError("its directory is damaged");
    const nameBytes = bytes.slice(p + 46, nameEnd);
    const name = decoder.decode(nameBytes);
    if (flags & ENCRYPTED) throw new ZipError(`${name} is encrypted`);
    if (compressedSize === ZIP64_32 || size === ZIP64_32 || localStart === ZIP64_32)
      throw new ZipError("a zip64 file");
    if (method !== STORED && method !== DEFLATED)
      throw new ZipError(`${name} is compressed a way this can't read (method ${method})`);

    if (localStart + 30 > bytes.length || view.getUint32(localStart, true) !== LOCAL)
      throw new ZipError(`${name} is damaged`);
    const dataStart =
      localStart +
      30 +
      view.getUint16(localStart + 26, true) +
      view.getUint16(localStart + 28, true);
    if (dataStart + compressedSize > bytes.length) throw new ZipError(`${name} is cut short`);

    entries.push({
      name,
      method,
      crc32: view.getUint32(p + 16, true),
      compressedSize,
      size,
      data: bytes.subarray(dataStart, dataStart + compressedSize),
      nameBytes,
      versionMadeBy: view.getUint16(p + 4, true),
      versionNeeded: view.getUint16(p + 6, true),
      flags,
      time: view.getUint16(p + 12, true),
      date: view.getUint16(p + 14, true),
      internalAttributes: view.getUint16(p + 36, true),
      externalAttributes: view.getUint32(p + 38, true),
      extra: bytes.slice(nameEnd, extraEnd),
      comment: bytes.slice(extraEnd, recordEnd),
    });
    p = recordEnd;
  }
  return entries;
}

/** An entry's contents, inflated and checked against its size and checksum. */
export async function unzipEntry(entry: ZipEntry): Promise<Uint8Array<ArrayBuffer>> {
  let contents = entry.data;
  if (entry.method === DEFLATED) {
    try {
      contents = await through(entry.data, new DecompressionStream("deflate-raw"));
    } catch {
      throw new ZipError(`${entry.name} is damaged`);
    }
  }
  if (contents.length !== entry.size || crc32(contents) !== entry.crc32)
    throw new ZipError(`${entry.name} is damaged`);
  return contents;
}

/** `entry` holding `contents` instead: deflated afresh, everything else about it kept. */
export async function withContents(
  entry: ZipEntry,
  contents: Uint8Array<ArrayBuffer>,
): Promise<ZipEntry> {
  const data = await through(contents, new CompressionStream("deflate-raw"));
  return {
    ...entry,
    method: DEFLATED,
    versionNeeded: Math.max(entry.versionNeeded, 20),
    flags: entry.flags & ~DATA_DESCRIPTOR,
    crc32: crc32(contents),
    compressedSize: data.length,
    size: contents.length,
    data,
  };
}

/** A zip of `entries`, in that order, each with its checksum and sizes in its local header. */
export function writeZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  let localSize = 0;
  let directorySize = 0;
  for (const e of entries) {
    localSize += 30 + e.nameBytes.length + e.data.length;
    directorySize += 46 + e.nameBytes.length + e.extra.length + e.comment.length;
  }
  if (entries.length >= ZIP64_16 || localSize + directorySize >= ZIP64_32)
    throw new ZipError("too big for a zip without zip64");

  const out = new Uint8Array(localSize + directorySize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let p = 0;
  for (const e of entries) {
    offsets.push(p);
    view.setUint32(p, LOCAL, true);
    view.setUint16(p + 4, e.versionNeeded, true);
    view.setUint16(p + 6, e.flags & ~DATA_DESCRIPTOR, true);
    view.setUint16(p + 8, e.method, true);
    view.setUint16(p + 10, e.time, true);
    view.setUint16(p + 12, e.date, true);
    view.setUint32(p + 14, e.crc32, true);
    view.setUint32(p + 18, e.compressedSize, true);
    view.setUint32(p + 22, e.size, true);
    view.setUint16(p + 26, e.nameBytes.length, true);
    view.setUint16(p + 28, 0, true);
    out.set(e.nameBytes, p + 30);
    out.set(e.data, p + 30 + e.nameBytes.length);
    p += 30 + e.nameBytes.length + e.data.length;
  }
  const directoryStart = p;
  entries.forEach((e, i) => {
    view.setUint32(p, CENTRAL, true);
    view.setUint16(p + 4, e.versionMadeBy, true);
    view.setUint16(p + 6, e.versionNeeded, true);
    view.setUint16(p + 8, e.flags & ~DATA_DESCRIPTOR, true);
    view.setUint16(p + 10, e.method, true);
    view.setUint16(p + 12, e.time, true);
    view.setUint16(p + 14, e.date, true);
    view.setUint32(p + 16, e.crc32, true);
    view.setUint32(p + 20, e.compressedSize, true);
    view.setUint32(p + 24, e.size, true);
    view.setUint16(p + 28, e.nameBytes.length, true);
    view.setUint16(p + 30, e.extra.length, true);
    view.setUint16(p + 32, e.comment.length, true);
    view.setUint16(p + 34, 0, true);
    view.setUint16(p + 36, e.internalAttributes, true);
    view.setUint32(p + 38, e.externalAttributes, true);
    view.setUint32(p + 42, offsets[i], true);
    out.set(e.nameBytes, p + 46);
    out.set(e.extra, p + 46 + e.nameBytes.length);
    out.set(e.comment, p + 46 + e.nameBytes.length + e.extra.length);
    p += 46 + e.nameBytes.length + e.extra.length + e.comment.length;
  });
  view.setUint32(p, END, true);
  view.setUint16(p + 4, 0, true);
  view.setUint16(p + 6, 0, true);
  view.setUint16(p + 8, entries.length, true);
  view.setUint16(p + 10, entries.length, true);
  view.setUint32(p + 12, p - directoryStart, true);
  view.setUint32(p + 16, directoryStart, true);
  view.setUint16(p + 20, 0, true);
  return out;
}
