import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { readZipEntries, readZipEntry } from './zip';

/**
 * The ZIP reader.
 *
 * Built rather than depended on, so it is tested against archives assembled byte
 * by byte here — including the streamed shape that the real GeoNames file turns
 * out to use, which the first implementation refused outright.
 */

interface FileSpec {
  name: string;
  content: Buffer;
  method?: number;
  /** Write the sizes after the data instead of in the local header, as streaming zippers do. */
  dataDescriptor?: boolean;
  encrypted?: boolean;
}

/** Builds a real archive: local headers, then a central directory, then an EOCD. */
function buildZip(files: FileSpec[], options: { comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const method = file.method ?? 8;
    const payload = method === 0 ? file.content : deflateRawSync(file.content);
    const name = Buffer.from(file.name, 'utf8');
    const flags = (file.dataDescriptor ? 0x08 : 0) | (file.encrypted ? 0x01 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    // A streaming zipper writes zeros here and the truth in the descriptor.
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(file.dataDescriptor ? 0 : payload.length, 18);
    local.writeUInt32LE(file.dataDescriptor ? 0 : file.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const pieces = [local, name, payload];
    if (file.dataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(0, 4);
      descriptor.writeUInt32LE(payload.length, 8);
      descriptor.writeUInt32LE(file.content.length, 12);
      pieces.push(descriptor);
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(file.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    const localBytes = Buffer.concat(pieces);
    locals.push(localBytes);
    offset += localBytes.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? '', 'utf8');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...locals, centralBytes, eocd, comment]);
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

  it('reads an entry written by a streaming zipper', () => {
    // The case that matters: GeoNames' own archive is built this way, with the
    // local header sizes left at zero. Reading local headers cannot handle it,
    // which is why this reader uses the central directory.
    const archive = buildZip([
      { name: 'cities15000.txt', content: Buffer.from('streamed'), dataDescriptor: true },
    ]);
    expect(readZipEntry(archive, 'cities15000.txt').toString()).toBe('streamed');
  });

  it('reads several entries, streamed and not, in order', () => {
    const archive = buildZip([
      { name: 'one.txt', content: Buffer.from('1'), dataDescriptor: true },
      { name: 'two.txt', content: Buffer.from('22') },
    ]);
    expect(readZipEntries(archive).map((e) => e.data.toString())).toEqual(['1', '22']);
  });

  it('survives content large enough to actually compress', () => {
    const content = Buffer.from('geonames\t'.repeat(50_000));
    const archive = buildZip([{ name: 'big.txt', content, dataDescriptor: true }]);
    expect(readZipEntries(archive)[0]?.data).toEqual(content);
  });

  it('skips directory entries', () => {
    const archive = buildZip([
      { name: 'dir/', content: Buffer.alloc(0), method: 0 },
      { name: 'dir/file.txt', content: Buffer.from('x') },
    ]);
    expect(readZipEntries(archive).map((e) => e.name)).toEqual(['dir/file.txt']);
  });

  it('finds the directory past a trailing archive comment', () => {
    // The EOCD is not necessarily the last bytes in the file.
    const archive = buildZip([{ name: 'a.txt', content: Buffer.from('x') }], {
      comment: 'made by something',
    });
    expect(readZipEntries(archive)[0]?.data.toString()).toBe('x');
  });
});

describe('readZipEntries — what it refuses', () => {
  it('rejects something that is not a ZIP at all', () => {
    expect(() => readZipEntries(Buffer.from('<html>404 Not Found</html>'))).toThrow(
      /not an archive/,
    );
  });

  it('rejects a stub too short to hold even a directory record', () => {
    expect(() => readZipEntries(Buffer.from('nope'))).toThrow(/Too short/);
  });

  it('rejects an encrypted entry', () => {
    const archive = buildZip([{ name: 'a.txt', content: Buffer.from('x'), encrypted: true }]);
    expect(() => readZipEntries(archive)).toThrow(/encrypted/);
  });

  it('rejects an unsupported compression method', () => {
    const archive = buildZip([{ name: 'a.txt', content: Buffer.from('x'), method: 14 }]);
    expect(() => readZipEntries(archive)).toThrow(/compression method 14/);
  });

  it('rejects an archive with nothing but a directory in it', () => {
    const archive = buildZip([{ name: 'dir/', content: Buffer.alloc(0), method: 0 }]);
    expect(() => readZipEntries(archive)).toThrow(/no files/);
  });

  it('rejects a truncated archive rather than returning half a file', () => {
    const archive = buildZip([{ name: 'a.txt', content: Buffer.from('hello world') }]);
    // Cut bytes out from under the directory, leaving its offsets pointing past
    // the end of the file.
    const damaged = Buffer.concat([archive.subarray(0, 34), archive.subarray(44)]);
    expect(() => readZipEntries(damaged)).toThrow();
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
