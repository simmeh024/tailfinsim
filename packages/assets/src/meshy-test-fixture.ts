export const tetra = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
export const faces = [
  [0, 2, 1],
  [0, 1, 3],
  [1, 2, 3],
  [2, 0, 3],
];
interface Accessor {
  bufferView: number;
  byteOffset: number;
  count: number;
  componentType: number;
  type: string;
  min?: number[];
  max?: number[];
}
export function fixture(
  points = tetra,
  triangles = faces,
  options: {
    normals?: number[][];
    uv?: number[][];
    indexType?: 5121 | 5123 | 5125;
    stride?: boolean;
  } = {},
) {
  const chunks: Buffer[] = [];
  const views: { buffer: number; byteOffset: number; byteLength: number; byteStride?: number }[] =
    [];
  const accessors: Accessor[] = [];
  let offset = 0;
  const append = (
    values: number[],
    count: number,
    type: string,
    componentType: number,
    stride?: number,
  ) => {
    const size = componentType === 5121 ? 1 : componentType === 5123 ? 2 : 4;
    const data = Buffer.alloc(Math.ceil((values.length * size) / 4) * 4);
    values.forEach((v, i) => {
      if (componentType === 5126) data.writeFloatLE(v, i * size);
      else if (size === 1) data.writeUInt8(v, i);
      else if (size === 2) data.writeUInt16LE(v, i * size);
      else data.writeUInt32LE(v, i * size);
    });
    chunks.push(data);
    views.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: data.length,
      ...(stride ? { byteStride: stride } : {}),
    });
    offset += data.length;
    accessors.push({ bufferView: views.length - 1, byteOffset: 0, count, componentType, type });
    return accessors.length - 1;
  };
  const attrs: Record<string, number> = {
    POSITION: append(
      points.flatMap((p) => (options.stride ? [...p, 0] : p)),
      points.length,
      'VEC3',
      5126,
      options.stride ? 16 : undefined,
    ),
  };
  const indices = append(
    triangles.flat(),
    triangles.length * 3,
    'SCALAR',
    options.indexType ?? 5125,
  );
  if (options.normals)
    attrs.NORMAL = append(options.normals.flat(), options.normals.length, 'VEC3', 5126);
  if (options.uv) attrs.TEXCOORD_0 = append(options.uv.flat(), options.uv.length, 'VEC2', 5126);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: attrs, indices }] }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  return { json, binary: Buffer.concat(chunks) };
}
export function pack({ json, binary }: ReturnType<typeof fixture>): Buffer {
  const raw = Buffer.from(JSON.stringify(json));
  const padding = Buffer.alloc((4 - (raw.length % 4)) % 4, 0x20);
  const text = Buffer.concat([raw, padding]);
  const bytes = Buffer.alloc(28 + text.length + binary.length);
  [0x46546c67, 2, bytes.length, text.length, 0x4e4f534a].forEach((n, i) =>
    bytes.writeUInt32LE(n, i * 4),
  );
  text.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + text.length);
  bytes.writeUInt32LE(0x004e4942, 24 + text.length);
  binary.copy(bytes, 28 + text.length);
  return bytes;
}
