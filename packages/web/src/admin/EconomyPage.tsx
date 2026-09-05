import { useEffect, useState } from 'react';

import type {
  AdminEconomyConfigChange,
  AdminEconomyConfigListResponse,
  AdminEconomyConfigSummary,
  AdminWorldSummary,
} from '@tailfin/shared';

import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import {
  compareEconomyConfigs,
  fetchEconomyConfig,
  fetchEconomyConfigs,
  fetchWorlds,
  type EconomyRead,
} from './api';
import { adminAt } from './format';
import { WorldEconomyPin } from './WorldEconomyPin';

import type { ReactNode } from 'react';

/**
 * The economy, as versions rather than as numbers (M11-37, design doc §22.3).
 *
 * ## Why this page exists
 *
 * Every balance figure in the game — App. A's coefficients, the gravity model,
 * the cost tables, fuel, boost ceilings — is one `EconomyConfig` payload stored
 * as an immutable row, and each world pins one by version. That has been true
 * since M3-11 and has been invisible from the console ever since: the version a
 * world runs was a string on the Worlds page and nothing could say what it
 * *meant*. Answering "why is this world pricing differently from that one?"
 * meant a psql session.
 *
 * So the page is built around the three questions that actually get asked:
 *
 * 1. **What versions exist, and who is on them?** The table below. A version on
 *    zero worlds is safe to ignore; a version on every world is the economy.
 * 2. **What differs between two of them?** Any two, not just parent and child —
 *    a promotion compares what a world is running against what it is about to
 *    run, and those are usually cousins rather than neighbours.
 * 3. **Can I move a world onto one?** With the difference stated first, because
 *    an admin agreeing to "v3" is agreeing to a name, and an admin agreeing to
 *    "fuel goes up 8% and the leisure price coefficient moves" is agreeing to a
 *    change.
 *
 * ## What it deliberately does not do
 *
 * **Create a version.** That is M11-03, and it is a bigger thing than it looks:
 * a payload has to be authored, validated against `EconomyConfig` and checksummed,
 * and an editor that gets that subtly wrong writes an immutable row. Until then
 * a retune arrives through the API, and this page is where it is reviewed and
 * promoted.
 *
 * **Hide what your role cannot do.** There is no client capability model until
 * M11-15, so the pin control is shown to everyone who can read this page and the
 * refusal arrives from the server. That is the honest arrangement rather than a
 * gap — the server is the boundary either way, and a hidden button would only
 * change *when* an admin learns what they lack.
 */

/**
 * A checksum, shortened for a table.
 *
 * Twelve characters, which is enough to tell two versions apart by eye and not
 * enough to be mistaken for the thing you would verify with. The full value is
 * in the payload view.
 */
function shortChecksum(checksum: string): string {
  return checksum.slice(0, 12);
}

/**
 * One side of a change, as text.
 *
 * `undefined` and `null` mean different things and are worth distinguishing: an
 * absent side means the field did not exist in that version, a null means it
 * existed and was null. Rendering both as an em dash would merge "this section
 * is new" with "this number was cleared".
 */
function changeSide(value: AdminEconomyConfigChange['before']): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  return String(value);
}

/** Whether a change is an addition, a removal, or a value moving. */
function changeKind(change: AdminEconomyConfigChange): string {
  if (change.before === undefined) return 'added';
  if (change.after === undefined) return 'removed';
  return 'changed';
}

