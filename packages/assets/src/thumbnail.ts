import type { AircraftAssetManifest } from '@tailfin/shared';

import type { Document, Node } from '@gltf-transform/core';

interface Point2 {
  readonly x: number;
  readonly y: number;
}

interface ProjectedModel {
  readonly triangles: readonly (readonly [Point2, Point2, Point2])[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function transformPoint(
  matrix: readonly number[],
  point: readonly number[],
): readonly [number, number, number] {
  const [x = 0, y = 0, z = 0] = point;
  return [
    matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
    matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
    matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
  ];
}

function project(point: readonly [number, number, number]): Point2 {
  const [x, y, z] = point;
  return { x: x * 0.92 - z * 0.38, y: -y + x * 0.12 + z * 0.16 };
}

function nodesUnder(node: Node): Node[] {
  const nodes: Node[] = [];
  node.traverse((child) => nodes.push(child));
  return nodes;
}

function projectDocument(document: Document, lodNodeName: string): ProjectedModel {
  const lodNode = document
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === lodNodeName);
  if (!lodNode) throw new Error(`Cannot render thumbnail: missing node "${lodNodeName}"`);
  const triangles: (readonly [Point2, Point2, Point2])[] = [];
  const maxTriangles = 24_000;
  let visited = 0;
  for (const node of nodesUnder(lodNode)) {
    const matrix = node.getWorldMatrix();
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const positions = primitive.getAttribute('POSITION');
      if (!positions) continue;
      const indices = primitive.getIndices();
      const count = indices?.getCount() ?? positions.getCount();
      const primitiveTriangles = Math.floor(count / 3);
      const stride = Math.max(1, Math.ceil(primitiveTriangles / maxTriangles));
      for (let triangle = 0; triangle < primitiveTriangles; triangle += stride) {
        const offset = triangle * 3;
        const vertexIndices = [
          indices?.getScalar(offset) ?? offset,
          indices?.getScalar(offset + 1) ?? offset + 1,
          indices?.getScalar(offset + 2) ?? offset + 2,
        ] as const;
        const points = vertexIndices.map((index) =>
          project(transformPoint(matrix, positions.getElement(index, [0, 0, 0]))),
        ) as unknown as readonly [Point2, Point2, Point2];
        triangles.push(points);
        visited += 1;
        if (visited >= maxTriangles) break;
      }
      if (visited >= maxTriangles) break;
    }
    if (visited >= maxTriangles) break;
  }
  if (triangles.length === 0) throw new Error('Cannot render thumbnail: LOD0 has no triangles');
  const points = triangles.flat();
  return {
    triangles,
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function panel(
  model: ProjectedModel,
  x: number,
  title: string,
  stroke: string,
  detail: string,
): string {
  const width = 560;
  const height = 350;
  const padding = 30;
  const spanX = Math.max(0.001, model.maxX - model.minX);
  const spanY = Math.max(0.001, model.maxY - model.minY);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const offsetX = x + (width - spanX * scale) / 2 - model.minX * scale;
  const offsetY = 74 + (height - spanY * scale) / 2 - model.minY * scale;
  const paths = model.triangles
    .map((triangle) => {
      const coordinates = triangle
        .map(
          (point) =>
            `${(point.x * scale + offsetX).toFixed(2)},${(point.y * scale + offsetY).toFixed(2)}`,
        )
        .join(' ');
      return `<polygon points="${coordinates}"/>`;
    })
    .join('');
  return [
    `<g>`,
    `<rect x="${String(x)}" y="54" width="${String(width)}" height="${String(height)}" rx="8" fill="#0b1119" stroke="#26384c"/>`,
    `<text x="${String(x + 16)}" y="38" class="label">${title}</text>`,
    `<g fill="${stroke}" fill-opacity="0.12" stroke="${stroke}" stroke-opacity="0.42" stroke-width="0.55">${paths}</g>`,
    `<text x="${String(x + 16)}" y="430" class="detail">${detail}</text>`,
    `</g>`,
  ].join('');
}

export function comparisonThumbnail(
  source: Document,
  runtime: Document,
  manifest: AircraftAssetManifest,
  sourceDetail: string,
  runtimeDetail: string,
): string {
  const lod0 = manifest.technical.lods.find((lod) => lod.level === 0);
  if (!lod0) throw new Error('Manifest has no LOD0');
  const sourceModel = projectDocument(source, lod0.nodeName);
  const runtimeModel = projectDocument(runtime, lod0.nodeName);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1180 460" role="img" aria-labelledby="title description">`,
    `<title id="title">${manifest.technical.identity.assetId} source and runtime comparison</title>`,
    `<desc id="description">Deterministic projected wireframe comparison generated by the Tailfin aircraft asset pipeline.</desc>`,
    `<style>.label{font:600 18px system-ui,sans-serif;fill:#dbeafe}.detail{font:13px ui-monospace,monospace;fill:#8fa7c0}</style>`,
    `<rect width="1180" height="460" fill="#080d14"/>`,
    panel(sourceModel, 20, 'SOURCE', '#66b7ff', sourceDetail),
    panel(runtimeModel, 600, 'RUNTIME', '#5ee39b', runtimeDetail),
    `</svg>\n`,
  ].join('');
}
