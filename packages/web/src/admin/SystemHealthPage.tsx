import type { AdminNodeHealth, AdminSystemHealthResponse, NodeState } from '@tailfin/shared';

import { fetchSystemHealth } from './api';
import { usePolledData } from './polling';

import type { ReactNode } from 'react';

/**
 * System Health — the machines, not the worlds (OPS-15).
 *
 * The overview answers "is anything wrong with the worlds". Since OPS-09 that is
 * no longer the whole question: the site can be perfectly healthy while the
 * simulation has quietly stopped, and nothing on the front page would look wrong.
 * Players would notice hours later, when nothing had moved.
 *
 * ## Where the numbers come from
 *
 * Not from asking the machines. The console runs in the web process and cannot
 * reach the worker at all — its health endpoint binds loopback on another host
 * whose firewall allows only SSH. Each node writes a heartbeat into the database
 * and this reads the table, so a node that stops writing shows as **stale**
 * rather than as a failed request. See `ops/heartbeat.ts`.
 *
 * ## Every judgement is the server's
 *
 * `state` and `detail` arrive decided. A browser with a skewed clock must not
 * reach a different conclusion about whether a node is stale than the server
 * does (§21), so this file renders words rather than computing them.
 */

/** Matches the heartbeat interval: a node that beats every 15s is stale at 45s. */
const REFRESH_MS = 15_000;

const STATE_LABEL: Record<NodeState, string> = {
  online: 'Online',
  stale: 'Stale',
  offline: 'Offline',
};

const ROLE_LABEL: Record<'web' | 'worker', string> = {
  web: 'Web',
  worker: 'Engine',
};

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  return `${String(Math.round(minutes / 60))}h ago`;
}

/**
 * A load bar that is also a number.
 *
 * The bar is `aria-hidden` and the figure beside it is the real content: a
 * coloured length is not a value a screen reader can read, and "67%" is (H.7).
 */
function LoadBar({ label, percent }: { label: string; percent: number }): ReactNode {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="node__meter">
      <span className="node__meter-label">{label}</span>
      <span
        aria-hidden="true"
        className="node__meter-track"
        data-level={clamped >= 90 ? 'high' : clamped >= 70 ? 'warn' : 'normal'}
      >
        <span className="node__meter-fill" style={{ width: `${String(clamped)}%` }} />
      </span>
      <span className="figure node__meter-value">{clamped.toFixed(1)}%</span>
    </div>
  );
}

function EngineDetail({ node }: { node: AdminNodeHealth }): ReactNode {
  const engine = node.engine;
  if (engine === null) return null;

  return (
    <dl className="node__stats">
      {/*
        Plain numbers, not `toLocaleString()`. The server's own `detail` sentence
        formats with `String(n)`, so a separator here would render the same tick
        count two different ways on one card — and the locale would decide which.
      */}
      <div>
        <dt>Ticks</dt>
        <dd className="figure">{engine.ticks}</dd>
      </div>
      <div>
        <dt>Errors</dt>
        <dd className="figure">{engine.errors}</dd>
      </div>
      <div>
        <dt>Late ticks</dt>
        <dd className="figure">{engine.lateTicks}</dd>
      </div>
      <div>
        <dt>Queue due</dt>
        <dd className="figure">{engine.queueDue}</dd>
      </div>
      <div>
        <dt>Processed</dt>
        <dd className="figure">{engine.processed}</dd>
      </div>
      <div>
        <dt>Failed</dt>
        <dd className="figure">{engine.failed}</dd>
      </div>
    </dl>
  );
}

function NodeCard({ node }: { node: AdminNodeHealth }): ReactNode {
  return (
    <article className="node" data-state={node.state} aria-labelledby={`node-${node.node}`}>
      <header className="node__head">
        <h3 className="node__name" id={`node-${node.node}`}>
          {ROLE_LABEL[node.role]} — {node.node}
        </h3>
        {/*
          The word, not only the colour. A status conveyed by colour alone is
          invisible in greyscale, in a screenshot and to a screen reader (H.7).
        */}
        <span className="node__state" data-state={node.state}>
          {STATE_LABEL[node.state]}
        </span>
      </header>

      {/* Decided on the server, rendered verbatim. */}
      <p className="node__detail">{node.detail}</p>

      <LoadBar label="CPU" percent={node.load.cpuPercent} />
      <LoadBar label="Memory" percent={node.load.memoryUsedPercent} />

      <dl className="node__stats">
        <div>
          <dt>Build</dt>
          <dd className="figure">
            {node.build} <span className="node__commit">{node.commit}</span>
          </dd>
        </div>
        <div>
          <dt>Uptime</dt>
          <dd className="figure">{formatUptime(node.uptimeSeconds)}</dd>
        </div>
        <div>
          <dt>Last heartbeat</dt>
          <dd className="figure">{formatAge(node.ageMs)}</dd>
        </div>
        <div>
          <dt>Process memory</dt>
          <dd className="figure">{formatBytes(node.load.processMemoryBytes)}</dd>
        </div>
        <div>
          <dt>Cores</dt>
          <dd className="figure">{node.load.cores}</dd>
        </div>
        <div>
          <dt>Load (1m)</dt>
          <dd className="figure">{node.load.loadAverage1m.toFixed(2)}</dd>
        </div>
      </dl>

      <EngineDetail node={node} />
    </article>
  );
}

export function SystemHealthPage(): ReactNode {
  const { value, loading, failed, refresh } = usePolledData<AdminSystemHealthResponse>(
    fetchSystemHealth,
    REFRESH_MS,
  );

  if (loading) {
    return (
      <section className="admin__section">
        <h2 className="admin__heading">System health</h2>
        <p className="admin__note">Loading…</p>
      </section>
    );
  }

  if (value === null) {
    return (
      <section className="admin__section">
        <h2 className="admin__heading">System health</h2>
        <p className="admin__note" role="alert">
          Could not load system health.
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="admin__section">
        <h2 className="admin__heading">System health</h2>

        {failed && (
          // The polling contract: keep the last good numbers and say they are
          // old, rather than blanking the page because one request failed.
          <p className="admin__note" role="alert">
            The last refresh failed; the figures below are older than they look.
          </p>
        )}

        {value.alerts.length > 0 && (
          <ul className="admin__errors" role="alert">
            {value.alerts.map((alert) => (
              <li key={alert}>{alert}</li>
            ))}
          </ul>
        )}

        {value.nodes.length === 0 ? (
          <p className="admin__note">
            No node has ever written a heartbeat to this database. Either nothing is running, or
            everything running predates the heartbeat.
          </p>
        ) : (
          <div className="node__list">
            {value.nodes.map((node) => (
              <NodeCard key={node.node} node={node} />
            ))}
          </div>
        )}

        <p className="admin__hint">
          Each node writes a heartbeat every {String(REFRESH_MS / 1000)} seconds; a node is called{' '}
          <strong>stale</strong> after {String(value.staleAfterMs / 1000)} seconds without one and{' '}
          <strong>offline</strong> after {String(value.offlineAfterMs / 1000)}. The console reads
          the table rather than contacting the machines — it cannot reach them, deliberately — so a
          node that stops reporting is detected rather than merely unreachable.
        </p>

        <button className="admin__submit" type="button" onClick={refresh}>
          Refresh now
        </button>
      </section>
    </>
  );
}