function ChangeTable({
  changes,
  caption,
}: {
  changes: AdminEconomyConfigChange[];
  caption: string;
}): ReactNode {
  if (changes.length === 0) {
    return (
      <StateBlock kind="empty">
        Nothing differs. The two versions hold identical payloads, which is possible — a version can
        be created to record a decision rather than to change a number.
      </StateBlock>
    );
  }

  return (
    <table className="admin__table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Was</th>
          <th scope="col">Is</th>
          <th scope="col">Kind</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => (
          <tr key={change.path}>
            {/* Dotted with bracketed indices, exactly as the server writes it,
                so a path read here can be searched for in the payload. */}
            <td className="figure">{change.path}</td>
            <td className="figure">{changeSide(change.before)}</td>
            <td className="figure">{changeSide(change.after)}</td>
            <td>{changeKind(change)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The stored-versus-shipped fact, stated whichever way it falls.
 *
 * Said out loud in both directions on purpose. "They match" is worth a line
 * because the absence of a warning is not evidence that anything was checked,
 * and this is the check CLAUDE.md's rule about the web node never updating the
 * seed exists to make visible.
 */
function ShippedFact({ list }: { list: AdminEconomyConfigListResponse }): ReactNode {
  if (list.shippedMatchesStored) {
    return (
      <p className="admin__note">
        The <strong>{list.shippedVersion}</strong> row in this database is byte-for-byte the one
        this build ships.
      </p>
    );
  }

  return (
    <div className="alert alert--warning" role="status">
      <span className="alert__glyph" aria-hidden="true">
        ⚠
      </span>
      <div className="alert__body">
        <span className="alert__message">
          The stored <strong>{list.shippedVersion}</strong> does not match the one this build ships.
        </span>
        <span className="alert__detail">
          Its checksum differs, so the payload was written by a different build. This is not an
          error and needs no repair: the database wins by design, and startup deliberately leaves
          the stored version in force so that a deploy cannot revert a live retune. It is worth
          knowing because the numbers this build was tested against are not the numbers these worlds
          are running.
        </span>
      </div>
    </div>
  );
}

/** A version's payload and its diff from its parent, fetched when it is opened. */
function VersionDetail({ version }: { version: string }): ReactNode {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'refused' }
    | { kind: 'gone' }
    | { kind: 'broken' }
    | {
        kind: 'ready';
        payloadJson: string;
        comparedWith: string | null;
        diff: AdminEconomyConfigChange[] | null;
        checksum: string;
      }
  >({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    void fetchEconomyConfig(version)
      .then((result) => {
        if (!live) return;
        if (result === null) {
          setState({ kind: 'gone' });
          return;
        }
        if (!result.ok) {
          setState({ kind: 'refused' });
          return;
        }
        setState({
          kind: 'ready',
          payloadJson: result.value.payloadJson,
          comparedWith: result.value.comparedWith,
          diff: result.value.diff,
          checksum: result.value.summary.checksum,
        });
      })
      .catch(() => {
        if (live) setState({ kind: 'broken' });
      });
    return () => {
      live = false;
    };
  }, [version]);

  if (state.kind === 'loading') return <StateBlock kind="loading">Loading {version}…</StateBlock>;
  if (state.kind === 'refused') {
    return <StateBlock kind="refused">This account cannot read economy versions.</StateBlock>;
  }
  if (state.kind === 'gone') {
    return <StateBlock kind="empty">There is no version named {version} any more.</StateBlock>;
  }
  if (state.kind === 'broken') {
    return <StateBlock kind="broken">The payload could not be loaded.</StateBlock>;
  }

  return (
    <div className="admin__column">
      <p className="admin__hint">
        Checksum <span className="figure">{state.checksum}</span>, taken over the canonical payload
        below. The bytes are shown exactly as they are stored, so this is the thing the checksum is
        of rather than a re-rendering of it.
      </p>

      {state.diff === null ? (
        <p className="admin__note">
          Nothing to diff against: {version} has no parent, which makes it the seed.
        </p>
      ) : (
        <ChangeTable
          changes={state.diff}
          caption={`What ${version} changed from ${state.comparedWith ?? 'its parent'}.`}
        />
      )}

      <details>
        <summary>Payload</summary>
        <pre className="figure">{state.payloadJson}</pre>
      </details>
    </div>
  );
}

/** Any two versions, side by side. The question a promotion asks. */
function ComparePanel({ versions }: { versions: AdminEconomyConfigSummary[] }): ReactNode {
  // Newest against the one before it, because that is the comparison somebody
  // arriving on this page most often wants and it costs them no clicks.
  const [from, setFrom] = useState(versions[1]?.version ?? versions[0]?.version ?? '');
  const [to, setTo] = useState(versions[0]?.version ?? '');
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'refused' }
    | { kind: 'gone' }
    | {
        kind: 'broken';
      }
    | { kind: 'ready'; changes: AdminEconomyConfigChange[]; from: string; to: string }
  >({ kind: 'idle' });

  async function compare(): Promise<void> {
    setState({ kind: 'loading' });
    try {
      const result = await compareEconomyConfigs(to, from);
      if (result === null) {
        setState({ kind: 'gone' });
        return;
      }
      setState(
        result.ok
          ? {
              kind: 'ready',
              changes: result.value.changes,
              from: result.value.from,
              to: result.value.to,
            }
          : { kind: 'refused' },
      );
    } catch {
      setState({ kind: 'broken' });
    }
  }

  return (
    <section className="admin__section">
      <h2 className="admin__heading">Compare</h2>
      <p className="admin__note">
        Any two versions, not only a version and its parent. What a promotion needs to know is how
        the version a world is running differs from the one it is about to run, and those are
        usually not parent and child.
      </p>

      <div className="admin__form">
        <div className="admin__field">
          <label className="admin__label" htmlFor="economy-compare-from">
            From
          </label>
          <select
            className="admin__input"
            id="economy-compare-from"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setState({ kind: 'idle' });
            }}
          >
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                {v.version}
              </option>
            ))}
          </select>
        </div>

        <div className="admin__field">
          <label className="admin__label" htmlFor="economy-compare-to">
            To
          </label>
          <select
            className="admin__input"
            id="economy-compare-to"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setState({ kind: 'idle' });
            }}
          >
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                {v.version}
              </option>
            ))}
          </select>
        </div>

        <Button
          variant="secondary"
          disabled={from === '' || to === ''}
          onClick={() => void compare()}
        >
          Compare
        </Button>
      </div>

      {state.kind === 'loading' && <StateBlock kind="loading">Comparing…</StateBlock>}
      {state.kind === 'refused' && (
        <StateBlock kind="refused">This account cannot read economy versions.</StateBlock>
      )}
      {state.kind === 'gone' && (
        <StateBlock kind="empty">
          One of those versions is no longer there. Reload the page for the current list.
        </StateBlock>
      )}
      {state.kind === 'broken' && <StateBlock kind="broken">The comparison failed.</StateBlock>}
      {state.kind === 'ready' && (
        <ChangeTable
          changes={state.changes}
          caption={`${String(state.changes.length)} field${state.changes.length === 1 ? '' : 's'} differ between ${state.from} and ${state.to}.`}
        />
      )}
    </section>
  );
}

