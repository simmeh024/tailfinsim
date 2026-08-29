import { dirname, join } from 'node:path';

import sharp from 'sharp';
import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { type MeshyGenerationSpec, meshySpecIdentity } from './meshy';
import { readMeshyArtifact, writeImmutableMeshyArtifact } from './meshy-archive';
import {
  MeshyArtifactDigest,
  MeshySha256,
  meshyRunApprovalIdentity,
  type MeshyRunState,
} from './meshy-run';

export const MeshyCandidateOperation = z.enum([
  'candidate-1',
  'candidate-2',
  'candidate-3',
  'candidate-4',
]);
const FilePath = z.string().min(1).max(4_096);
const Review = z
  .object({
    reviewedAt: z.iso.datetime(),
    referenceOrigin: z.literal('original-ai-authored-for-this-task'),
    authoringModelVersion: z.literal('not-disclosed-by-tool'),
    thirdPartyImageInputs: z.literal(false),
    neutralUnbrandedGearUp: z.literal(true),
    bothEnginesVisible: z.literal(true),
    sensitiveContentIncluded: z.literal(false),
    referenceUploadScope: z.literal('approved-private-candidate-run'),
    paidPlan: z.literal('Pro'),
    paidPeriodStart: z.iso.date(),
    paidPeriodEndExclusive: z.iso.date(),
    receiptVisuallyReviewed: z.literal(true),
    accountEvidence: z.literal('user-supplied-key-and-Pro-receipt'),
    nonEnterpriseTrainingAllowanceReviewed: z.literal(true),
    privateOutputsOnly: z.literal(true),
    commercialAssetAdmission: z.literal('pending'),
    productionPublicationApproved: z.literal(false),
  })
  .strict();

// Every artifact is private. Only referenceImage may cross the Meshy upload boundary.
const roles = {
  referenceImage: { mediaType: 'image/png', limit: 4 * 1024 * 1024 },
  referencePrompt: { mediaType: 'text/plain', limit: 16_384 },
  parentImage: { mediaType: 'image/png', limit: 4 * 1024 * 1024 },
  parentPrompt: { mediaType: 'text/plain', limit: 16_384 },
  authoringRecord: { mediaType: 'application/json', limit: 32_768 },
  termsSnapshot: { mediaType: 'text/html', limit: 2 * 1024 * 1024 },
  ownershipSnapshot: { mediaType: 'text/html', limit: 2 * 1024 * 1024 },
  privatePlanEvidence: { mediaType: 'application/pdf', limit: 2 * 1024 * 1024 },
  consent: { mediaType: 'application/json', limit: 8_192 },
} as const;
type Role = keyof typeof roles;
const roleNames = Object.keys(roles) as Role[];
const Roles = z.enum(roleNames);
const Import = z
  .object({
    format: z.literal('tailfin-meshy-evidence-import'),
    formatVersion: z.literal(1),
    review: Review,
    files: z.record(Roles, FilePath),
  })
  .strict();
const Prepared = z
  .object({
    format: z.literal('tailfin-meshy-prepared-evidence'),
    formatVersion: z.literal(1),
    approvalSha256: MeshySha256,
    specSha256: MeshySha256,
    review: Review,
    artifacts: z.record(Roles, MeshyArtifactDigest),
  })
  .strict();
export type MeshyPreparedEvidence = z.infer<typeof Prepared>;

export const MeshyPricingReview = z
  .object({
    format: z.literal('tailfin-meshy-pricing-review'),
    formatVersion: z.literal(1),
    source: z.literal('https://docs.meshy.ai/en/api/pricing'),
    reviewedAt: z.iso.datetime(),
    reviewedBy: z.literal('local-operator'),
    untexturedCandidateCredits: z.literal(5),
    selectedRetextureCredits: z.literal(10),
    snapshot: MeshyArtifactDigest.refine(
      (value) => value.mediaType === 'text/html' && value.bytes <= 2 * 1024 * 1024,
    ),
  })
  .strict();
const PricingImport = MeshyPricingReview.extend({ snapshotFile: FilePath }).strict();
export const MeshySubmissionProof = z
  .object({
    format: z.literal('tailfin-meshy-submission-proof'),
    formatVersion: z.literal(1),
    operationId: MeshyCandidateOperation,
    approvalSha256: MeshySha256,
    specSha256: MeshySha256,
    preparedSha256: MeshySha256,
    requestBodySha256: MeshySha256,
    pricingReviewSha256: MeshySha256,
    authorizedAt: z.iso.datetime(),
    accountReadinessSha256: MeshySha256,
  })
  .strict();

