import { inflateRawSync } from 'node:zlib';

/**
 * Reading files out of a ZIP archive.
 *
 * GeoNames publishes `cities15000` only as a ZIP, and Node has no built-in ZIP
 * reader — only gzip and raw deflate, which are different containers. Rather
 * than take a dependency to open a single archive, this reads the central
 * directory and hands each payload to `inflateRawSync`, which *is* built in.
 *
 * ## Why the central directory and not the local headers
 *
 * Walking local headers from the front is the shorter implementation, and it was
 * the first one written here. It does not work on the file we actually need:
 * GeoNames' archive is produced by a streaming zipper, so every entry sets the
 * "data descriptor" flag, leaves the sizes in its local header as zero, and
 * writes the real ones *after* the compressed data. There is then no way to know
 * where an entry ends without decompressing it first.
 *
 * The central directory at the end carries the true sizes and the offset of
 * every entry — precisely what a streamed archive omits from the front. It is
 * the format's own answer to this problem, and it is what every real ZIP reader
 * uses.
 *
 * Still deliberately minimal: no encryption, no ZIP64, no multi-disk. Anything
 * outside that throws with a specific message rather than returning plausible
 * rubbish, because a silently mis-parsed archive would surface much later as a
 * population figure nobody could explain.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const STORED = 0;
const DEFLATED = 8;

/** The archive comment is a 16-bit length, so the EOCD is at most this far from the end. */
const MAX_EOCD_SEARCH = 0xffff + 22;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - MAX_EOCD_SEARCH);
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  }
  throw new Error(
    'No ZIP end-of-central-directory record — the download is not an archive ' +
      '(an error page from the mirror is the usual cause)',
  );
}

export function readZipEntries(archive: Buffer): ZipEntry[] {
  if (archive.length < 22) {
    throw new Error('Too short to be a ZIP archive — the download is not an archive');
  }

  const eocd = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  if (entryCount === 0xffff || offset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }

  const entries: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error(`Central directory entry ${String(index)} is malformed`);
    }

    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);

    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);

    if ((flags & 0x01) !== 0) throw new Error(`ZIP entry ${name} is encrypted`);

    // Directories are zero-length entries whose names end in a slash.
    if (!name.endsWith('/')) {
      if (
        localOffset + 30 > archive.length ||
        archive.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE
      ) {
        throw new Error(`ZIP entry ${name} points at a bad local header`);
      }

      // The local header's own name and extra lengths, which may differ from the
      // central directory's — the extra field commonly does.
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;

      if (dataEnd > archive.length) {
        throw new Error(
          `ZIP entry ${name} claims ${String(compressedSize)} bytes but the archive is shorter`,
        );
      }

      const payload = archive.subarray(dataStart, dataEnd);
      let data: Buffer;
      if (method === STORED) {
        data = Buffer.from(payload);
      } else if (method === DEFLATED) {
        data = inflateRawSync(payload);
      } else {
        throw new Error(
          `ZIP entry ${name} uses compression method ${String(method)}, not stored or deflate`,
        );
      }

      if (data.length !== uncompressedSize) {
        throw new Error(
          `ZIP entry ${name} inflated to ${String(data.length)} bytes, the directory says ${String(uncompressedSize)}`,
        );
      }

      entries.push({ name, data });
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (entries.length === 0) throw new Error('ZIP archive contained no files');
  return entries;
}

/** Extracts one named entry, or throws naming what was actually in there. */
export function readZipEntry(archive: Buffer, name: string): Buffer {
  const entries = readZipEntries(archive);
  const found = entries.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(
      `ZIP archive has no entry ${name} — it contains: ${entries.map((e) => e.name).join(', ')}`,
    );
  }
  return found.data;
}
