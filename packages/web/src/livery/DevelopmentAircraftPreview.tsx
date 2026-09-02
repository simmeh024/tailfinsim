import { useEffect, useMemo, useRef, useState } from 'react';

import type { LiveryLayer, LiveryZone } from '@tailfin/shared';

import { layerPrimaryColor } from './editor-model';

import type { ReactNode } from 'react';
import type {
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Side,
  WebGLRenderer,
} from 'three';
import type { OrbitControls as OrbitControlsType } from 'three/examples/jsm/controls/OrbitControls.js';

export const A320NEO_DEV_MODEL_STAGES = [
  { level: 2, url: '/api/dev/assets/aircraft/aircraft-lod2.glb' },
  { level: 1, url: '/api/dev/assets/aircraft/aircraft-lod1.glb' },
  { level: 0, url: '/api/dev/assets/aircraft/aircraft-lod0.glb' },
] as const;

export const A320NEO_QUARANTINE_RECOVERY_STAGES = [
  { level: 0, url: '/api/dev/assets/aircraft/quarantine-a320neo-recovery.glb' },
] as const;

type DevelopmentModelStage =
  (typeof A320NEO_DEV_MODEL_STAGES)[number] | (typeof A320NEO_QUARANTINE_RECOVERY_STAGES)[number];
type DevelopmentLod = DevelopmentModelStage['level'];

const MATERIAL_ZONE = Object.freeze({
  'mat-fuselage': 'fuselage',
  'mat-fin': 'tail_fin',
  'mat-horizontal-stabilisers': 'wings',
  'mat-wings': 'wings',
  'mat-winglets': 'winglets',
  'mat-nacelle-exteriors': 'engine_nacelles',
} satisfies Readonly<Record<string, LiveryZone>>);

const WINDOW_MATERIALS = new Set(['mat-cockpit-glass', 'mat-cabin-windows']);

/**
 * The salvaged candidate contains a small number of exterior triangles whose
 * winding is reversed. Rendering those materials single-sided makes the hull
 * appear transparent as the camera moves around it. Render all salvaged
 * surfaces double-sided. The source has no cabin behind its window polygons, so
 * glass must remain an opaque, dark reflective surface; transparent glass would
 * expose the back face of the fuselage and read as a missing window.
 */
export function configureA320neoDevelopmentExteriorMaterial(
  material: MeshStandardMaterial,
  doubleSide: Side,
): boolean {
  material.side = doubleSide;
  material.needsUpdate = true;
  if (WINDOW_MATERIALS.has(material.name)) {
    material.transparent = false;
    material.opacity = 1;
    material.alphaTest = 0;
    material.depthTest = true;
    material.depthWrite = true;
    // The source atlas contains baked black window cut-outs and ambient-occlusion
    // marks. Once geometry is split into semantic materials, keeping that atlas
    // multiplies those pixels into the replacement glazing colour.
    material.map = null;
    material.metalnessMap = null;
    material.roughnessMap = null;
    material.color.set(0x244d68);
    material.emissive.set(0x07141e);
    material.emissiveIntensity = 0.4;
    material.metalness = 0.12;
    material.roughness = 0.24;
    return false;
  }
  if (material.name === 'mat-engine-interiors') {
    material.transparent = false;
    material.opacity = 1;
    material.alphaTest = 0;
    material.depthTest = true;
    material.depthWrite = true;
    material.metalnessMap = null;
    material.roughnessMap = null;
    material.color.set(0x7f8992);
    material.metalness = 0.3;
    material.roughness = 0.48;
    return false;
  }
  if (!Object.hasOwn(MATERIAL_ZONE, material.name)) return false;

  material.transparent = false;
  material.opacity = 1;
  material.alphaTest = 0;
  material.depthTest = true;
  material.depthWrite = true;
  // Livery colours replace the source render's baked colour and occlusion.
  // Retaining its atlas leaves black seams and blotches visible through paint.
  material.map = null;
  material.metalnessMap = null;
  material.roughnessMap = null;
  material.metalness = 0.06;
  material.roughness = 0.72;
  return true;
}

