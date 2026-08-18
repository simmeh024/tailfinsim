import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import type { VersionResponse } from '@tailfin/shared';

import { useSession } from '../auth/SessionProvider';

import type { ReactNode } from 'react';

/**
 * The build badge, bottom right (M0-12).
 *
 * Asks the **server** which build it is rather than baking the number into this
 * bundle. A cached client reporting its own build number would say what the
 * browser last downloaded, not what it is talking to — which is exactly the case
 * where you need the truth.
 *
 * Renders nothing at all until it has an answer, and nothing if the answer never
 * comes. A corner label is not worth a layout shift or an error message.
 */

function isVersion(value: unknown): value is VersionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.build === 'number' &&
    typeof body.commit === 'string' &&
    typeof body.environment === 'string' &&
    typeof body.serverTime === 'string'
  );
}

export function useBuildInfo(): VersionResponse | null {
  const [version, setVersion] = useState<VersionResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/api/version', { headers: { accept: 'application/json' } });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!cancelled && isVersion(body)) setVersion(body);
      } catch {
        // Silent: the badge is informational, and a failed fetch here is already
        // visible as the session going `unavailable`.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}

/**
 * The server's clock, ticking.
 *
 * Anchored to the server and advanced locally rather than polled every second:
 * one request establishes the offset between the two machines, and the browser's
 * own clock supplies the ticking. Polling `/api/version` at 1 Hz to render a
 * corner label would be a request per second per open tab for a decoration.
 *
 * The drift that remains is the drift between the two clocks over the life of a
 * page, which is seconds a day — irrelevant for a label, and the whole point is
 * that it starts from the *server's* idea of the time rather than the viewer's.
 */
function useServerClock(serverTimeIso: string | undefined): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  const offsetMs = useRef(0);

  useEffect(() => {
    if (serverTimeIso === undefined) return;

    const serverMs = Date.parse(serverTimeIso);
    if (Number.isNaN(serverMs)) return;
    offsetMs.current = serverMs - Date.now();

    const update = (): void => {
      setNow(new Date(Date.now() + offsetMs.current));
    };
    update();

    const timer = setInterval(update, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [serverTimeIso]);

  return now;
}

/**
 * `2026-08-18 04:15:07 UTC` — ISO-ish, always UTC.
 *
 * UTC and not the viewer's zone: the server runs UTC, every log line and every
 * scheduled event is stamped in it, and a badge showing local time would need
 * converting in your head before it could be compared to any of them.
 */
function formatServerTime(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export function BuildBadge(): ReactNode {
  const version = useBuildInfo();
  const serverNow = useServerClock(version?.serverTime);
  const { isAdmin } = useSession();
  if (!version) return null;

  return (
    <span
      className="build"
      // The commit is the part that answers "which diff is this?", but it is
      // noise 99% of the time, so it lives in the tooltip.
      title={`commit ${version.commit} · started ${version.startedAt}`}
      data-environment={version.environment}
    >
      {serverNow !== null && (
        <span className="build__clock figure">{formatServerTime(serverNow)}</span>
      )}
      {/*
        The way into the admin console (M1A-01), between the clock and the build
        label. Shown only to admins — but that is *tidiness, not security*. The
        console's data is protected by `requireAdmin` on every route it calls;
        hiding the link merely keeps a control nobody else can use out of
        everybody else's way.
      */}
      {isAdmin && (
        <Link className="build__admin" to="/admin">
          admin
        </Link>
      )}
      <span className="build__env">{version.environment}</span>
      <span className="build__number figure">build {version.build}</span>
    </span>
  );
}
