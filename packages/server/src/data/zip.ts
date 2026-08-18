import { inflateRawSync } from 'node:zlib';

/**
 * Reading one file out of a ZIP archive.
 *
 * GeoNames publishes `cities15000` only as a ZIP, and Node has no built-in ZIP
 * reader — only gzip and raw deflate, which are different containers. Rather
 * than take a dependency to open a single archive with a single entry, this
 * parses the local file header and hands the payload to `inflateRawSync`, which
 * *is* built in.
 *
 * Deliberately minimal. It handles stored and deflated entries and nothing else:
 * no encryption, no ZIP64, no multi-disk, no data descriptors. Anything outside
 * that throws with a specific message rather than returning plausible rubbish,
 * because a silently mis-parsed archive would surface much later as a population
 * figure nobody could explain.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;

const STORED = 0;
const DEFLATED = 8;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Extracts every entry, walking the local headers from the front.
 *
 * The central directory at the end would be the more conventional route; the
 * local headers are enough here and avoid a second parser. The loop stops at the
 * central directory signature, which is what follows the last entry.
 */
export function readZipEntries(archive: Buffer): ZipEntry[] {
  // Checked up front rather than left to the loop: an HTTP error page served
  // instead of the archive is shorter than a single header, so the loop would
  // never run and the failure would read as "empty archive" instead of "that is
  // not a ZIP" — which sends you looking in the wrong place entirely.
  if (archive.length < 30 || archive.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(
      'Not a ZIP local file header at offset 0 — the download is not an archive ' +
        '(an error page from the mirror is the usual cause)',
    );
  }

  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset + 30 <= archive.length) {
    const signature = archive.readUInt32LE(offset);
    if (signature === CENTRAL_HEADER_SIGNATURE) break;
    if (signature !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(
        `Not a ZIP local file header at offset ${String(offset)} — got 0x${signature.toString(16)}`,
      );
    }

    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);

    // Bit 3 means the sizes live in a trailing data descriptor rather than the
    // header, so the header's zeros cannot be trusted to find the next entry.
    if ((flags & 0x08) !== 0) {
      throw new Error('ZIP entry uses a data descriptor, which this reader does not support');
    }
    if ((flags & 0x01) !== 0) {
      throw new Error('ZIP entry is encrypted');
    }

    const nameStart = offset + 30;
    const name = archive.toString('utf8', nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) {
      throw new Error(
        `ZIP entry ${name} claims ${String(compressedSize)} bytes but the file is shorter`,
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

    // Directories are zero-length entries whose names end in a slash.
    if (!name.endsWith('/')) {
      if (data.length !== uncompressedSize) {
        throw new Error(
          `ZIP entry ${name} inflated to ${String(data.length)} bytes, header says ${String(uncompressedSize)}`,
        );
      }
      entries.push({ name, data });
    }

    offset = dataEnd;
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
