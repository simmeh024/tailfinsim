import type {
  ApiError,
  ResearchNodeId,
  ResearchRefusal,
  ResearchResponse,
  SetDoctrineFundingInput,
  StartResearchInput,
} from '@tailfin/shared';

import { isResearchRefusal } from './research-presentation';

/**
 * The research tree's half of the client API (M9-05 and M9-06, §10.3, §10.4).
 *
 * Types only from `@tailfin/shared`, as everywhere else in the client: nothing
 * here decides which node may start, what it costs or how many points the
 * airline has. The server answers all three, and `startRefusal` on every node is
 * its verdict on the button rather than one this module reconstructs.
 *
 * Both mutations return the **whole** research state, for the reason every
 * crew and academy write does: starting a project spends points and cash and
 * changes the status of the node, of every other available node (one project at
 * a time) and of the active slot at once; a funding change moves a doctrine's
 * strength and with it the efficiency readout. A client that patched its own
 * copy would be recomputing the server's answer.
 */

export interface ResearchFailure {
  status: number;
  /** The stable code — a {@link ResearchRefusal} when the server refused, otherwise whatever it sent. */
  code: string;
  /** The research refusal, when `code` is one. Null for anything else (validation, no airline). */
  refusal: ResearchRefusal | null;
  /** The server's sentence, kept for the case `refusal` is null. */
  message: string;
}

export type ResearchOutcome =
  { ok: true; state: ResearchResponse } | { ok: false; failure: ResearchFailure };

/**
 * Is this actually a research payload?
 *
 * The shape check `fetchCrew` does, and for the same reason: a `200` carrying
 * the wrong body would reach the page as `undefined` two property accesses later
 * and crash the render rather than fail the fetch. The shell's routing test
 * stubs every unrecognised URL with `{}`, which is exactly that body.
 */
export function isResearchResponse(value: unknown): value is ResearchResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.points === 'object' &&
    body.points !== null &&
    typeof body.formula === 'object' &&
    body.formula !== null &&
    typeof body.academy === 'object' &&
    body.academy !== null &&
    Array.isArray(body.branches) &&
    Array.isArray(body.efficiency) &&
    typeof body.crewXp === 'object' &&
    body.crewXp !== null &&
    typeof body.gameNow === 'string'
  );
}

/**
 * Read the airline's research.
 *
 * `null` for a player with no airline in this world — the endpoint answers 409
 * then, as every "my airline" read does — which the page renders as an ordinary
 * empty state rather than as a failure.
 */
export async function fetchResearch(): Promise<ResearchResponse | null> {
  const response = await fetch('/api/research', {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (response.status === 401 || response.status === 409) return null;
  if (!response.ok) throw new Error(`GET /api/research failed with ${String(response.status)}`);
  const body: unknown = await response.json();
  if (!isResearchResponse(body)) throw new Error('GET /api/research returned an unexpected body');
  return body;
}

/** A write's answer: the whole new state, or the failure with its stable code. */
type SendResult =
  | { ok: true; state: ResearchResponse }
  | { ok: false; status: number; code: string; message: string };

/**
 * One research write.
 *
 * The code is read from `code`, the field every endpoint's `ApiError` uses
 * (`academy/routes.ts` sends `{ code: <refusal>, message }`). A body that names
 * it `refusal` instead is read too, so the page and the server cannot disagree
 * about one field's name and turn every refusal into "unknown".
 */
async function send(method: 'POST' | 'PUT', path: string, input: unknown): Promise<SendResult> {
  const response = await fetch(path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  });

  // A body that is not JSON (a proxy's error page) is a failure with no code, not a crash.
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 200 && isResearchResponse(payload)) return { ok: true, state: payload };

  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Partial<
    ApiError & { refusal: unknown }
  >;
  return {
    ok: false,
    status: response.status,
    code:
      typeof body.code === 'string'
        ? body.code
        : typeof body.refusal === 'string'
          ? body.refusal
          : 'unknown',
    message:
      typeof body.message === 'string'
        ? body.message
        : `${method} ${path} failed with ${String(response.status)}`,
  };
}

/**
 * Start researching one node.
 *
 * A refusal is data, not an exception: `ResearchRefusal` is a closed set
 * precisely so the page can say *why* beside the node it is about.
 */
export async function startResearch(input: StartResearchInput): Promise<ResearchOutcome> {
  const result = await send('POST', '/api/research/projects', input);
  if (result.ok) return result;
  return {
    ok: false,
    failure: {
      status: result.status,
      code: result.code,
      refusal: isResearchRefusal(result.code) ? result.code : null,
      message: result.message,
    },
  };
}

export interface FundingFailure {
  status: number;
  /** `not_complete` (409) while the node is still being researched; anything else is unexpected. */
  code: string;
  message: string;
}

export type FundingOutcome =
  { ok: true; state: ResearchResponse } | { ok: false; failure: FundingFailure };

/**
 * Fund a completed node's doctrine, or stop (M9-06, §10.4's third rule).
 *
 * `PUT` with a level rather than a toggle, so two tabs that both stop funding
 * leave it stopped instead of flipping it back. Answers with the whole state,
 * because a funding change moves the node's strength, its upkeep and the
 * efficiency readout at once.
 */
export async function setDoctrineFunding(
  nodeId: ResearchNodeId,
  input: SetDoctrineFundingInput,
): Promise<FundingOutcome> {
  const result = await send(
    'PUT',
    `/api/research/projects/${encodeURIComponent(nodeId)}/funding`,
    input,
  );
  if (result.ok) return result;
  return {
    ok: false,
    failure: { status: result.status, code: result.code, message: result.message },
  };
}
