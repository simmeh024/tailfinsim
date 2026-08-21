import type {
  AirlineCodeAvailabilityResponse,
  AirlineFoundingAirport,
  AirlineFoundingOptionsResponse,
  ApiError,
  CreateAirlineInput,
  CreateAirlineResponse,
} from '@tailfin/shared';

interface JsonResponse {
  status: number;
  body: unknown;
}

async function json(path: string, init?: RequestInit): Promise<JsonResponse> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
    credentials: 'same-origin',
  });
  return { status: response.status, body: await response.json() };
}

export async function fetchFoundingOptions(): Promise<AirlineFoundingOptionsResponse> {
  const { status, body } = await json('/api/airlines/founding-options');
  if (status !== 200) throw new Error(`Founding options failed with ${String(status)}`);
  const result = body as Partial<AirlineFoundingOptionsResponse>;
  if (!Array.isArray(result.memberships) || !Array.isArray(result.worlds)) {
    throw new Error('Founding options returned an unexpected body');
  }
  return result as AirlineFoundingOptionsResponse;
}

export async function searchFoundingAirports(
  query: string,
  signal?: AbortSignal,
): Promise<AirlineFoundingAirport[]> {
  const suffix = query.trim() === '' ? '' : `?q=${encodeURIComponent(query.trim())}`;
  const { status, body } = await json(`/api/airlines/founding-airports${suffix}`, { signal });
  if (status !== 200) throw new Error(`Founder-hub search failed with ${String(status)}`);
  const airports = (body as { airports?: unknown }).airports;
  if (!Array.isArray(airports)) throw new Error('Founder-hub search returned an unexpected body');
  return airports as AirlineFoundingAirport[];
}

export async function checkFoundingCodes(
  input: Pick<CreateAirlineInput, 'worldId' | 'name' | 'iataCode' | 'icaoCode'>,
): Promise<AirlineCodeAvailabilityResponse> {
  const { status, body } = await json('/api/airlines/code-availability', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (status !== 200) throw new Error(`Code availability failed with ${String(status)}`);
  return body as AirlineCodeAvailabilityResponse;
}

export interface FoundingFailure extends ApiError {
  alternatives?: string[];
  codeKind?: 'iata' | 'icao';
}

export type FoundAirlineOutcome =
  { ok: true; result: CreateAirlineResponse } | { ok: false; refusal: FoundingFailure };

/** Expected rule refusals stay as data so the form can put them beside the right control. */
export async function postAirline(input: CreateAirlineInput): Promise<FoundAirlineOutcome> {
  const { status, body } = await json('/api/airlines', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (status === 201) return { ok: true, result: body as CreateAirlineResponse };
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    const refusal = body as Partial<FoundingFailure>;
    if (typeof refusal.code === 'string' && typeof refusal.message === 'string') {
      return { ok: false, refusal: refusal as FoundingFailure };
    }
  }
  throw new Error(`Airline founding failed with ${String(status)}`);
}
