/* global document, devicePixelRatio, ResizeObserver */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import {
  parseSemanticWorkbenchDraft,
  semanticWorkbenchDraftKey,
  semanticWorkbenchDraftMaxBytes,
} from '../src/semantic-workbench-draft';
import {
  compressSemanticAssignments,
  expandSemanticDispositions,
} from '../src/semantic-workbench-review';

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
    'components',
    'whole',
    'clear-component',
    'reset-draft',
    'export',
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

const setStatus = (message, error = false) => {
  elements.status.textContent = message;
  elements.status.style.borderColor = error ? '#ef6464' : '#f8b34c';
};

try {
  const [inventoryResponse, modelResponse] = await Promise.all([
    fetch('/inventory.json', { cache: 'no-store' }),
    fetch('/model.glb', { cache: 'no-store' }),
  ]);
  if (!inventoryResponse.ok || !modelResponse.ok) throw new Error('Verified evidence unavailable.');
  const inventory = await inventoryResponse.json();
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
  };
  const draftKey = semanticWorkbenchDraftKey(draftIdentity);
  let reviewedAt = new Date().toISOString();
  let draftEnabled = false;
  for (const target of targetMetadata) {
    const option = document.createElement('option');
    option.value = target.id;
    option.textContent = `${target.id.replaceAll('_', ' ')} · ${target.role}`;
    elements.target.append(option);
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
      const value =
        selected === null
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
    elements.stats.textContent = `Selected component: ${activeComponent ?? 'none'}\nComponent triangles: ${active?.triangles ?? 0}\nAssigned: ${selected} / ${total}\nUncovered: ${uncovered}\nActive target faces: ${counts.get(elements.target.value) ?? 0}`;
    for (const button of elements.components.querySelectorAll('button'))
      button.classList.toggle('active', button.dataset.component === activeComponent);
  }

  function selectComponent(componentId, focus = false) {
    activeComponent = componentId;
    if (focus) {
      const mesh = meshById.get(componentId);
      const box = new THREE.Box3().setFromObject(mesh).translate(group.position);
      const centre = box.getCenter(new THREE.Vector3());
      const size = Math.max(...box.getSize(new THREE.Vector3()).toArray(), span * 0.03);
      controls.target.copy(centre);
      camera.position
        .copy(centre)
        .add(new THREE.Vector3(1, 0.45, 1).normalize().multiplyScalar(size * 3));
      controls.update();
    }
    updateStats();
    if (draftEnabled) saveDraft();
  }

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

  function affectedFaces(mesh, seed, flood) {
    if (!flood) return [seed];
    const neighbours = buildAdjacency(mesh);
    const threshold = Math.cos(THREE.MathUtils.degToRad(Number(elements.angle.value)));
    const seedNormal = faceNormal(mesh, seed);
    const queue = [seed];
    const seen = new Set(queue);
    while (queue.length) {
      const face = queue.shift();
      for (const next of neighbours[face])
        if (!seen.has(next) && seedNormal.dot(faceNormal(mesh, next)) >= threshold) {
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
      affectedFaces(hit.object, hit.faceIndex, event.shiftKey),
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
  elements.reviewer.oninput = saveDraft;

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

  function applyReviewState(review, draft = false) {
    const { stagedFindings, imported } = stageReviewState(review, draft);
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
    for (const target of inventory.requiredSemanticTargets)
      findings.set(target.id, { status: 'unreviewed', rationale: '' });
    for (const [componentId, values] of assignments)
      assignments.set(
        componentId,
        values.map(() => null),
      );
    for (const mesh of meshes) renderColors(mesh);
    syncFindingUi();
    draftEnabled = true;
    setStatus('Local draft cleared. The quarantined candidate is unchanged.');
  };

  const setView = (direction) => {
    controls.target.set(0, 0, 0);
    camera.position.copy(new THREE.Vector3(...direction).normalize().multiplyScalar(span * 2.15));
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    controls.update();
  };
  for (const [name, direction] of [
    ['Quarter', [1, 0.55, 1]],
    ['Left', [-1, 0, 0]],
    ['Right', [1, 0, 0]],
    ['Top', [0, 1, 0.001]],
    ['Underside', [0, -1, 0.001]],
    ['Nose', [0, 0, -1]],
    ['Tail', [0, 0, 1]],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.onclick = () => setView(direction);
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
  setView([1, 0.55, 1]);
  setStatus(
    restored
      ? 'Verified candidate loaded. Matching local draft restored.'
      : 'Verified candidate loaded. No semantic faces are assigned.',
  );
} catch (error) {
  setStatus(error instanceof Error ? error.message : 'Workbench unavailable.', true);
  canvas.hidden = true;
}
