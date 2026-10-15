import { useState } from 'react';

import type {
  RouteGroupsResponse,
  RouteGroupSummary,
  ServicePackageSummary,
} from '@tailfin/shared';

import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import {
  assignPackage,
  createRouteGroup,
  deleteRouteGroup,
  writeFailureKind,
  type ServiceWrite,
  type ServiceWriteFailure,
} from './api';

import type { FormEvent, ReactNode } from 'react';

/**
 * Route groups: what a package is assigned to (App. D.5), and their lifecycle
 * (SURFACE-11).
 *
 * The appendix assigns packages *"per route group, not per aircraft"* and never
 * says what a route group is. M8-03 decided: **a name and a set of the airline's
 * own routes**, player-defined, with each route in at most one group. So that is
 * the whole of the form — a name and a pick of routes — and nothing about
 * regions, segments or aircraft, which a group is deliberately not keyed by.
 *
 * ## The server's state, rendered
 *
 * Every write is followed by a re-read of the configuration rather than a patch
 * of the copy on screen. Creating a group can take routes out of another one,
 * and deleting a group changes how many groups hold a package; a client that
 * worked either out for itself would be recomputing the server's answer.
 *
 * ## Deleting is two clicks
 *
 * The house rule for destructive actions (UX-08, the airport map's Release). A
 * deleted group's routes fall back to the baseline product, so the confirm says
 * how many routes that is — a count the server sent, not one worked out here.
 */

const ROUTE_ARROW = ' → ';

function pair(route: { originIcao: string; destinationIcao: string }): string {
  return `${route.originIcao}${ROUTE_ARROW}${route.destinationIcao}`;
}

function routesPhrase(count: number): string {
  return `${String(count)} route${count === 1 ? '' : 's'}`;
}

interface PickableRoute {
  routeId: string;
  originIcao: string;
  destinationIcao: string;
  /** The group it sits in now, or null when it flies the baseline product. */
  groupName: string | null;
}

/** Every route the airline flies, with the group each one is in today. */
function pickableRoutes(groups: RouteGroupsResponse): PickableRoute[] {
  const all: PickableRoute[] = [
    ...groups.groups.flatMap((group) =>
      group.routes.map((route) => ({ ...route, groupName: group.name })),
    ),
    ...groups.ungrouped.map((route) => ({ ...route, groupName: null })),
  ];
  return all.sort(
    (a, b) =>
      a.originIcao.localeCompare(b.originIcao) ||
      a.destinationIcao.localeCompare(b.destinationIcao),
  );
}

export interface RouteGroupsPanelProps {
  /** Null when the configuration could not be read. */
  groups: RouteGroupsResponse | null;
  packages: readonly ServicePackageSummary[];
  /** Re-read groups and packages, so the page shows what the server now holds. */
  onChanged: () => Promise<void>;
}

