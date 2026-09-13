import type { TextureLoader } from 'three';
import type { GLTFLoaderPlugin, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface EmbeddedImage {
  bufferView?: number;
  mimeType?: string;
  uri?: string;
}

/** Load embedded paint under the site's existing img-src self/data policy. */
export function embeddedGltfImages(
  parser: GLTFParser,
  textureLoader: TextureLoader,
): GLTFLoaderPlugin {
  return {
    name: 'TAILFIN_embedded_images',
    async beforeRoot() {
      // GLTFLoader normally creates blob URLs, and ImageBitmapLoader fetches
      // them. Neither path fits the deployed CSP. HTML images with data URIs
      // use its existing img-src allowance without widening connect/script-src.
      parser.textureLoader = textureLoader;
      const json = parser.json as { images?: EmbeddedImage[] };
      await Promise.all(
        (json.images ?? []).map(async (source) => {
          if (source.bufferView === undefined) return;
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(source.mimeType ?? '')) {
            throw new Error('Unsupported embedded aircraft image format.');
          }
          const bytes = (await parser.getDependency(
            'bufferView',
            source.bufferView,
          )) as ArrayBuffer;
          source.uri = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result === 'string') resolve(reader.result);
              else reject(new Error('Aircraft texture could not be decoded.'));
            };
            reader.onerror = () => reject(new Error('Aircraft texture could not be read.'));
            reader.readAsDataURL(new Blob([bytes], { type: source.mimeType }));
          });
          delete source.bufferView;
        }),
      );
    },
  };
}