type Rgb = readonly [number, number, number];

function parseLiveryColor(color: string): { rgb: Rgb; alpha: number } {
  const value = color.slice(1);
  return {
    rgb: [
      Number.parseInt(value.slice(0, 2), 16) / 255,
      Number.parseInt(value.slice(2, 4), 16) / 255,
      Number.parseInt(value.slice(4, 6), 16) / 255,
    ],
    alpha: value.length === 8 ? Number.parseInt(value.slice(6, 8), 16) / 255 : 1,
  };
}

function blendChannel(base: number, paint: number, mode: LiveryLayer['blendMode']): number {
  if (mode === 'multiply') return base * paint;
  if (mode === 'screen') return 1 - (1 - base) * (1 - paint);
  if (mode === 'overlay') return base < 0.5 ? 2 * base * paint : 1 - 2 * (1 - base) * (1 - paint);
  return paint;
}

function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * Approximate the current base-fill stack on semantic 3D materials.
 *
 * M6-03 does not yet bake a livery texture, so partial fuselage zones (nose,
 * belly, registration and cheatline) remain paint-map-only. Whole-surface zones
 * are composited accurately enough for the dev material review without claiming
 * that this temporary preview is the canonical renderer.
 */
export function a320neoDevelopmentMaterialColors(
  layers: readonly LiveryLayer[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [materialName, zone] of Object.entries(MATERIAL_ZONE)) {
    let current: Rgb = [1, 1, 1];
    let painted = false;
    for (const layer of layers) {
      if (!layer.visible || layer.zone !== zone || layer.opacity <= 0) continue;
      const paint = parseLiveryColor(layerPrimaryColor(layer));
      const alpha = layer.opacity * paint.alpha;
      const blended: Rgb = [
        blendChannel(current[0], paint.rgb[0], layer.blendMode),
        blendChannel(current[1], paint.rgb[1], layer.blendMode),
        blendChannel(current[2], paint.rgb[2], layer.blendMode),
      ];
      current = [
        current[0] + (blended[0] - current[0]) * alpha,
        current[1] + (blended[1] - current[1]) * alpha,
        current[2] + (blended[2] - current[2]) * alpha,
      ];
      painted = true;
    }
    if (painted) result[materialName] = toHex(current);
  }
  return result;
}

interface PreviewRuntime {
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControlsType;
  model: Object3D;
  originalMaterialColors: ReadonlyMap<MeshStandardMaterial, number>;
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly resetView: () => void;
  readonly resizeObserver: ResizeObserver | null;
}

function disposeModel(model: Object3D): void {
  model.traverse((object) => {
    const mesh = object as Object3D & {
      geometry?: { dispose: () => void };
      material?: MeshStandardMaterial | MeshStandardMaterial[];
    };
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const material of materials) {
      material.map?.dispose();
      material.normalMap?.dispose();
      material.metalnessMap?.dispose();
      material.roughnessMap?.dispose();
      material.dispose();
    }
  });
}