export function EconomyPage(): ReactNode {
  const [list, setList] = useState<EconomyRead<AdminEconomyConfigListResponse> | null>(null);
  const [broken, setBroken] = useState(false);
  const [worlds, setWorlds] = useState<AdminWorldSummary[] | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  /**
   * Both reads together, always.
   *
   * The versions table carries a "worlds pinned" count and the worlds table
   * carries a version, so refreshing one without the other puts two numbers on
   * screen that contradict each other — which is worse than both being a moment
   * old. A pin changes both, so a pin reloads both.
   */
  async function load(): Promise<void> {
    try {
      const [versions, worldList] = await Promise.all([
        fetchEconomyConfigs(),
        // Listing worlds needs `world.read`, a different capability. A role with
        // `economy.read` alone still gets the version list and the comparison,
        // and simply has nothing to pin — rather than a page that fails to load.
        fetchWorlds().catch(() => [] as AdminWorldSummary[]),
      ]);
      setList(versions);
      setWorlds(worldList);
      setBroken(false);
    } catch {
      setBroken(true);
    }
  }

  useEffect(() => {
    // Once, on mount. `load` is a fresh closure every render, so depending on
    // it would fetch in a loop; the page reloads when a pin says it should.
    void load();
  }, []);

  if (broken) {
    return (
      <section className="admin__section">
        <h1 className="admin__title">Economy</h1>
        <StateBlock kind="broken">The economy versions could not be loaded.</StateBlock>
      </section>
    );
  }

  if (list === null) {
    return (
      <section className="admin__section">
        <h1 className="admin__title">Economy</h1>
        <StateBlock kind="loading">Loading…</StateBlock>
      </section>
    );
  }

  if (!list.ok) {
    return (
      <section className="admin__section">
        <h1 className="admin__title">Economy</h1>
        <StateBlock kind="refused">
          This account holds an admin grant but its role does not carry <code>economy.read</code>.
          Someone who can change roles can grant it.
        </StateBlock>
      </section>
    );
  }

  const versions = list.value.versions;
  const byVersion = new Map(versions.map((v) => [v.version, v]));

  return (
    <>
      <section className="admin__section">
        <h1 className="admin__title">Economy</h1>
        <p className="admin__note">
          Every balance number in the game is one payload, stored as an immutable row and pinned per
          world. Retuning is an insert and a re-pin, never an edit — which is what keeps an old{' '}
          <code>flight_result</code> explicable by the numbers it was actually billed under.
        </p>
        <ShippedFact list={list.value} />

        {versions.length === 0 ? (
          <StateBlock kind="empty">
            This database holds no economy versions at all, which should be impossible — the web
            node seeds the shipped payload at startup.
          </StateBlock>
        ) : (
          <table className="admin__table">
            <caption>Newest first. A version on no worlds affects nothing.</caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Worlds</th>
                <th scope="col">From</th>
                <th scope="col">Created</th>
                <th scope="col">By</th>
                <th scope="col">Checksum</th>
                <th scope="col">Notes</th>
                <th scope="col">
                  <span className="visually-hidden">Payload</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version}>
                  <td className="figure">{v.version}</td>
                  <td className="figure">{v.worldsPinned}</td>
                  <td className="figure">{v.parentVersion ?? '—'}</td>
                  <td className="figure">{adminAt(v.createdAt)}</td>
                  <td>{v.createdByLabel}</td>
                  <td className="figure">{shortChecksum(v.checksum)}</td>
                  <td>{v.notes ?? '—'}</td>
                  <td>
                    <Button
                      variant="tertiary"
                      onClick={() => {
                        setOpened((current) => (current === v.version ? null : v.version));
                      }}
                    >
                      {opened === v.version ? 'Hide' : 'Inspect'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {opened !== null && (
          <section className="admin__section">
            <h2 className="admin__heading">{opened}</h2>
            <VersionDetail version={opened} />
          </section>
        )}
      </section>

      {versions.length > 0 && <ComparePanel versions={versions} />}

      <section className="admin__section">
        <h2 className="admin__heading">Worlds</h2>
        {worlds === null || worlds.length === 0 ? (
          <StateBlock kind="empty">
            No worlds to pin. Create one on the Worlds page first.
          </StateBlock>
        ) : (
          worlds.map((world) => (
            <WorldEconomyPin
              key={world.id}
              world={world}
              versions={versions}
              current={byVersion.get(world.economyConfigVersion) ?? null}
              onChanged={load}
            />
          ))
        )}
      </section>
    </>
  );
}
