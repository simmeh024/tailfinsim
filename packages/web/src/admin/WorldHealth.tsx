import { useEffect, useRef, useState } from 'react';

import type { AdminTickState, AdminWorldHealth } from '@tailfin/shared';

import { StateBlock } from '../ui/StateBlock';

import { fetchWorldHealth } from './api';
import { adminAtSeconds, adminDate } from './format';
import { usePolledData } from './polling';

import type { ReactNode } from 'react';

/**
 * Is this world actually running? (M1A-06, design doc §21)
 *
 * ## One request, ticked locally
 *
 * The page refreshes every ten seconds and asks for everything in one request.
 * Between refreshes the in-game clock is advanced **locally** at the world's own
 * speed, anchored to the server's `serverTime` — the build badge's pattern, and
 * the reason the issue asks for it: a clock that needs a request per second is a
 * clock that gets switched off.
 *
 * ## The backlog is a trend, not a number
 *
 * Each refresh appends to a short in-memory series per world, drawn as a
 * sparkline. A depth of 40 means nothing on its own; 40 after 5, 12, 26 means
 * the loop is losing. The series lives in the component and starts empty on
 * reload — persisted history is a metrics problem (OPS-15/#194, M11-07), and
 * inventing a table for it here would be the wrong size of solution.
 */

const REFRESH_MS = 10_000;
/** Enough samples to see a slope at ten seconds each — two minutes of history. */
const SERIES_LENGTH = 12;

/** How each state should read, and how loudly. */
const TICK_LABEL: Record<AdminTickState, string> = {
  no_events: 'Nothing scheduled',
  idle: 'Idle',
  keeping_up: 'Keeping up',
  behind: 'Behind',
  stalled: 'Stalled',
};

