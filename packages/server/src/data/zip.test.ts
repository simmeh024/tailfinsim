import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { readZipEntries, readZipEntry } from './zip';

/**
 * The ZIP reader.
 *
 * Built rather than depended on, so it is tested against archives assembled byte
 * by byte here — including the shapes it deliberately refuses. A ZIP reader that
 * quietly mis-parses would show up much later as a population figure nobody
 * could explain, which is the worst place to find it.
 */

function buildZip(
  files: { name: string; content: Buffer; method?: number; flags?: number }[],
): Buffer {
  const parts: Buffer[] = [];

  for (const file of files) {
    const method = file.method ?? 8;
    const payload = method === 0 ? file.content : deflateRawSync(file.content);
    const name = Buffer.from(file.name, 'utf8');

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(file.flags ?? 0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(0, 14); // crc, unchecked by the reader
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(file.content.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    parts.push(header, name, payload);
  }

  // The central directory signature is how the reader knows the entries ended.
  const end = Buffer.alloc(4);
  end.writeUInt32LE(0x02014b50, 0);
  parts.push(end);

  return Buffer.concat(parts);
}

describe('readZipEntries', () => {
  it('reads a deflated entry', () => {
    const archive = buildZip([{ name: 'cities.txt', content: Buffer.from('hello world') }]);
    expect(readZipEntries(archive)).toEqual([
      { name: 'cities.txt', data: Buffer.from('hello world') },
    ]);
  });

  it('reads a stored entry', () => {
    const archive = buildZip([{ name: 'a.txt', content: Buffer.from('plain'), method: 0 }]);
    expect(readZipEntries(archive)[0]?.data.toString()).toBe('plain');
  });

  it('reads several entries in order', () => {
    const archive = buildZip([
      { name: 'one.txt', content: Buffer.from('1') },
      { name: 'two.txt', content: Buffer.from('22') },
    ]);
    expect(readZipEntries(archive).map((e) => e.name)).toEqual(['one.txt', 'two.txt']);
  });

  it('survives content large enough to actually compress', () => {
    // A one-byte payload can deflate larger than its input; this checks the real
    // path rather than a degenerate one.
    const content = Buffer.from('geonames\t'.repeat(50_000));
    const archive = buildZip([{ name: 'big.txt', content }]);
    expect(readZipEntries(archive)[0]?.data).toEqual(content);
  });

  it('skips directory entries', () => {
    const archive = buildZip([
      { name: 'dir/', content: Buffer.alloc(0), method: 0 },
      { name: 'dir/file.txt', content: Buffer.from('x') },
    ]);
    expect(readZipEntries(archive).map((e) => e.name)).toEqual(['dir/file.txt']);
  });
});

describe('readZipEntries — what it refuses', () => {
  it('rejects something that is not a ZIP at all', () => {
    expect(() => readZipEntries(Buffer.from('<html>404 Not Found</html>'))).toThrow(
      /local file header/,
    );
  });

  it('rejects an entry with a data descriptor rather than guessing its length', () => {
    // Bit 3 means the header sizes are zero and the real ones trail the payload,
    // so walking to the next entry from the header would land in the middle of
    // the data.
    const archive = buildZip([{ name: 'a.txt', content: Buffer.from('x'), flags: 0x08 }]);
    expect(() => readZipEntries(archive)).toThrow(/data descriptor/);
  });

  it('rejects an encrypted entry', () => {
    const archive = buildZip([{ name: 'a.txt', content: Buffer.from('x'), flags: 0x01 }]);
    expect(() => readZipEntries(archive)).toThrow(/encrypted/);
  });

  it('rejects an unsupported compression method', () => {
    const archive = buildZip([{ name: 'a.txt', content: Buffer.from('x'), method: 14 }]);
    expect(() => readZipEntries(archive)).toThrow(/compression method 14/);
  });

  it('rejects a truncated archive', () => {
    const archive = buildZip([{ name: 'a.txt', content: Buffer.from('hello') }]);
    expect(() => readZipEntries(archive.subarray(0, archive.length - 8))).toThrow();
  });

  it('rejects an archive with nothing but a directory in it', () => {
    // The "no files" branch. A zero-entry stub is caught earlier by the
    // signature check, since it is too short to hold even one header.
    const archive = buildZip([{ name: 'dir/', content: Buffer.alloc(0), method: 0 }]);
    expect(() => readZipEntries(archive)).toThrow(/no files/);
  });

  it('rejects a stub too short to contain a header', () => {
    expect(() => readZipEntries(buildZip([]))).toThrow(/not an archive/);
  });
});

describe('readZipEntry', () => {
  it('picks the named entry', () => {
    const archive = buildZip([
      { name: 'readme.txt', content: Buffer.from('no') },
      { name: 'cities15000.txt', content: Buffer.from('yes') },
    ]);
    expect(readZipEntry(archive, 'cities15000.txt').toString()).toBe('yes');
  });

  it('says what was actually in the archive when the name is missing', () => {
    // If GeoNames ever renames the file inside the zip, this message is the
    // difference between a five-second fix and an afternoon.
    const archive = buildZip([{ name: 'cities5000.txt', content: Buffer.from('x') }]);
    expect(() => readZipEntry(archive, 'cities15000.txt')).toThrow(/it contains: cities5000\.txt/);
  });
});