export function DevelopmentAircraftPreview({
  layers,
  fallback,
  source = 'salvaged-candidate',
}: {
  layers: readonly LiveryLayer[];
  fallback: ReactNode;
  /** A recovered export is shown untouched for quarantine visual review only. */
  source?: 'salvaged-candidate' | 'quarantine-recovery';
}): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<PreviewRuntime | null>(null);
  const isQuarantineRecovery = source === 'quarantine-recovery';
  const stages = isQuarantineRecovery
    ? A320NEO_QUARANTINE_RECOVERY_STAGES
    : A320NEO_DEV_MODEL_STAGES;
  const colors = useMemo(
    () => (isQuarantineRecovery ? {} : a320neoDevelopmentMaterialColors(layers)),
    [isQuarantineRecovery, layers],
  );
  const colorsRef = useRef(colors);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [lodLevel, setLodLevel] = useState<DevelopmentLod | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    colorsRef.current = colors;
    const runtime = runtimeRef.current;
    if (runtime === null) return;
    runtime.model.traverse((object) => {
      const material = (object as Object3D & { material?: MeshStandardMaterial }).material;
      if (!material?.isMeshStandardMaterial) return;
      const original = runtime.originalMaterialColors.get(material);
      if (original !== undefined && Object.hasOwn(MATERIAL_ZONE, material.name)) {
        material.color.setHex(original);
      }
      const color = colors[material.name];
      if (color !== undefined) material.color.set(color);
    });
  }, [colors]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;
    let cancelled = false;
    let pendingControls: OrbitControlsType | null = null;
    let pendingRenderer: WebGLRenderer | null = null;

    void (async () => {
      try {
        const [THREE, { OrbitControls }, { GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
          import('three'),
          import('three/examples/jsm/controls/OrbitControls.js'),
          import('three/examples/jsm/loaders/GLTFLoader.js'),
          import('three/examples/jsm/libs/meshopt_decoder.module.js'),
        ]);
        if (cancelled) return;

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        pendingRenderer = renderer;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.8;

        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xddeeff, 0x344252, 1.25));
        const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
        keyLight.position.set(-18, 30, 24);
        scene.add(keyLight);
        const rimLight = new THREE.DirectionalLight(0x86c8ff, 0.65);
        rimLight.position.set(24, 12, -28);
        scene.add(rimLight);
        const undersideFill = new THREE.DirectionalLight(0xc5ddf2, 0.9);
        undersideFill.position.set(-8, -24, 14);
        scene.add(undersideFill);

        const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 500);
        const controls = new OrbitControls(camera, canvas);
        pendingControls = controls;
        controls.enableDamping = true;
        controls.enablePan = false;
        controls.dampingFactor = 0.065;

        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        const loadStage = async (
          stage: DevelopmentModelStage,
        ): Promise<Awaited<ReturnType<typeof loader.loadAsync>>> =>
          new Promise((resolve, reject) => {
            loader.load(
              stage.url,
              resolve,
              (event) => {
                if (stage === stages[0] && event.total > 0 && !cancelled) {
                  setProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
                }
              },
              reject,
            );
          });
        const prepareModel = (model: Object3D): ReadonlyMap<MeshStandardMaterial, number> => {
          const originalMaterialColors = new Map<MeshStandardMaterial, number>();
          model.traverse((object) => {
            const material = (object as Object3D & { material?: MeshStandardMaterial }).material;
            if (!material?.isMeshStandardMaterial) return;
            if (!originalMaterialColors.has(material)) {
              originalMaterialColors.set(material, material.color.getHex());
            }
            material.envMapIntensity = 0.65;
            if (!isQuarantineRecovery) {
              const color = colorsRef.current[material.name];
              if (color !== undefined) material.color.set(color);
              configureA320neoDevelopmentExteriorMaterial(material, THREE.DoubleSide);
            }
          });
          return originalMaterialColors;
        };

        const gltf = await loadStage(stages[0]);
        if (cancelled) {
          disposeModel(gltf.scene);
          renderer.dispose();
          return;
        }

        const model = gltf.scene;
        const originalMaterialColors = prepareModel(model);
        scene.add(model);

        const bounds = new THREE.Box3().setFromObject(model);
        const sphere = bounds.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(sphere.radius, 1);
        const resetView = (): void => {
          const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) / 1.25;
          const direction = new THREE.Vector3(1.25, 0.62, 1.5).normalize();
          camera.position.copy(sphere.center).addScaledVector(direction, distance);
          camera.near = Math.max(0.05, distance / 100);
          camera.far = distance * 8;
          camera.updateProjectionMatrix();
          controls.target.copy(sphere.center);
          controls.minDistance = radius * 0.75;
          controls.maxDistance = radius * 5;
          controls.update();
        };
        resetView();

        const resize = (): void => {
          const width = Math.max(1, container.clientWidth);
          const height = Math.max(1, container.clientHeight);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };
        const resizeObserver =
          typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
        resizeObserver?.observe(container);
        resize();

        renderer.setAnimationLoop(() => {
          controls.update();
          renderer.render(scene, camera);
        });
        runtimeRef.current = {
          camera,
          controls,
          model,
          originalMaterialColors,
          renderer,
          scene,
          resetView,
          resizeObserver,
        };
        pendingControls = null;
        pendingRenderer = null;
        setState('ready');
        setLodLevel(stages[0].level);

        for (const stage of stages.slice(1)) {
          if (cancelled) break;
          try {
            const nextGltf = await loadStage(stage);
            if (cancelled) {
              disposeModel(nextGltf.scene);
              break;
            }
            const runtime = runtimeRef.current;
            if (runtime === null) {
              disposeModel(nextGltf.scene);
              break;
            }
            const nextModel = nextGltf.scene;
            const nextOriginalMaterialColors = prepareModel(nextModel);
            runtime.scene.remove(runtime.model);
            disposeModel(runtime.model);
            runtime.model = nextModel;
            runtime.originalMaterialColors = nextOriginalMaterialColors;
            runtime.scene.add(nextModel);
            setLodLevel(stage.level);
          } catch {
            // Keep the last successfully rendered stage. A failed upgrade must
            // never turn a visible aircraft back into an empty canvas.
          }
        }
      } catch {
        pendingControls?.dispose();
        pendingRenderer?.dispose();
        pendingControls = null;
        pendingRenderer = null;
        if (!cancelled) setState('failed');
      }
    })();

    return () => {
      cancelled = true;
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      if (runtime === null) {
        pendingControls?.dispose();
        pendingRenderer?.dispose();
        return;
      }
      runtime.renderer.setAnimationLoop(null);
      runtime.resizeObserver?.disconnect();
      runtime.controls.dispose();
      runtime.scene.remove(runtime.model);
      disposeModel(runtime.model);
      runtime.renderer.dispose();
    };
  }, [isQuarantineRecovery, stages]);

  if (state === 'failed') {
    return (
      <div className="livery-true-preview-fallback">
        {fallback}
        <p role="alert">True 3D preview unavailable — showing the fleet render.</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="livery-true-preview"
      role="img"
      aria-label={
        isQuarantineRecovery
          ? 'A320neo quarantined source PBR review model'
          : 'A320neo interactive true 3D livery preview'
      }
      data-state={state}
      data-lod={lodLevel ?? 'fallback'}
    >
      {state === 'loading' && (
        <div className="livery-true-preview__fallback" aria-hidden="true">
          {fallback}
        </div>
      )}
      <canvas ref={canvasRef} aria-hidden="true" data-visible={state === 'ready'} />
      {state === 'loading' && (
        <p className="livery-true-preview__loading" role="status">
          Loading {isQuarantineRecovery ? 'quarantine source PBR' : 'true 3D A320neo'}
          {progress === null ? '…' : ` · ${String(progress)}%`}
        </p>
      )}
      <div className="livery-true-preview__badges" aria-hidden="true">
        <span>{isQuarantineRecovery ? 'Source PBR review' : 'True 3D'}</span>
        <span>
          {isQuarantineRecovery
            ? 'Quarantine · not fleet eligible'
            : 'Dev review · licence pending'}
        </span>
      </div>
      <button
        type="button"
        className="livery-true-preview__reset"
        disabled={state !== 'ready'}
        onClick={() => runtimeRef.current?.resetView()}
      >
        Reset view
      </button>
      <p className="livery-true-preview__hint">
        {isQuarantineRecovery
          ? 'Untouched recovered PBR · quarantine only · drag to orbit · scroll to zoom'
          : 'Drag to orbit · scroll to zoom'}
      </p>
    </div>
  );
}