export function meshyEvidenceDirectory(database: string): string {
  return join(dirname(database), 'a320neo-first-run-evidence');
}
export function meshArtifactPath(root: string, digest: string): string {
  return join(root, `${MeshySha256.parse(digest)}.blob`);
}
export function storeMeshyEvidenceBytes(root: string, bytes: Buffer) {
  const digest = sha256(bytes);
  writeImmutableMeshyArtifact(meshArtifactPath(root, digest), bytes);
  return digest;
}
export function loadMeshyEvidenceBytes(root: string, digest: string, limit: number): Buffer {
  const bytes = readMeshyArtifact(meshArtifactPath(root, digest), limit);
  if (sha256(bytes) !== digest) throw new Error('Evidence digest changed.');
  return bytes;
}
export function loadMeshyEvidenceJson(root: string, digest: string): unknown {
  return JSON.parse(loadMeshyEvidenceBytes(root, digest, 32_768).toString('utf8')) as unknown;
}

async function validateArtifact(role: Role, bytes: Buffer): Promise<void> {
  const policy = roles[role];
  if (bytes.length === 0 || bytes.length > policy.limit)
    throw new Error('Artifact exceeds policy.');
  if (policy.mediaType === 'image/png') {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('PNG required.');
    // libvips may expose only the default frame of APNG: reject animation at the container level.
    for (let offset = 8; offset < bytes.length;) {
      if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk.');
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) throw new Error('Truncated PNG chunk.');
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL')
        throw new Error('Animated PNG refused.');
      offset += length + 12;
    }
    const image = sharp(bytes, { limitInputPixels: 16_777_216, failOn: 'warning' });
    const info = await image.metadata();
    if (
      info.format !== 'png' ||
      !info.width ||
      !info.height ||
      info.width > 4096 ||
      info.height > 4096 ||
      (info.pages ?? 1) !== 1
    )
      throw new Error('Single bounded PNG required.');
    // Force decoding under the pixel limit; the ORIGINAL bytes, not this decoded buffer, are preserved.
    await image.raw().toBuffer();
  } else if (policy.mediaType === 'application/pdf') {
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new Error('PDF evidence required.');
    // Opaque private evidence only: never execute, extract, display or upload this PDF here.
  } else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (policy.mediaType === 'application/json') JSON.parse(text);
    if (policy.mediaType === 'text/html' && !/<html[\s>]/i.test(text.slice(0, 4_096)))
      throw new Error('HTML snapshot required.');
    if (policy.mediaType !== 'text/html' && /msy_[A-Za-z0-9_-]+/.test(text))
      throw new Error('Credential-shaped evidence refused.');
  }
}

function assertEvidenceAuthority(
  prepared: MeshyPreparedEvidence,
  state: MeshyRunState,
  spec: MeshyGenerationSpec,
  now: Date,
): void {
  const today = now.toISOString().slice(0, 10);
  if (
    prepared.approvalSha256 !== meshyRunApprovalIdentity(state.approval) ||
    prepared.specSha256 !== meshySpecIdentity(spec) ||
    state.approval.specSha256 !== prepared.specSha256 ||
    prepared.artifacts.consent.sha256 !== state.approval.evidence.confirmationSha256 ||
    Date.parse(prepared.review.reviewedAt) > now.getTime() ||
    prepared.review.paidPeriodStart > today ||
    prepared.review.paidPeriodEndExclusive <= today
  )
    throw new Error('Evidence authority or paid period mismatch.');
}

function assertAuthoringLinks(bytes: Buffer, artifacts: MeshyPreparedEvidence['artifacts']): void {
  const record = z
    .object({
      format: z.literal('tailfin-private-reference-review'),
      formatVersion: z.literal(1),
      authoring: z.object({ thirdPartyImageInputs: z.literal(false), modelVersion: z.null() }),
      versions: z
        .array(
          z.object({
            sha256: MeshySha256,
            promptSha256: MeshySha256,
            inputImageSha256: MeshySha256.nullable(),
          }),
        )
        .length(2),
    })
    .parse(JSON.parse(bytes.toString('utf8')) as unknown);
  const current = record.versions.find(
    (version) => version.sha256 === artifacts.referenceImage.sha256,
  );
  const parent = record.versions.find((version) => version.sha256 === artifacts.parentImage.sha256);
  if (
    !current ||
    !parent ||
    current === parent ||
    current.promptSha256 !== artifacts.referencePrompt.sha256 ||
    current.inputImageSha256 !== parent.sha256 ||
    parent.promptSha256 !== artifacts.parentPrompt.sha256 ||
    parent.inputImageSha256 !== null
  )
    throw new Error('Authoring chain mismatch.');
}

