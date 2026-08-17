import { useEffect, useState } from 'react';

import type { VersionResponse } from '@tailfin/shared';

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
    typeof body.environment === 'string'
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

export function BuildBadge(): ReactNode {
  const version = useBuildInfo();
  if (!version) return null;

  return (
    <span
      className="build"
      // The commit is the part that answers "which diff is this?", but it is
      // noise 99% of the time, so it lives in the tooltip.
      title={`commit ${version.commit} · started ${version.startedAt}`}
      data-environment={version.environment}
    >
      <span className="build__env">{version.environment}</span>
      <span className="build__number figure">build {version.build}</span>
    </span>
  );
}