const TICK_TONE: Record<AdminTickState, 'ok' | 'warn' | 'bad' | 'quiet'> = {
  no_events: 'quiet',
  idle: 'quiet',
  keeping_up: 'ok',
  behind: 'warn',
  stalled: 'bad',
};

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d`;
}

/**
 * A queue depth over time, as a shape rather than a figure.
 *
 * Deliberately tiny and unlabelled: it answers "is this going up?" and nothing
 * else. The number beside it is the reading; this is the direction.
 */
function Sparkline({ series }: { series: number[] }): ReactNode {
  if (series.length < 2) {
    return <span className="health__spark health__spark--empty">collecting…</span>;
  }

  const peak = Math.max(...series, 1);
  const width = 60;
  const height = 16;
  const step = width / (series.length - 1);
  const points = series
    .map((value, index) => {
      const x = index * step;
      const y = height - (value / peak) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const rising = (series.at(-1) ?? 0) > (series[0] ?? 0);

  return (
    <svg
      className={rising ? 'health__spark health__spark--rising' : 'health__spark'}
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      role="img"
      aria-label={
        rising
          ? `Queue depth rising, ${String(series.at(-1) ?? 0)} now, ${String(series[0] ?? 0)} ${String(Math.round((series.length * REFRESH_MS) / 1000))} seconds ago`
          : `Queue depth steady or falling, ${String(series.at(-1) ?? 0)} now`
      }
    >
      <polyline points={points} fill="none" strokeWidth="1.5" />
    </svg>
  );
}

function Row({ world, series }: { world: AdminWorldHealth; series: number[] }): ReactNode {
  const tone = TICK_TONE[world.tick];

  return (
    <div className={`health health--${tone}`}>
      <div className="health__head">
        <span className="health__name">{world.name}</span>
        <span className={`health__state health__state--${tone}`}>{TICK_LABEL[world.tick]}</span>
        <span className="health__status">{world.status}</span>
      </div>

      <p className="health__detail">{world.tickDetail}</p>

      <dl className="health__facts">
        <div>
          <dt>In-game</dt>
          <dd className="figure">{adminAtSeconds(world.inGameDate)}</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd className="figure">{world.speedMultiplier.toFixed(2)}×</dd>
        </div>
        <div>
          <dt>Running for</dt>
          <dd className="figure">{formatDuration(world.realAgeMs)}</dd>
        </div>
        <div>
          <dt>Airlines</dt>
          <dd className="figure">{world.airlines}</dd>
        </div>
        <div>
          <dt>Queue</dt>
          <dd className="figure health__queue">
            {world.queue.pending}
            <Sparkline series={series} />
          </dd>
        </div>
        <div>
          <dt>Oldest due</dt>
          <dd className="figure">
            {world.queue.overdueRealMs === null
              ? '—'
              : `${formatDuration(world.queue.overdueRealMs)} late`}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function WorldHealth(): ReactNode {
  // Shares the console's polling behaviour rather than repeating it: keeps the
  // last good answer on a failed refresh, and does not poll a hidden tab.
  const health = usePolledData(fetchWorldHealth, REFRESH_MS);
  const report = health.value;
  const failed = health.failed;
  const fetchedAt = health.lastLoadedAt;

  const [, setFrame] = useState(0);
  const series = useRef(new Map<string, number[]>());

  // One sample per successful load. `value` is a fresh object each time, so this
  // fires once per refresh and never on a re-render.
  useEffect(() => {
    if (report === null) return;
    for (const entry of report.worlds) {
      const existing = series.current.get(entry.worldId) ?? [];
      series.current.set(entry.worldId, [...existing, entry.queue.pending].slice(-SERIES_LENGTH));
    }
  }, [report]);

  useEffect(() => {
    // Re-renders only; it makes no request. This is what lets the in-game clock
    // move without asking the server what time it is.
    const tick = setInterval(() => {
      setFrame((n) => n + 1);
    }, 1000);
    return () => {
      clearInterval(tick);
    };
  }, []);

  if (failed && report === null) {
    return (
      <section className="admin__section">
        <h2 className="admin__heading">Health</h2>
        <StateBlock kind="broken">Could not load world health.</StateBlock>
      </section>
    );
  }

  if (report === null) {
    return (
      <section className="admin__section">
        <h2 className="admin__heading">Health</h2>
        <StateBlock kind="loading">Loading…</StateBlock>
      </section>
    );
  }

  const elapsed = fetchedAt === null ? 0 : Date.now() - fetchedAt;

  return (
    <section className="admin__section">
      <h2 className="admin__heading">Health</h2>

      {report.worlds.length === 0 ? (
        <StateBlock kind="empty">No worlds yet.</StateBlock>
      ) : (
        <div className="health__list">
          {report.worlds.map((world) => (
            <Row
              key={world.worldId}
              // The in-game clock, advanced locally since the last refresh at
              // this world's own speed. The server remains the authority — every
              // refresh replaces this with its answer.
              world={{
                ...world,
                inGameDate: new Date(
                  Date.parse(world.inGameDate) + elapsed * world.speedMultiplier,
                ).toISOString(),
              }}
              series={series.current.get(world.worldId) ?? []}
            />
          ))}
        </div>
      )}

      <p className="admin__hint">
        Refreshed every {String(REFRESH_MS / 1000)} seconds; the in-game clock is advanced here
        between refreshes rather than asked for. A world is called <strong>behind</strong> once due
        work has waited {formatDuration(report.behindAfterMs)}.
      </p>
      <p className="admin__hint">
        Aircraft and airborne flights are not shown because neither exists yet — they arrive with M2
        and M4. A count of zero would describe a working simulation with nothing flying, which is
        not what is happening.
      </p>
      {failed && (
        <p className="admin__note" role="alert">
          The last refresh failed; the figures above are older than they look.
        </p>
      )}

      {report.datasets.length > 0 && (
        <>
          <h3 className="admin__heading">Data in use</h3>
          <table className="admin__table">
            <thead>
              <tr>
                <th scope="col">Dataset</th>
                <th scope="col">Version</th>
                <th scope="col">Imported</th>
              </tr>
            </thead>
            <tbody>
              {report.datasets.map((entry) => (
                <tr key={entry.dataset}>
                  <td>{entry.dataset}</td>
                  <td className="figure">{entry.version}</td>
                  <td className="figure">{adminDate(entry.importedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
