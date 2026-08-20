import type {
  ApiError,
  OwnAirlineResponse,
  UpdateOwnAirlineInput,
  UpdateOwnAirlineResponse,
} from '@tailfin/shared';

export interface OwnAirlineFailure extends ApiError {
  status: number;
}

function isOwnAirlineResponse(value: unknown): value is OwnAirlineResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return 'airline' in body && 'rebrand' in body;
}

/** Read the signed-in player's private airline projection; absence is normal. */
export async function fetchOwnAirline(): Promise<OwnAirlineResponse> {
  const response = await fetch('/api/airlines/me', {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body as Partial<ApiError>;
    throw new Error(error.message ?? `GET /api/airlines/me failed with ${String(response.status)}`);
  }
  if (!isOwnAirlineResponse(body)) {
    throw new Error('GET /api/airlines/me returned an unexpected body');
  }
  return body;
}

export type UpdateOwnAirlineOutcome =
  { ok: true; result: UpdateOwnAirlineResponse } | { ok: false; refusal: OwnAirlineFailure };

/** Expected identity/context refusals remain data so the form can place them by each field. */
export async function patchOwnAirline(
  input: UpdateOwnAirlineInput,
): Promise<UpdateOwnAirlineOutcome> {
  const response = await fetch('/api/airlines/me', {
    method: 'PATCH',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  });
  const body: unknown = await response.json();
  if (response.status === 200) {
    return { ok: true, result: body as UpdateOwnAirlineResponse };
  }
  if (response.status === 400 || response.status === 409 || response.status === 422) {
    const refusal = body as Partial<ApiError>;
    if (typeof refusal.code === 'string' && typeof refusal.message === 'string') {
      return {
        ok: false,
        refusal: {
          ...refusal,
          code: refusal.code,
          message: refusal.message,
          status: response.status,
        },
      };
    }
  }
  throw new Error(`PATCH /api/airlines/me failed with ${String(response.status)}`);
}

/** Display only; the wire and every calculation remain integer minor units. */
export function formatMinorUnits(minor: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}