export function RouteGroupsPanel({
  groups,
  packages,
  onChanged,
}: RouteGroupsPanelProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ServiceWriteFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());

  const routes = groups === null ? [] : pickableRoutes(groups);

  /**
   * Run one write, then re-read.
   *
   * The re-read follows a refusal too, unless the server was never reached: a
   * 404 for a group deleted in another tab is a sign the page is stale, and the
   * honest answer is the current list. A refusal itself changed nothing.
   */
  const run = async (
    attempt: () => Promise<ServiceWrite>,
    succeeded: () => void,
  ): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    const outcome = await attempt();
    if (outcome.ok) succeeded();
    else setFailure(outcome);
    if (outcome.ok || outcome.code !== 'unreachable') await onChanged();
    setBusy(false);
  };

  const assign = (group: RouteGroupSummary, packageId: string): Promise<void> =>
    run(
      () => assignPackage(group.id, packageId === '' ? null : packageId),
      () => undefined,
    );

  const remove = (group: RouteGroupSummary): Promise<void> =>
    run(
      () => deleteRouteGroup(group.id),
      () =>
        setNotice(
          group.routes.length === 0
            ? `Deleted “${group.name}”.`
            : `Deleted “${group.name}”. Its ${routesPhrase(group.routes.length)} ${group.routes.length === 1 ? 'flies' : 'fly'} baseline service now.`,
        ),
    );

  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      setNotice(null);
      setFailure({
        ok: false,
        status: 0,
        code: 'no_name',
        message: 'Give the group a name first.',
      });
      return;
    }
    // In the order the picker lists them, and only routes the last read still
    // holds: a pick that has since gone is not the player's to send.
    const routeIds = routes
      .filter((route) => chosen.has(route.routeId))
      .map((route) => route.routeId);
    await run(
      () => createRouteGroup(trimmed, routeIds),
      () => {
        setName('');
        setChosen(new Set());
        setNotice(`Created “${trimmed}”.`);
      },
    );
  };

  const toggle = (routeId: string): void => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(routeId)) next.delete(routeId);
      else next.add(routeId);
      return next;
    });
  };

  return (
    <section className="service-groups" aria-label="Route groups">
      <h2 className="service-groups__title">Route groups</h2>
      <p className="service-bench__hint">
        A saved package only reaches a flight once a route group flies it. Each route sits in at
        most one group; a route in none flies the baseline service.
      </p>

      {groups === null ? (
        <StateBlock kind="broken">
          Your route groups could not be read, so no package can be put into service from here.
        </StateBlock>
      ) : (
        <>
          {groups.groups.length === 0 ? (
            <StateBlock kind="empty">
              No route groups yet. Create one below, then choose the package it flies.
            </StateBlock>
          ) : (
            <ul className="service-groups__list">
              {groups.groups.map((group) => (
                <RouteGroupRow
                  key={group.id}
                  group={group}
                  packages={packages}
                  busy={busy}
                  onAssign={(packageId) => void assign(group, packageId)}
                  onDelete={() => void remove(group)}
                />
              ))}
            </ul>
          )}

          <form
            className="service-groups__new"
            aria-label="New route group"
            onSubmit={(event) => void create(event)}
          >
            <label className="service-page__field service-bench__name">
              <span>Group name</span>
              <input
                type="text"
                value={name}
                maxLength={60}
                placeholder="Leisure short-haul"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <fieldset className="service-groups__routes">
              <legend>Routes</legend>
              {routes.length === 0 ? (
                <p className="service-bench__hint">
                  You fly no routes yet, so the group starts empty.
                </p>
              ) : (
                <>
                  <p className="service-bench__hint">
                    Picking a route that is already in a group moves it here.
                  </p>
                  {routes.map((route) => (
                    <label key={route.routeId} className="service-groups__route">
                      <input
                        type="checkbox"
                        checked={chosen.has(route.routeId)}
                        onChange={() => toggle(route.routeId)}
                      />
                      <span>{pair(route)}</span>{' '}
                      {route.groupName !== null && (
                        <span className="service-groups__current">in {route.groupName}</span>
                      )}
                    </label>
                  ))}
                </>
              )}
            </fieldset>
            <Button type="submit" disabled={busy}>
              Create group
            </Button>
          </form>
        </>
      )}

      {notice !== null && (
        <p className="service-bench__saved" role="status">
          {notice}
        </p>
      )}
      {failure !== null && (
        <StateBlock kind={writeFailureKind(failure)} className="service-bench__failure">
          {failure.message}
        </StateBlock>
      )}
    </section>
  );
}

/** One group: its routes, the package it flies, and its delete. */
function RouteGroupRow({
  group,
  packages,
  busy,
  onAssign,
  onDelete,
}: {
  group: RouteGroupSummary;
  packages: readonly ServicePackageSummary[];
  busy: boolean;
  onAssign: (packageId: string) => void;
  onDelete: () => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="service-group">
      <label className="service-page__field service-group__package">
        <span>{group.name}</span>
        <select
          value={group.servicePackageId ?? ''}
          disabled={busy}
          onChange={(event) => onAssign(event.target.value)}
        >
          <option value="">Baseline service</option>
          {packages.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <p className="service-group__routes">
        {group.routes.length === 0
          ? 'No routes'
          : `${routesPhrase(group.routes.length)}: ${group.routes.map(pair).join(', ')}`}
      </p>
      {confirming ? (
        <span className="service-confirm">
          <span className="service-confirm__note">
            {group.routes.length === 0
              ? 'It holds no routes.'
              : `${routesPhrase(group.routes.length)} ${group.routes.length === 1 ? 'falls' : 'fall'} back to baseline service.`}
          </span>
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            aria-label={`Confirm delete ${group.name}`}
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
          >
            Confirm delete
          </Button>
          <Button
            variant="tertiary"
            size="sm"
            disabled={busy}
            aria-label={`Keep ${group.name}`}
            onClick={() => setConfirming(false)}
          >
            Keep
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          disabled={busy}
          aria-label={`Delete ${group.name}`}
          onClick={() => setConfirming(true)}
        >
          Delete
        </Button>
      )}
    </li>
  );
}
