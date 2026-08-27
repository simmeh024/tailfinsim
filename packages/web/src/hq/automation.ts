import type {
  AutomationStateResponse,
  AutomationSystem,
  SetAutomationRequest,
} from '@tailfin/shared';

/**
 * The Headquarters policies modal's half of the client API (M5-05).
 *
 * Types only, as everywhere in the client. The server owns which modes are
 * legal, what a policy means and which situations are waiting; this asks and
 * shows. `PUT` returns the whole state back, like the office API, so the modal
 * never patches its own copy.
 */

/** The automation state, or null for a player with no airline (401/409). Never throws. */
export async function fetchAutomation(): Promise<AutomationStateResponse | null> {
  let response: Response;
  try {
    response = await fetch('/api/automation', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return (await response.json()) as AutomationStateResponse;
}

export type AutomationOutcome =
  { ok: true; state: AutomationStateResponse } | { ok: false; message: string };

/** Set the mode and policy for one system; the server returns the whole state. */
export async function setAutomation(
  system: AutomationSystem,
  request: SetAutomationRequest,
): Promise<AutomationOutcome> {
  const response = await fetch(`/api/automation/${system}`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(request),
  });
  if (response.status === 200) {
    return { ok: true, state: (await response.json()) as AutomationStateResponse };
  }
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  return { ok: false, message: body.message ?? `Could not save (${String(response.status)})` };
}