/** No network. The fixed prepared record cannot be replaced, including before the first submission. */
export async function prepareMeshyEvidence(
  root: string,
  input: unknown,
  state: MeshyRunState,
  spec: MeshyGenerationSpec,
  now = new Date(),
) {
  if (state.requests.length) throw new Error('Cannot prepare evidence after a reservation.');
  const parsed = Import.parse(input);
  const artifacts = {} as MeshyPreparedEvidence['artifacts'];
  const contents = new Map<Role, Buffer>();
  for (const role of roleNames) {
    const bytes = readMeshyArtifact(parsed.files[role], roles[role].limit);
    await validateArtifact(role, bytes);
    artifacts[role] = {
      sha256: sha256(bytes),
      bytes: bytes.length,
      mediaType: roles[role].mediaType,
    };
    contents.set(role, bytes);
  }
  const prepared = Prepared.parse({
    format: 'tailfin-meshy-prepared-evidence',
    formatVersion: 1,
    approvalSha256: meshyRunApprovalIdentity(state.approval),
    specSha256: meshySpecIdentity(spec),
    review: parsed.review,
    artifacts,
  });
  assertEvidenceAuthority(prepared, state, spec, now);
  assertAuthoringLinks(contents.get('authoringRecord')!, artifacts);
  for (const bytes of contents.values()) storeMeshyEvidenceBytes(root, bytes);
  const bytes = Buffer.from(canonicalJson(prepared));
  const digest = storeMeshyEvidenceBytes(root, bytes);
  writeImmutableMeshyArtifact(join(root, 'prepared.json'), bytes);
  return {
    preparedSha256: digest,
    referenceSha256: artifacts.referenceImage.sha256,
    productionPublicationApproved: false,
  };
}

/** Reverify every referenced byte; a descriptor alone is not evidence. Never return billing bytes. */
export async function loadPreparedMeshyEvidence(
  root: string,
  state: MeshyRunState,
  spec: MeshyGenerationSpec,
  now = new Date(),
) {
  const preparedBytes = readMeshyArtifact(join(root, 'prepared.json'), 32_768);
  const prepared = Prepared.parse(JSON.parse(preparedBytes.toString('utf8')) as unknown);
  if (preparedBytes.toString('utf8') !== canonicalJson(prepared))
    throw new Error('Noncanonical prepared record.');
  assertEvidenceAuthority(prepared, state, spec, now);
  let referenceImage: Buffer = Buffer.alloc(0);
  for (const role of roleNames) {
    const descriptor = prepared.artifacts[role];
    if (descriptor.mediaType !== roles[role].mediaType) throw new Error('Artifact role changed.');
    const bytes = loadMeshyEvidenceBytes(root, descriptor.sha256, roles[role].limit);
    if (bytes.length !== descriptor.bytes) throw new Error('Artifact size changed.');
    await validateArtifact(role, bytes);
    if (role === 'referenceImage') referenceImage = bytes;
  }
  const preparedSha256 = sha256(preparedBytes);
  assertAuthoringLinks(
    loadMeshyEvidenceBytes(
      root,
      prepared.artifacts.authoringRecord.sha256,
      roles.authoringRecord.limit,
    ),
    prepared.artifacts,
  );
  loadMeshyEvidenceBytes(root, preparedSha256, 32_768);
  return { prepared, preparedSha256, referenceImage };
}

/** A recent operator observation, NOT a provider-enforced price quote. */
export function assertMeshyPricingFresh(
  review: z.infer<typeof MeshyPricingReview>,
  now: Date,
): void {
  const age = now.getTime() - Date.parse(review.reviewedAt);
  if (age < 0 || age > 60 * 60 * 1000) throw new Error('Pricing review expired or future-dated.');
}
export function importMeshyPricingReview(root: string, input: unknown, now: Date) {
  const parsed = PricingImport.parse(input);
  const { snapshotFile, ...fields } = parsed;
  const review = MeshyPricingReview.parse(fields);
  assertMeshyPricingFresh(review, now);
  const bytes = readMeshyArtifact(snapshotFile, 2 * 1024 * 1024);
  if (
    bytes.length !== review.snapshot.bytes ||
    sha256(bytes) !== review.snapshot.sha256 ||
    !/<html[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8'))
  )
    throw new Error('Pricing snapshot mismatch.');
  storeMeshyEvidenceBytes(root, bytes);
  const pricingReviewSha256 = storeMeshyEvidenceBytes(root, Buffer.from(canonicalJson(review)));
  return { review, pricingReviewSha256 };
}

/** Historical pricing remains verifiable after its live-submit freshness window expires. */
export function loadMeshyPricingReview(root: string, digest: string) {
  const review = MeshyPricingReview.parse(loadMeshyEvidenceJson(root, digest));
  const snapshot = loadMeshyEvidenceBytes(root, review.snapshot.sha256, 2 * 1024 * 1024);
  if (snapshot.length !== review.snapshot.bytes) throw new Error('Pricing snapshot size changed.');
  return review;
}
