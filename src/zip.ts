import { inflateRawSync } from "node:zlib";

/** Reads named entries of a ZIP archive (enough for .xlsx workbooks). Uses the central directory, so data descriptors are fine. */
export function zipEntries(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip archive");
  const count = archive.readUInt16LE(end + 10);
  let p = archive.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = archive.readUInt16LE(p + 10);
    const compressed = archive.readUInt32LE(p + 20);
    const nameLen = archive.readUInt16LE(p + 28);
    const extraLen = archive.readUInt16LE(p + 30);
    const commentLen = archive.readUInt16LE(p + 32);
    const local = archive.readUInt32LE(p + 42);
    const name = archive.toString("utf8", p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(dataStart, dataStart + compressed);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
    else throw new Error(`unsupported zip compression method ${method}`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
