/* global document, devicePixelRatio, ResizeObserver */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { semanticWorkbenchCloseUpIncludes } from '../src/semantic-workbench-camera';
import {
  parseSemanticWorkbenchDraft,
  semanticWorkbenchDraftKey,
  semanticWorkbenchDraftMaxBytes,
} from '../src/semantic-workbench-draft';
import {
  compressSemanticAssignments,
  expandSemanticDispositions,
} from '../src/semantic-workbench-review';
import { semanticWorkbenchFloodCompatible } from '../src/semantic-workbench-selection';

const elements = Object.fromEntries(
  [
    'status',
    'target',
    'finding',
    'rationale',
    'reviewer',
    'angle',
    'angle-value',
    'stats',
    'patch-stats',
    'decision-progress',
    'decision-resolution',
    'decision-target',
    'decision-rationale',
    'decision-views',
    'patches',
    'components',
    'isolate',
    'wireframe',
    'residual',
    'previous-patch',
    'next-patch',
    'assign-patch',
    'clear-patch',
    'unassigned',
    'whole',
    'clear-component',
    'reset-draft',
    'export',
    'export-residual',
    'import',
  ].map((id) => [id, document.getElementById(id)]),
);
const canvas = document.querySelector('canvas');
const views = document.querySelector('.views');
const palette = [
  0x4ea6e8, 0x243b63, 0x3e84c4, 0x3e84c4, 0xffb45d, 0xffb45d, 0x76b56a, 0x76b56a, 0x56d39b,
  0x56d39b, 0x9a6fd0, 0x7db7c9, 0x7db7c9, 0xe98a55, 0xe98a55, 0x3a4652, 0x3a4652, 0xffed76,
  0x8e99a4, 0xe74747,
];
const evidenceViews = [
  ['quarter', 'Quarter'],
  ['left', 'Left'],
  ['right', 'Right'],
  ['top', 'Top'],
  ['underside', 'Underside'],
  ['nose', 'Nose'],
  ['tail', 'Tail'],
  ['winglet_left', 'Winglet left'],
  ['winglet_right', 'Winglet right'],
  ['tail_close_up', 'Tail close-up'],
];

const setStatus = (message, error = false) => {
  elements.status.textContent = message;
  elements.status.style.borderColor = error ? '#ef6464' : '#f8b34c';
};

