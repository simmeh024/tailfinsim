import { useEffect, useState } from 'react';

import { aircraftVisual } from './aircraft-visuals';

import type { ReactNode } from 'react';

/**
 * One visual contract for type cards and detail views.
 *
 * The source may later be a neutral render, M6 livery or VIS scene. Failure is
 * deliberately local: the type name remains visible and every acquisition
 * control stays usable.
 */
export function AircraftImage({
  designation,
  manufacturer,
  priority = false,
  className = '',
}: {
  designation: string;
  manufacturer: string;
  priority?: boolean;
  className?: string;
}): ReactNode {
  const asset = aircraftVisual(designation);
  const [failed, setFailed] = useState(asset === null);

  useEffect(() => {
    setFailed(asset === null);
  }, [asset]);

  const label = `${manufacturer} ${designation} in a neutral white catalogue finish`;
  if (asset === null || failed) {
    return (
      <span
        className={`aircraft-visual aircraft-visual--fallback ${className}`}
        role="img"
        aria-label={`${label}; image unavailable`}
      >
        <span aria-hidden="true">✈</span>
        <small>{designation}</small>
      </span>
    );
  }

  return (
    <img
      className={`aircraft-visual ${className}`}
      src={asset.src}
      srcSet={asset.srcSet}
      sizes="(max-width: 48rem) 92vw, (max-width: 80rem) 44vw, 24vw"
      width={asset.width}
      height={asset.height}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding="async"
      alt={label}
      onError={() => {
        setFailed(true);
      }}
    />
  );
}