try {
  const inventoryResponse = await fetch('/inventory.json', { cache: 'no-store' });
  if (!inventoryResponse.ok) throw new Error('Verified evidence unavailable.');
  const inventory = await inventoryResponse.json();
  const evidenceResponses = await Promise.all([
    fetch('/model.glb', { cache: 'no-store' }),
    ...(inventory.residualReportSha256
      ? [
          fetch('/residual.json', { cache: 'no-store' }),
          fetch('/baseline-review.json', { cache: 'no-store' }),
        ]
      : []),
  ]);
  if (evidenceResponses.some((response) => !response.ok))
    throw new Error('Verified evidence unavailable.');
  const [modelResponse, residualResponse, baselineResponse] = evidenceResponses;
  const residualReport = residualResponse ? await residualResponse.json() : null;
  const baselineReview = baselineResponse ? await baselineResponse.json() : null;
  if (
    (residualReport === null) !== (baselineReview === null) ||
    (residualReport &&
      (residualReport.format !== 'tailfin-meshy-semantic-residual-topology' ||
        residualReport.operationId !== inventory.operationId ||
        residualReport.derivativeSha256 !== inventory.derivativeSha256 ||
        residualReport.inventoryReportSha256 !== inventory.reportSha256 ||
        residualReport.reviewSourceSha256 !== inventory.baselineReviewSha256)) ||
    (baselineReview &&
      (baselineReview.format !== 'tailfin-meshy-semantic-review' ||
        baselineReview.operationId !== inventory.operationId ||
        baselineReview.derivativeSha256 !== inventory.derivativeSha256 ||
        baselineReview.inventoryReportSha256 !== inventory.reportSha256))
  )
    throw new Error('Residual evidence identity does not match this workbench.');
  const gltf = await new GLTFLoader().parseAsync(await modelResponse.arrayBuffer(), '');
  const targetMetadata = [
    ...inventory.requiredSemanticTargets,
    {
      id: 'discarded_artifact',
      role: 'quarantine_exclusion',
      materialClass: null,
      required: false,
    },
  ];
  const targetIndex = new Map(targetMetadata.map((target, index) => [target.id, index]));
  const findings = new Map(
    inventory.requiredSemanticTargets.map((target) => [
      target.id,
      { status: 'unreviewed', rationale: '' },
    ]),
  );
  const draftIdentity = {
    operationId: inventory.operationId,
    derivativeSha256: inventory.derivativeSha256,
    inventoryReportSha256: inventory.reportSha256,
    ...(residualReport
      ? {
          residualReportSha256: inventory.residualReportSha256,
          baselineReviewSha256: inventory.baselineReviewSha256,
        }
      : {}),
  };
  const draftKey = semanticWorkbenchDraftKey(draftIdentity);
  let reviewedAt = new Date().toISOString();
  let residualReviewedAt = new Date().toISOString();
  let draftEnabled = false;
  for (const target of targetMetadata) {
    const option = document.createElement('option');
    option.value = target.id;
    option.textContent = `${target.id.replaceAll('_', ' ')} · ${target.role}`;
    elements.target.append(option);
    if (target.id !== 'discarded_artifact')
      elements['decision-target'].append(option.cloneNode(true));
  }
  for (const [value, label] of evidenceViews) {
    const wrapper = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = value;
    wrapper.append(checkbox, label);
    elements['decision-views'].append(wrapper);
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0xdce5ec);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x506070, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(20, 30, 18);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 1.2);
  fill.position.set(-18, -12, -20);
  scene.add(fill);
  const group = new THREE.Group();
  group.add(gltf.scene);
  scene.add(group);
  const aircraftBounds = new THREE.Box3().setFromObject(gltf.scene);
  const aircraftCentre = aircraftBounds.getCenter(new THREE.Vector3());
  const aircraftSize = aircraftBounds.getSize(new THREE.Vector3());
  const span = Math.max(aircraftSize.x, aircraftSize.y, aircraftSize.z);
  group.position.sub(aircraftCentre);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.01, span * 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.target.set(0, 0, 0);
  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const meshes = [];
  const meshById = new Map();
  const assignments = new Map();
  const adjacency = new WeakMap();
  let activeComponent = inventory.components[0]?.componentId ?? null;
  let isolationEnabled = false;
  let wireframeEnabled = false;
  let residualHighlightEnabled = false;
  let activePatchIndex = residualReport ? 0 : -1;
  let activePatchFaces = new Set();
  const patchDecisions = new Map(
    (residualReport?.residualPatches ?? []).map((patch) => [
      patch.patchId,
      { resolution: 'unreviewed', semanticTargetId: '', rationale: '', evidenceViews: [] },
    ]),
  );

  gltf.scene.traverse((object) => {
    if (!object.isMesh) return;
    const component = inventory.components.find((entry) => entry.componentId === object.name);
    const position = object.geometry.getAttribute('position');
    if (!component || !position || position.count !== component.triangles * 3)
      throw new Error('Model and inventory component ranges disagree.');
    const colors = new Float32Array(position.count * 3);
    colors.fill(0.72);
    object.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    object.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.68,
      metalness: 0,
      side: THREE.FrontSide,
    });
    meshes.push(object);
    meshById.set(object.name, object);
    assignments.set(object.name, new Array(component.triangles).fill(null));
  });
  if (meshes.length !== inventory.components.length)
    throw new Error('Model and inventory component counts disagree.');

  function renderColors(mesh) {
    const values = assignments.get(mesh.name);
    const color = mesh.geometry.getAttribute('color');
    for (let face = 0; face < values.length; face += 1) {
      const selected = values[face];
      const patch = residualReport?.residualPatches[activePatchIndex];
      const isActivePatch = patch?.componentId === mesh.name && activePatchFaces.has(face);
      const value = isActivePatch
        ? new THREE.Color(0xffe04f)
        : residualHighlightEnabled
          ? new THREE.Color(selected === null ? 0xff8a33 : 0x26313a)
          : selected === null
            ? new THREE.Color(0xb8c0c7)
            : new THREE.Color(palette[targetIndex.get(selected)]);
      for (let corner = 0; corner < 3; corner += 1)
        color.setXYZ(face * 3 + corner, value.r, value.g, value.b);
    }
    color.needsUpdate = true;
    render();
  }

  function targetCounts() {
    const counts = new Map(targetMetadata.map((target) => [target.id, 0]));
    let uncovered = 0;
    for (const values of assignments.values())
      for (const target of values) {
        if (target === null) uncovered++;
        else counts.set(target, counts.get(target) + 1);
      }
    return { counts, uncovered };
  }

  function updateStats() {
    const { counts, uncovered } = targetCounts();
    const total = inventory.components.reduce((sum, component) => sum + component.triangles, 0);
    const active = inventory.components.find(
      (component) => component.componentId === activeComponent,
    );
    const selected = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const centre = active?.boundsCanonicalMetres.centre.map((value) => value.toFixed(2)).join(', ');
    const extent = active?.boundsCanonicalMetres.extent.map((value) => value.toFixed(2)).join(', ');
    const mirror = active?.mirrorCandidates[0];
    elements.stats.textContent = `Selected component: ${activeComponent ?? 'none'}\nComponent triangles: ${active?.triangles ?? 0}\nSide evidence: ${active?.side ?? 'none'}\nCentre XYZ m: ${centre ?? 'none'}\nExtent XYZ m: ${extent ?? 'none'}\nBest mirror evidence: ${mirror ? `${mirror.componentId} (${mirror.evidenceScore.toFixed(4)})` : 'none'}\nAssigned: ${selected} / ${total}\nUncovered: ${uncovered}\nActive target faces: ${counts.get(elements.target.value) ?? 0}`;
    for (const button of elements.components.querySelectorAll('button'))
      button.classList.toggle('active', button.dataset.component === activeComponent);
  }

  function selectComponent(componentId, focus = false) {
    activeComponent = componentId;
    if (isolationEnabled) for (const mesh of meshes) mesh.visible = mesh.name === activeComponent;
    if (focus) {
      const mesh = meshById.get(componentId);
      frameBounds(componentBounds(mesh), [1, 0.45, 1], 3);
    }
    updateStats();
    if (draftEnabled) saveDraft();
  }

  function facesOfPatch(patch) {
    return patch.componentLocalTriangleRanges.flatMap((range) =>
      Array.from(
        { length: range.endExclusive - range.startInclusive },
        (_, index) => range.startInclusive + index,
      ),
    );
  }

  function patchBounds(mesh, faces) {
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    mesh.updateWorldMatrix(true, false);
    const position = mesh.geometry.getAttribute('position');
    for (const face of faces)
      for (let corner = 0; corner < 3; corner += 1) {
        point.fromBufferAttribute(position, face * 3 + corner).applyMatrix4(mesh.matrixWorld);
        box.expandByPoint(point);
      }
    return box;
  }

  function activePatchDecision() {
    const patch = residualReport?.residualPatches[activePatchIndex];
    return patch ? patchDecisions.get(patch.patchId) : null;
  }

  function syncPatchDecisionUi() {
    const decision = activePatchDecision();
    const disabled = !decision;
    elements['decision-resolution'].disabled = disabled;
    elements['decision-rationale'].disabled = disabled;
    elements['decision-target'].disabled =
      disabled || decision?.resolution !== 'assign_existing_geometry';
    elements['decision-resolution'].value = decision?.resolution ?? 'unreviewed';
    elements['decision-target'].value =
      decision?.semanticTargetId || inventory.requiredSemanticTargets[0].id;
    elements['decision-rationale'].value = decision?.rationale ?? '';
    for (const checkbox of elements['decision-views'].querySelectorAll('input')) {
      checkbox.disabled = disabled;
      checkbox.checked = decision?.evidenceViews.includes(checkbox.value) ?? false;
    }
    elements['export-residual'].disabled = !residualReport;
    const decisions = [...patchDecisions.values()];
    const decided = decisions.filter((entry) => entry.resolution !== 'unreviewed').length;
    const evidenced = decisions.filter(
      (entry) =>
        entry.resolution !== 'unreviewed' &&
        entry.rationale.trim().length >= 12 &&
        entry.evidenceViews.length > 0,
    ).length;
    elements['decision-progress'].textContent = residualReport
      ? `Decided patches: ${String(decided)} / ${String(decisions.length)}\nWith rationale and evidence: ${String(evidenced)} / ${String(decisions.length)}`
      : 'No residual decision review loaded.';
  }

  function updatePatchUi() {
    const patch = residualReport?.residualPatches[activePatchIndex];
    for (const button of elements.patches.querySelectorAll('button'))
      button.classList.toggle('active', Number(button.dataset.patchIndex) === activePatchIndex);
    for (const id of ['previous-patch', 'next-patch', 'assign-patch', 'clear-patch'])
      elements[id].disabled = !patch;
    if (!patch) {
      elements['patch-stats'].textContent = 'No residual report loaded.';
      syncPatchDecisionUi();
      return;
    }
    const centre = patch.boundsCanonicalMetres.centre.map((value) => value.toFixed(2)).join(', ');
    const extent = patch.boundsCanonicalMetres.extent.map((value) => value.toFixed(2)).join(', ');
    elements['patch-stats'].textContent =
      `Patch: ${patch.patchId} (${String(activePatchIndex + 1)} / ${String(residualReport.residualPatches.length)})\nComponent: ${patch.componentId}\nTriangles: ${String(patch.triangles)}\nArea m²: ${String(patch.surfaceAreaSquareMetres)}\nCentre XYZ m: ${centre}\nExtent XYZ m: ${extent}\nBoundary edges: ${String(patch.boundaryEdges)}\nInternal non-manifold edges: ${String(patch.nonManifoldEdgesWithinPatch)}`;
    syncPatchDecisionUi();
  }

  function selectResidualPatch(index, focus = true) {
    if (!residualReport) return;
    const count = residualReport.residualPatches.length;
    activePatchIndex = ((index % count) + count) % count;
    const patch = residualReport.residualPatches[activePatchIndex];
    activePatchFaces = new Set(facesOfPatch(patch));
    selectComponent(patch.componentId);
    for (const mesh of meshes) renderColors(mesh);
    updatePatchUi();
    if (focus) {
      const mesh = meshById.get(patch.componentId);
      frameBounds(patchBounds(mesh, [...activePatchFaces]), [1, 0.45, 1], 3.5);
    }
    setStatus(
      `${patch.patchId}: ${String(patch.triangles)} sealed residual faces highlighted in yellow.`,
    );
  }

  elements.isolate.onclick = () => {
    isolationEnabled = !isolationEnabled;
    elements.isolate.setAttribute('aria-pressed', String(isolationEnabled));
    elements.isolate.textContent = isolationEnabled ? 'Show all components' : 'Isolate component';
    for (const mesh of meshes) mesh.visible = !isolationEnabled || mesh.name === activeComponent;
    const currentDirection = camera.position.clone().sub(controls.target).normalize().toArray();
    frameBounds(visibleBounds(), currentDirection, isolationEnabled ? 3 : 2.15);
    setStatus(
      isolationEnabled
        ? `${activeComponent} isolated for visual review.`
        : 'All candidate components visible.',
    );
  };

  elements.wireframe.onclick = () => {
    wireframeEnabled = !wireframeEnabled;
    elements.wireframe.setAttribute('aria-pressed', String(wireframeEnabled));
    elements.wireframe.textContent = wireframeEnabled ? 'Hide topology' : 'Show topology';
    for (const mesh of meshes) mesh.material.wireframe = wireframeEnabled;
    render();
    setStatus(wireframeEnabled ? 'Topology overlay enabled.' : 'Topology overlay disabled.');
  };

  elements.residual.onclick = () => {
    residualHighlightEnabled = !residualHighlightEnabled;
    elements.residual.setAttribute('aria-pressed', String(residualHighlightEnabled));
    elements.residual.textContent = residualHighlightEnabled
      ? 'Show semantic colours'
      : 'Highlight uncovered';
    for (const mesh of meshes) renderColors(mesh);
    setStatus(
      residualHighlightEnabled
        ? 'Uncovered faces are orange; reviewed faces are dark.'
        : 'Semantic colours restored.',
    );
  };

  elements['previous-patch'].onclick = () => selectResidualPatch(activePatchIndex - 1);
  elements['next-patch'].onclick = () => selectResidualPatch(activePatchIndex + 1);
  elements['assign-patch'].onclick = () => {
    const patch = residualReport?.residualPatches[activePatchIndex];
    const mesh = patch && meshById.get(patch.componentId);
    if (!mesh) return;
    const values = assignments.get(mesh.name);
    const uncovered = [...activePatchFaces].filter((face) => values[face] === null);
    if (!uncovered.length)
      return setStatus('The active patch has no uncovered faces to assign.', true);
    assign(mesh, uncovered, elements.target.value);
  };
  elements['clear-patch'].onclick = () => {
    const patch = residualReport?.residualPatches[activePatchIndex];
    const mesh = patch && meshById.get(patch.componentId);
    if (mesh) assign(mesh, [...activePatchFaces], null);
  };
  elements['decision-resolution'].onchange = () => {
    const decision = activePatchDecision();
    if (!decision) return;
    decision.resolution = elements['decision-resolution'].value;
    decision.semanticTargetId =
      decision.resolution === 'assign_existing_geometry' ? elements['decision-target'].value : '';
    residualReviewedAt = new Date().toISOString();
    syncPatchDecisionUi();
    saveDraft();
  };
  elements['decision-target'].onchange = () => {
    const decision = activePatchDecision();
    if (!decision || decision.resolution !== 'assign_existing_geometry') return;
    decision.semanticTargetId = elements['decision-target'].value;
    residualReviewedAt = new Date().toISOString();
    saveDraft();
  };
  elements['decision-rationale'].oninput = () => {
    const decision = activePatchDecision();
    if (!decision) return;
    decision.rationale = elements['decision-rationale'].value;
    residualReviewedAt = new Date().toISOString();
    syncPatchDecisionUi();
    saveDraft();
  };
  for (const checkbox of elements['decision-views'].querySelectorAll('input'))
    checkbox.onchange = () => {
      const decision = activePatchDecision();
      if (!decision) return;
      decision.evidenceViews = [
        ...elements['decision-views'].querySelectorAll('input:checked'),
      ].map((input) => input.value);
      residualReviewedAt = new Date().toISOString();
      syncPatchDecisionUi();
      saveDraft();
    };

  for (const component of inventory.components) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.component = component.componentId;
    button.textContent = `${component.componentId} · ${component.triangles} faces · ${component.side}`;
    button.title = component.requiresManualTriangleLevelReview
      ? 'Crosses centre plane: requires face-level review'
      : 'Whole-component assignment still requires visual review';
    button.onclick = () => selectComponent(component.componentId, true);
    elements.components.append(button);
  }
  for (const [index, patch] of residualReport?.residualPatches.entries() ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.patchIndex = String(index);
    button.textContent = `${patch.patchId} · ${String(patch.triangles)} faces`;
    button.onclick = () => selectResidualPatch(index);
    elements.patches.append(button);
  }

  function buildAdjacency(mesh) {
    if (adjacency.has(mesh.geometry)) return adjacency.get(mesh.geometry);
    const position = mesh.geometry.getAttribute('position');
    const faceCount = position.count / 3;
    const neighbours = Array.from({ length: faceCount }, () => new Set());
    const edges = new Map();
    const key = (vertex) =>
      `${position.getX(vertex)},${position.getY(vertex)},${position.getZ(vertex)}`;
    for (let face = 0; face < faceCount; face += 1) {
      const vertices = [face * 3, face * 3 + 1, face * 3 + 2];
      for (let edge = 0; edge < 3; edge += 1) {
        const pair = [key(vertices[edge]), key(vertices[(edge + 1) % 3])].sort().join('|');
        const incident = edges.get(pair) ?? [];
        for (const other of incident) {
          neighbours[face].add(other);
          neighbours[other].add(face);
        }
        incident.push(face);
        edges.set(pair, incident);
      }
    }
    adjacency.set(mesh.geometry, neighbours);
    return neighbours;
  }

  function faceNormal(mesh, face) {
    const normal = mesh.geometry.getAttribute('normal');
    return new THREE.Vector3(
      normal.getX(face * 3),
      normal.getY(face * 3),
      normal.getZ(face * 3),
    ).normalize();
  }

  function affectedFaces(mesh, seed, flood, clearing) {
    const values = assignments.get(mesh.name);
    const seedAssignment = values[seed];
    if (!semanticWorkbenchFloodCompatible(seedAssignment, seedAssignment, clearing)) return [];
    if (!flood) return [seed];
    const neighbours = buildAdjacency(mesh);
    const threshold = Math.cos(THREE.MathUtils.degToRad(Number(elements.angle.value)));
    const seedNormal = faceNormal(mesh, seed);
    const queue = [seed];
    const seen = new Set(queue);
    while (queue.length) {
      const face = queue.shift();
      for (const next of neighbours[face])
        if (
          !seen.has(next) &&
          semanticWorkbenchFloodCompatible(seedAssignment, values[next], clearing) &&
          seedNormal.dot(faceNormal(mesh, next)) >= threshold
        ) {
          seen.add(next);
          queue.push(next);
        }
    }
    return [...seen];
  }

  function assign(mesh, faces, target) {
    const values = assignments.get(mesh.name);
    for (const face of faces) values[face] = target;
    if (target && target !== 'discarded_artifact') {
      const finding = findings.get(target);
      finding.status = 'present';
      finding.rationale = '';
      if (elements.target.value === target) syncFindingUi();
    }
    const { counts } = targetCounts();
    for (const [targetId, finding] of findings)
      if (finding.status === 'present' && counts.get(targetId) === 0) {
        finding.status = 'unreviewed';
        finding.rationale = '';
      }
    renderColors(mesh);
    syncFindingUi();
    updateStats();
    setStatus(
      target === null
        ? `Cleared ${String(faces.length)} faces from ${mesh.name}.`
        : `Assigned ${String(faces.length)} faces in ${mesh.name} to ${target}.`,
    );
    saveDraft();
  }

  let pointerDown = null;
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button === 0) pointerDown = [event.clientX, event.clientY];
  });
  canvas.addEventListener('pointermove', (event) => {
    if (
      pointerDown &&
      Math.hypot(event.clientX - pointerDown[0], event.clientY - pointerDown[1]) > 4
    )
      pointerDown = null;
  });
  canvas.addEventListener('click', (event) => {
    if (event.button !== 0 || !pointerDown) return;
    pointerDown = null;
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit || hit.faceIndex === undefined) return;
    selectComponent(hit.object.name);
    assign(
      hit.object,
      affectedFaces(hit.object, hit.faceIndex, event.shiftKey, event.altKey),
      event.altKey ? null : elements.target.value,
    );
  });

  elements.whole.onclick = () => {
    const mesh = meshById.get(activeComponent);
    if (mesh)
      assign(
        mesh,
        assignments.get(mesh.name).map((_, index) => index),
        elements.target.value,
      );
  };
  elements.unassigned.onclick = () => {
    const mesh = meshById.get(activeComponent);
    if (mesh) {
      const values = assignments.get(mesh.name);
      assign(
        mesh,
        values.flatMap((value, index) => (value === null ? [index] : [])),
        elements.target.value,
      );
    }
  };
  elements['clear-component'].onclick = () => {
    const mesh = meshById.get(activeComponent);
    if (mesh)
      assign(
        mesh,
        assignments.get(mesh.name).map((_, index) => index),
        null,
      );
  };
  elements.angle.oninput = () => {
    elements['angle-value'].textContent = `${elements.angle.value}°`;
    saveDraft();
  };

  function syncFindingUi() {
    const finding = findings.get(elements.target.value);
    elements.finding.disabled = !finding;
    elements.rationale.disabled = !finding;
    elements.finding.value = finding?.status ?? 'unreviewed';
    elements.rationale.value = finding?.rationale ?? '';
    updateStats();
  }
  elements.target.onchange = () => {
    syncFindingUi();
    saveDraft();
  };
  elements.finding.onchange = () => {
    const metadata = targetMetadata.find((target) => target.id === elements.target.value);
    const finding = findings.get(elements.target.value);
    if (!finding) return;
    if (elements.finding.value === 'not_applicable' && metadata.required) {
      elements.finding.value = finding.status;
      return setStatus('Required targets cannot be marked not applicable.', true);
    }
    finding.status = elements.finding.value;
    if (!['missing_requires_modeling', 'not_applicable'].includes(finding.status)) {
      finding.rationale = '';
      elements.rationale.value = '';
    }
    saveDraft();
  };
  elements.rationale.oninput = () => {
    const finding = findings.get(elements.target.value);
    if (finding) finding.rationale = elements.rationale.value.trim();
    saveDraft();
  };
  elements.reviewer.oninput = () => {
    if (residualReport) residualReviewedAt = new Date().toISOString();
    saveDraft();
  };

  function draftState() {
    return {
      format: 'tailfin-meshy-semantic-workbench-draft',
      formatVersion: 1,
      ...draftIdentity,
      reviewedAt,
      reviewedBy: elements.reviewer.value,
      activeTargetId: elements.target.value,
      activeComponentId: activeComponent,
      floodAngle: Number(elements.angle.value),
      targetFindings: inventory.requiredSemanticTargets.map((target) => {
        const finding = findings.get(target.id);
        return {
          targetId: target.id,
          status: finding.status,
          ...(finding.rationale ? { rationale: finding.rationale } : {}),
        };
      }),
      dispositions: compressSemanticAssignments(
        inventory.components,
        targetMetadata.map((target) => target.id),
        assignments,
      ),
      ...(residualReport
        ? {
            activePatchIndex,
            residualReviewedAt,
            patchDecisions: residualReport.residualPatches.map((patch) => ({
              patchId: patch.patchId,
              ...patchDecisions.get(patch.patchId),
            })),
          }
        : {}),
    };
  }

  function saveDraft() {
    if (!draftEnabled) return;
    try {
      const serialized = JSON.stringify(draftState());
      if (new TextEncoder().encode(serialized).length > semanticWorkbenchDraftMaxBytes)
        throw new Error('Draft exceeds its bound.');
      localStorage.setItem(draftKey, serialized);
    } catch {
      setStatus('Local draft autosave failed. Download review JSON before leaving.', true);
    }
  }

  function stageReviewState(review, allowIncompleteRationale = false) {
    if (
      review.operationId !== inventory.operationId ||
      review.derivativeSha256 !== inventory.derivativeSha256 ||
      review.inventoryReportSha256 !== inventory.reportSha256 ||
      !Number.isFinite(Date.parse(review.reviewedAt)) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{1,79}$/.test(review.reviewedBy)
    )
      throw new Error('Review identity or reviewer does not match this workbench.');
    const stagedFindings = new Map();
    const allowedStatuses = new Set([
      'unreviewed',
      'present',
      'missing_requires_modeling',
      'not_applicable',
    ]);
    for (const finding of review.targetFindings ?? []) {
      const metadata = inventory.requiredSemanticTargets.find(
        (target) => target.id === finding.targetId,
      );
      const needsRationale = ['missing_requires_modeling', 'not_applicable'].includes(
        finding.status,
      );
      const rationale = finding.rationale ?? '';
      if (
        !metadata ||
        stagedFindings.has(finding.targetId) ||
        !allowedStatuses.has(finding.status) ||
        (metadata.required && finding.status === 'not_applicable') ||
        typeof rationale !== 'string' ||
        rationale.length > 500 ||
        (!allowIncompleteRationale && needsRationale !== rationale.length >= 12) ||
        (!needsRationale && rationale.length > 0)
      )
        throw new Error('Review target finding is invalid.');
      stagedFindings.set(finding.targetId, { status: finding.status, rationale });
    }
    if (stagedFindings.size !== inventory.requiredSemanticTargets.length)
      throw new Error('Review must contain every target finding exactly once.');
    const imported = expandSemanticDispositions(
      inventory.components,
      new Set(targetMetadata.map((target) => target.id)),
      review.dispositions ?? [],
    );
    const counts = new Map(targetMetadata.map((target) => [target.id, 0]));
    for (const values of imported.values())
      for (const targetId of values)
        if (targetId !== null) counts.set(targetId, counts.get(targetId) + 1);
    for (const [targetId, finding] of stagedFindings)
      if ((finding.status === 'present') !== counts.get(targetId) > 0)
        throw new Error('Review findings and selected faces disagree.');
    return { stagedFindings, imported };
  }

  function stagePatchDecisionDraft(review) {
    if (!residualReport || review.patchDecisions === undefined) return null;
    if (
      !Number.isInteger(review.activePatchIndex) ||
      review.activePatchIndex < 0 ||
      review.activePatchIndex >= residualReport.residualPatches.length ||
      !Number.isFinite(Date.parse(review.residualReviewedAt)) ||
      review.patchDecisions.length !== residualReport.residualPatches.length
    )
      throw new Error('Residual patch draft controls are stale.');
    const allowedPatchIds = new Set(residualReport.residualPatches.map((patch) => patch.patchId));
    const allowedTargets = new Set(inventory.requiredSemanticTargets.map((target) => target.id));
    const allowedViews = new Set(evidenceViews.map(([value]) => value));
    const staged = new Map();
    for (const decision of review.patchDecisions) {
      const hasTarget = (decision.semanticTargetId ?? '') !== '';
      if (
        !allowedPatchIds.has(decision.patchId) ||
        staged.has(decision.patchId) ||
        ![
          'unreviewed',
          'assign_existing_geometry',
          'discard_artifact',
          'repair_into_new_derivative',
        ].includes(decision.resolution) ||
        (decision.resolution === 'assign_existing_geometry') !== hasTarget ||
        (hasTarget && !allowedTargets.has(decision.semanticTargetId)) ||
        typeof decision.rationale !== 'string' ||
        decision.rationale.length > 500 ||
        !Array.isArray(decision.evidenceViews) ||
        decision.evidenceViews.length > evidenceViews.length ||
        new Set(decision.evidenceViews).size !== decision.evidenceViews.length ||
        decision.evidenceViews.some((view) => !allowedViews.has(view))
      )
        throw new Error('Residual patch draft decision is invalid.');
      staged.set(decision.patchId, {
        resolution: decision.resolution,
        semanticTargetId: decision.semanticTargetId ?? '',
        rationale: decision.rationale,
        evidenceViews: [...decision.evidenceViews],
      });
    }
    return staged;
  }

  function applyReviewState(review, draft = false) {
    const { stagedFindings, imported } = stageReviewState(review, draft);
    const stagedPatchDecisions = draft ? stagePatchDecisionDraft(review) : null;
    findings.clear();
    for (const [targetId, finding] of stagedFindings) findings.set(targetId, finding);
    for (const [componentId, values] of imported) assignments.set(componentId, values);
    reviewedAt = review.reviewedAt;
    elements.reviewer.value = review.reviewedBy;
    if (draft) {
      elements.target.value = review.activeTargetId;
      elements.angle.value = String(review.floodAngle);
      elements['angle-value'].textContent = `${String(review.floodAngle)}°`;
      activeComponent = review.activeComponentId;
      if (stagedPatchDecisions) {
        patchDecisions.clear();
        for (const [patchId, decision] of stagedPatchDecisions)
          patchDecisions.set(patchId, decision);
        activePatchIndex = review.activePatchIndex;
        residualReviewedAt = review.residualReviewedAt;
      }
    }
    for (const mesh of meshes) renderColors(mesh);
    syncFindingUi();
  }

  function buildReview() {
    const dispositions = compressSemanticAssignments(
      inventory.components,
      targetMetadata.map((target) => target.id),
      assignments,
    );
    const targetFindings = inventory.requiredSemanticTargets.map((target) => {
      const finding = findings.get(target.id);
      const result = { targetId: target.id, status: finding.status };
      if (finding.rationale) result.rationale = finding.rationale;
      return result;
    });
    for (const finding of targetFindings) {
      const count = dispositions.filter((entry) => entry.targetId === finding.targetId).length;
      if ((finding.status === 'present') !== count > 0)
        throw new Error(`Finding and selected faces disagree for ${finding.targetId}.`);
      if (
        ['missing_requires_modeling', 'not_applicable'].includes(finding.status) &&
        !finding.rationale
      )
        throw new Error(`A rationale is required for ${finding.targetId}.`);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{1,79}$/.test(elements.reviewer.value.trim()))
      throw new Error('Enter a valid reviewer name.');
    return {
      format: 'tailfin-meshy-semantic-review',
      formatVersion: 1,
      operationId: inventory.operationId,
      derivativeSha256: inventory.derivativeSha256,
      inventoryReportSha256: inventory.reportSha256,
      reviewedAt,
      reviewedBy: elements.reviewer.value.trim(),
      targetFindings,
      dispositions,
      notes: ['Authored in the Tailfin local semantic review workbench.'],
    };
  }

  function buildResidualReview() {
    if (!residualReport) throw new Error('No sealed residual report is loaded.');
    const reviewer = elements.reviewer.value.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{1,79}$/.test(reviewer))
      throw new Error('Enter a valid reviewer name.');
    const decisions = residualReport.residualPatches.map((patch) => {
      const decision = patchDecisions.get(patch.patchId);
      if (!decision || decision.resolution === 'unreviewed')
        throw new Error('Decide every residual patch before downloading the decision review.');
      const rationale = decision.rationale.trim();
      if (rationale.length < 12)
        throw new Error(`${patch.patchId} requires a rationale of at least 12 characters.`);
      if (!decision.evidenceViews.length)
        throw new Error(`${patch.patchId} requires at least one evidence view.`);
      if (
        decision.resolution === 'assign_existing_geometry' &&
        !inventory.requiredSemanticTargets.some((target) => target.id === decision.semanticTargetId)
      )
        throw new Error(`${patch.patchId} requires one valid semantic assignment target.`);
      return {
        patchId: patch.patchId,
        resolution: decision.resolution,
        ...(decision.resolution === 'assign_existing_geometry'
          ? { semanticTargetId: decision.semanticTargetId }
          : {}),
        rationale,
        evidenceViews: [...decision.evidenceViews],
      };
    });
    return {
      format: 'tailfin-meshy-semantic-residual-review',
      formatVersion: 1,
      operationId: inventory.operationId,
      residualReportSha256: inventory.residualReportSha256,
      reviewedAt: residualReviewedAt,
      reviewedBy: reviewer,
      decisions,
      notes: ['Authored in the Tailfin local residual-patch review workbench.'],
    };
  }

  elements.export.onclick = () => {
    try {
      const review = buildReview();
      const blob = new Blob([`${JSON.stringify(review, null, 2)}\n`], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${inventory.operationId}-semantic-review.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
      setStatus('Review JSON downloaded. Validate it with the semantics CLI before any repair.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Review export refused.', true);
    }
  };

  elements['export-residual'].onclick = () => {
    try {
      const review = buildResidualReview();
      const blob = new Blob([`${JSON.stringify(review, null, 2)}\n`], {
        type: 'application/json',
      });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${inventory.operationId}-residual-review.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
      setStatus('Patch decisions downloaded. Seal them with the residual-review CLI.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Patch decision export refused.', true);
    }
  };

  elements.import.onchange = async () => {
    try {
      const file = elements.import.files?.[0];
      if (!file || file.size > 1024 * 1024) throw new Error('Review file is missing or too large.');
      const review = JSON.parse(await file.text());
      if (
        review.format !== 'tailfin-meshy-semantic-review' ||
        review.formatVersion !== 1 ||
        review.operationId !== inventory.operationId ||
        review.derivativeSha256 !== inventory.derivativeSha256 ||
        review.inventoryReportSha256 !== inventory.reportSha256
      )
        throw new Error('Review identity does not match this workbench.');
      applyReviewState(review);
      saveDraft();
      setStatus('Matching review imported and autosaved. Inspect it before re-exporting.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Review import refused.', true);
    } finally {
      elements.import.value = '';
    }
  };

  elements['reset-draft'].onclick = () => {
    draftEnabled = false;
    localStorage.removeItem(draftKey);
    reviewedAt = new Date().toISOString();
    elements.reviewer.value = 'local-operator';
    elements.target.value = inventory.requiredSemanticTargets[0].id;
    elements.angle.value = '25';
    elements['angle-value'].textContent = '25°';
    activeComponent = inventory.components[0].componentId;
    residualReviewedAt = new Date().toISOString();
    activePatchIndex = residualReport ? 0 : -1;
    for (const decision of patchDecisions.values()) {
      decision.resolution = 'unreviewed';
      decision.semanticTargetId = '';
      decision.rationale = '';
      decision.evidenceViews = [];
    }
    if (baselineReview) applyReviewState(baselineReview);
    else {
      for (const target of inventory.requiredSemanticTargets)
        findings.set(target.id, { status: 'unreviewed', rationale: '' });
      for (const [componentId, values] of assignments)
        assignments.set(
          componentId,
          values.map(() => null),
        );
      for (const mesh of meshes) renderColors(mesh);
      syncFindingUi();
    }
    draftEnabled = true;
    if (residualReport) selectResidualPatch(activePatchIndex, false);
    else syncPatchDecisionUi();
    setStatus(
      baselineReview
        ? 'Local draft cleared. The sealed baseline review was restored.'
        : 'Local draft cleared. The quarantined candidate is unchanged.',
    );
  };

  function componentBounds(mesh) {
    mesh.updateWorldMatrix(true, false);
    return new THREE.Box3().setFromObject(mesh);
  }
  function visibleBounds() {
    const selected = meshById.get(activeComponent);
    return isolationEnabled && selected
      ? componentBounds(selected)
      : aircraftBounds.clone().translate(group.position);
  }
  function visibleSubBounds(predicate) {
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const mesh of meshes) {
      if (!mesh.visible) continue;
      mesh.updateWorldMatrix(true, false);
      const position = mesh.geometry.getAttribute('position');
      for (let index = 0; index < position.count; index += 1) {
        point.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
        if (predicate(point)) box.expandByPoint(point);
      }
    }
    return box.isEmpty() ? visibleBounds() : box;
  }
  function frameBounds(box, direction, distanceMultiplier) {
    const centre = box.getCenter(new THREE.Vector3());
    const size = Math.max(...box.getSize(new THREE.Vector3()).toArray(), span * 0.03);
    controls.target.copy(centre);
    camera.position
      .copy(centre)
      .add(new THREE.Vector3(...direction).normalize().multiplyScalar(size * distanceMultiplier));
    camera.up.set(0, 1, 0);
    camera.lookAt(centre);
    controls.update();
  }
  const setView = (direction) =>
    frameBounds(visibleBounds(), direction, isolationEnabled ? 3 : 2.15);
  const worldBounds = aircraftBounds.clone().translate(group.position);
  for (const [name, direction, region] of [
    ['Quarter', [1, 0.55, 1], null],
    ['Left', [-1, 0, 0], null],
    ['Right', [1, 0, 0], null],
    ['Top', [0, 1, 0.001], null],
    ['Underside', [0, -1, 0.001], null],
    ['Nose', [0, 0, -1], null],
    ['Tail', [0, 0, 1], null],
    [
      'Winglet left',
      [0, 0, -1],
      (point) => semanticWorkbenchCloseUpIncludes(worldBounds, 'winglet_left', point),
    ],
    [
      'Winglet right',
      [0, 0, -1],
      (point) => semanticWorkbenchCloseUpIncludes(worldBounds, 'winglet_right', point),
    ],
    [
      'Tail close-up',
      [1, 0.15, 0],
      (point) => semanticWorkbenchCloseUpIncludes(worldBounds, 'tail', point),
    ],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.onclick = () =>
      region ? frameBounds(visibleSubBounds(region), direction, 3) : setView(direction);
    views.append(button);
  }
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
    camera.aspect = rect.width / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
    render();
  };
  new ResizeObserver(resize).observe(canvas);
  let restored = false;
  if (baselineReview) applyReviewState(baselineReview);
  const storedDraft = localStorage.getItem(draftKey);
  if (storedDraft !== null)
    try {
      const draft = parseSemanticWorkbenchDraft(storedDraft, draftIdentity);
      if (
        !targetMetadata.some((target) => target.id === draft.activeTargetId) ||
        !inventory.components.some((component) => component.componentId === draft.activeComponentId)
      )
        throw new Error('Semantic workbench draft controls are stale.');
      applyReviewState(draft, true);
      restored = true;
    } catch {
      localStorage.removeItem(draftKey);
    }
  draftEnabled = true;
  selectComponent(activeComponent);
  syncFindingUi();
  if (residualReport) selectResidualPatch(restored ? activePatchIndex : 0);
  else setView([1, 0.55, 1]);
  updatePatchUi();
  setStatus(
    restored
      ? 'Verified candidate loaded. Matching local draft restored.'
      : baselineReview
        ? 'Verified candidate and sealed baseline review loaded.'
        : 'Verified candidate loaded. No semantic faces are assigned.',
  );
} catch (error) {
  setStatus(error instanceof Error ? error.message : 'Workbench unavailable.', true);
  canvas.hidden = true;
}
