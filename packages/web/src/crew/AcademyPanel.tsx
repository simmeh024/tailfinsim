import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AcademiesResponse,
  AcademyModuleOffer,
  AcademySiteView,
  AcademyView,
} from '@tailfin/shared';

import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import {
  buildAcademyModule,
  fetchAcademies,
  foundAcademy,
  upgradeAcademy,
  type AcademyFailure,
} from './academy-api';
import {
  academyPurposeInWords,
  blockedInWords,
  buildProgressInWords,
  ceilingRows,
  confirmInWords,
  doneInWords,
  formatWorldDate,
  gameWeeks,
  intentKey,
  levelName,
  levelUnlocksInWords,
  money,
  moduleName,
  refusalInWords,
  type AcademyIntent,
} from './academy-presentation';

import type { ReactNode } from 'react';

import './academy.css';

/**
 * Training academies — build one, level it, equip it (SURFACE-10, M9-01, §10.1).
 *
 * ## Why it is a section of the Crew page
 *
 * An academy is built **at a crew base** and exists to train that base's crew:
 * it decides whether a conversion is trained in-house or bought in, and how far
 * up the ladder crew may be taken. The Crew page already holds the bases, the
 * conversion action and the training pipeline, so the academies sit beside
 * them, at `#academies`, rather than on a page of their own a player would
 * have to know to look for. The Research page links here, because academy
 * levels are what its tiers and points wait on.
 *
 * ## What the page decides, and what it does not
 *
 * Nothing about money, time or eligibility. Every capital cost, build length,
 * upkeep and slot count is the server's quote, from the world's pinned economy
 * config, shown **before** the button; whether a level or module may be built is
 * the server's `nextLevel` and `blockedBy`. A write is two clicks — the quote,
 * then a confirmation that restates it — sent once and **never retried**: each
 * one charges capital and the endpoints take no idempotency key. The answer is
 * the whole academy state, which replaces the page's. A refusal replaces nothing
 * and says why, with the server's code.
 *
 * ## §10.4, held in the wording
 *
 * The academy is a ceiling and a discount. It makes conversions cheaper, permits
 * higher ranks and research tiers, and its levels count toward research points;
 * it never makes the airline more popular, and nothing here says otherwise.
 * There is no boost figure on the wire for a building, so the page shows none.
 */

type Load =
  { state: 'loading' } | { state: 'ready'; value: AcademiesResponse | null } | { state: 'failed' };

type WriteState =
  | { step: 'idle' }
  | { step: 'confirming'; intent: AcademyIntent }
  | { step: 'sending'; intent: AcademyIntent }
  | { step: 'refused'; intent: AcademyIntent; refusal: AcademyFailure }
  | { step: 'unknown'; intent: AcademyIntent }
  | { step: 'done'; intent: AcademyIntent; state: AcademiesResponse };

interface WriteControls {
  write: WriteState;
  onArm: (intent: AcademyIntent) => void;
  onConfirm: (intent: AcademyIntent) => void;
  onCancel: () => void;
  onReload: () => void;
}

/**
 * One write's control: the quoted button, then its confirmation in its place.
 *
 * The confirmation, a refusal and an unknown outcome are all drawn **where the
 * button was**, so the player reads the answer beside the thing they asked for.
 * While any write is in flight every other trigger is disabled, so a second
 * capital commitment cannot start before the first is answered.
 */
function WriteSlot({
  intent,
  label,
  disabled = false,
  controls,
}: {
  intent: AcademyIntent;
  label: string;
  disabled?: boolean;
  controls: WriteControls;
}): ReactNode {
  const { write, onArm, onConfirm, onCancel, onReload } = controls;
  const key = intentKey(intent);
  const mine = write.step !== 'idle' && write.step !== 'done' && intentKey(write.intent) === key;
  const sending = write.step === 'sending';

  if (mine && (write.step === 'confirming' || write.step === 'sending')) {
    const armed = write.intent;
    return (
      <div className="academy-confirm" role="group" aria-label="Confirm the build">
        <p className="academy-confirm__text">{confirmInWords(armed)}</p>
        <div className="academy-confirm__actions">
          <Button
            variant="primary"
            size="sm"
            disabled={sending}
            onClick={() => {
              onConfirm(armed);
            }}
          >
            {sending ? 'Paying…' : `Confirm — pay ${money(armed.quote.capitalCostMinor)}`}
          </Button>
          <Button variant="tertiary" size="sm" disabled={sending} onClick={onCancel}>
            Not now
          </Button>
        </div>
      </div>
    );
  }

  // After an answer that never came, this write waits for a reload: the money may
  // already have moved, and only the server's state can say.
  const awaitingReload = mine && write.step === 'unknown';

  return (
    <div className="academy-slot">
      <Button
        size="sm"
        disabled={disabled || sending || awaitingReload}
        onClick={() => {
          onArm(intent);
        }}
      >
        {label}
      </Button>
      {mine && write.step === 'refused' && (
        <StateBlock
          kind="refused"
          action={
            <Button variant="tertiary" size="sm" onClick={onReload}>
              Reload academies
            </Button>
          }
        >
          {refusalInWords(write.refusal)}{' '}
          <span className="academy__code">({write.refusal.code})</span>
        </StateBlock>
      )}
      {mine && write.step === 'unknown' && (
        <StateBlock
          kind="broken"
          action={
            <Button variant="tertiary" size="sm" onClick={onReload}>
              Reload academies
            </Button>
          }
        >
          The answer did not arrive, so whether it went through is unknown. It is never sent twice:
          reload to see your academies before deciding again.
        </StateBlock>
      )}
    </div>
  );
}

/** One module the academy could build, priced, with what blocks it. */
function OfferRow({
  academy,
  offer,
  controls,
}: {
  academy: AcademyView;
  offer: AcademyModuleOffer;
  controls: WriteControls;
}): ReactNode {
  const [family, setFamily] = useState<string>(offer.availableFamilies[0] ?? '');
  // The picker's choice must stay one the server still offers after a write.
  const chosen = offer.availableFamilies.includes(family)
    ? family
    : (offer.availableFamilies[0] ?? '');
  const blocked = blockedInWords(offer);
  const { quote } = offer;
  const intent: AcademyIntent = {
    kind: 'module',
    academyId: academy.id,
    icao: academy.airportIcao,
    module: offer.kind,
    family: offer.perFamily ? chosen : null,
    readToday: offer.readToday,
    quote,
  };
  const confirming =
    controls.write.step === 'confirming' && intentKey(controls.write.intent) === intentKey(intent);

  return (
    <li className="academy-offer" data-blocked={blocked === null ? 'no' : 'yes'}>
      <div className="academy-offer__what">
        <span className="academy-offer__name">
          {offer.name}
          {!offer.readToday && <span className="crew-tag crew-tag--muted">Not used yet</span>}
        </span>
        <span className="academy-offer__purpose">
          {offer.purpose}
          {!offer.readToday && ' Priced and buildable, but nothing in the game reads it yet.'}
        </span>
      </div>
      <dl className="academy-offer__figures">
        <div>
          <dt>Capital</dt>
          <dd className="figure">{money(quote.capitalCostMinor)}</dd>
        </div>
        <div>
          <dt>Build</dt>
          <dd>{gameWeeks(quote.buildWeeks)}</dd>
        </div>
        <div>
          <dt>Upkeep</dt>
          <dd>
            <span className="figure">+{money(quote.monthlyUpkeepMinor)}</span> a game month
          </dd>
        </div>
      </dl>
      <div className="academy-offer__action">
        {blocked !== null ? (
          <span className="academy-offer__blocked">{blocked}</span>
        ) : (
          <>
            {offer.perFamily && (
              <label className="academy-offer__family">
                <span>Family</span>
                <select
                  value={chosen}
                  disabled={controls.write.step === 'sending'}
                  onChange={(event) => {
                    setFamily(event.target.value);
                    // A confirmation names a family; choosing another withdraws it.
                    if (confirming) controls.onCancel();
                  }}
                >
                  {offer.availableFamilies.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <WriteSlot
              intent={intent}
              label={`Build — ${money(quote.capitalCostMinor)}`}
              disabled={offer.perFamily && chosen === ''}
              controls={controls}
            />
          </>
        )}
      </div>
    </li>
  );
}

/** One academy: what it is, what it permits, what it costs, and what it can become. */
function AcademyCard({
  academy,
  inGameTime,
  controls,
}: {
  academy: AcademyView;
  inGameTime: Date | null;
  controls: WriteControls;
}): ReactNode {
  const titleId = `academy-${academy.id}`;
  const building =
    academy.pendingLevel !== null && academy.constructionReadyAt !== null
      ? {
          level: academy.pendingLevel,
          progress: buildProgressInWords(academy.constructionReadyAt, inGameTime),
        }
      : null;

  return (
    <article className="academy-card" aria-labelledby={titleId}>
      <header className="academy-card__head">
        <h3 className="academy-card__title" id={titleId}>
          <span className="figure">{academy.airportIcao}</span> ·{' '}
          {academy.levelName ?? 'Building site'}
        </h3>
        <span className="academy-card__level">
          {academy.level === 0 ? 'No level yet' : `Level ${String(academy.level)} of 5`}
        </span>
      </header>

      {building !== null && (
        <p className="academy-card__building">
          <span
            className={`status status--${building.progress.tone === 'stalled' ? 'cancelled' : 'delayed'}`}
          >
            {building.progress.tone === 'stalled' ? 'Not finishing' : 'Under construction'}
          </span>{' '}
          Level {building.level} ({levelName(building.level)}). {building.progress.text}
        </p>
      )}

      {academy.ceiling === null ? (
        <p className="crew__hint">
          A building site permits nothing — no rank, no research tier, no training slot — until
          level 1 is commissioned. No upkeep is charged until then either (
          <span className="figure">{money(academy.monthlyUpkeepMinor)}</span> a game month).
        </p>
      ) : (
        <>
          <dl className="academy-card__facts">
            {ceilingRows(academy.ceiling).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
            <div>
              <dt>Upkeep</dt>
              <dd>
                <span className="figure">{money(academy.monthlyUpkeepMinor)}</span> a game month
              </dd>
            </div>
          </dl>
          <p className="crew__hint">
            Upkeep is the level’s plus every installed module’s, billed as each game month closes.
          </p>
        </>
      )}

      <section className="academy-card__part" aria-labelledby={`${titleId}-modules`}>
        <h4 className="academy-card__subtitle" id={`${titleId}-modules`}>
          Modules
        </h4>
        {academy.modules.length === 0 ? (
          <p className="crew__hint">
            None yet. Nothing is taught in-house without a CBT Suite; modules decide what can be
            trained, the level decides how far.
          </p>
        ) : (
          <ul className="academy-modules">
            {academy.modules.map((module) => {
              const progress =
                module.status === 'under_construction'
                  ? buildProgressInWords(module.readyAt, inGameTime)
                  : null;
              return (
                <li key={module.id} className="academy-modules__item">
                  <span className="academy-modules__name">
                    {moduleName(module.kind)}
                    {module.family !== null && (
                      <>
                        {' '}
                        <span className="figure">{module.family}</span>
                      </>
                    )}
                  </span>{' '}
                  {progress === null ? (
                    <span className="status status--ontime">
                      Installed{' '}
                      {module.installedAt === null ? '' : formatWorldDate(module.installedAt)}
                    </span>
                  ) : (
                    <span className="academy-modules__progress">
                      <span
                        className={`status status--${progress.tone === 'stalled' ? 'cancelled' : 'delayed'}`}
                      >
                        {progress.tone === 'stalled' ? 'Not finishing' : 'Being built'}
                      </span>{' '}
                      {progress.text}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="academy-card__part" aria-labelledby={`${titleId}-next`}>
        <h4 className="academy-card__subtitle" id={`${titleId}-next`}>
          Next level
        </h4>
        {academy.nextLevel !== null ? (
          <>
            <p className="crew__hint">
              Level {academy.level + 1}, {levelName(academy.level + 1)}:{' '}
              {levelUnlocksInWords(academy.level + 1)}
            </p>
            <dl className="academy-card__facts">
              <div>
                <dt>Capital</dt>
                <dd className="figure">{money(academy.nextLevel.capitalCostMinor)}</dd>
              </div>
              <div>
                <dt>Build</dt>
                <dd>{gameWeeks(academy.nextLevel.buildWeeks)}</dd>
              </div>
              <div>
                <dt>Level upkeep</dt>
                <dd>
                  <span className="figure">{money(academy.nextLevel.monthlyUpkeepMinor)}</span> a
                  game month
                </dd>
              </div>
            </dl>
            <WriteSlot
              intent={{
                kind: 'level',
                academyId: academy.id,
                icao: academy.airportIcao,
                level: academy.level + 1,
                quote: academy.nextLevel,
              }}
              label={`Build level ${String(academy.level + 1)} — ${money(academy.nextLevel.capitalCostMinor)}`}
              controls={controls}
            />
          </>
        ) : academy.pendingLevel !== null ? (
          <p className="crew__hint">
            One level at a time: the next can start once level {academy.pendingLevel} is
            commissioned.
          </p>
        ) : (
          <p className="crew__hint">{levelName(5)}: the top of the ladder.</p>
        )}
      </section>

      <section className="academy-card__part" aria-labelledby={`${titleId}-offers`}>
        <h4 className="academy-card__subtitle" id={`${titleId}-offers`}>
          Build a module
        </h4>
        <ul className="academy-offers">
          {academy.moduleOffers.map((offer) => (
            <OfferRow key={offer.kind} academy={academy} offer={offer} controls={controls} />
          ))}
        </ul>
      </section>
    </article>
  );
}

/** Open crew bases without an academy, and what founding one would cost. */
function Sites({
  sites,
  controls,
}: {
  sites: readonly AcademySiteView[];
  controls: WriteControls;
}): ReactNode {
  return (
    <section className="academy-sites" aria-labelledby="academy-sites-heading">
      <h3 className="academy-card__subtitle" id="academy-sites-heading">
        Crew bases without an academy
      </h3>
      <ul className="academy-sites__list">
        {sites.map((site) => (
          <li key={site.crewBaseId} className="academy-site">
            <div className="academy-site__what">
              <span className="figure academy-site__icao">{site.airportIcao}</span>
              <span className="academy-site__quote">
                Level 1, {levelName(1)}: {money(site.quote.capitalCostMinor)},{' '}
                {gameWeeks(site.quote.buildWeeks)} to build, then{' '}
                {money(site.quote.monthlyUpkeepMinor)} a game month.
              </span>
            </div>
            <WriteSlot
              intent={{
                kind: 'found',
                crewBaseId: site.crewBaseId,
                icao: site.airportIcao,
                quote: site.quote,
              }}
              label={`Found an academy at ${site.airportIcao} — ${money(site.quote.capitalCostMinor)}`}
              controls={controls}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface AcademyPanelProps {
  /** The world's game time, or `null` before the first sync. */
  inGameTime: Date | null;
}

export function AcademyPanel({ inGameTime }: AcademyPanelProps): ReactNode {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [write, setWrite] = useState<WriteState>({ step: 'idle' });
  const [generation, setGeneration] = useState(0);
  const sectionRef = useRef<HTMLElement | null>(null);
  const scrolled = useRef(false);

  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading' });
    void fetchAcademies()
      .then((value) => {
        if (live) setLoad({ state: 'ready', value });
      })
      .catch(() => {
        if (live) setLoad({ state: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [generation]);

  // Arriving from the Research page's link: bring the section into view once.
  useEffect(() => {
    if (load.state !== 'ready' || scrolled.current) return;
    scrolled.current = true;
    if (globalThis.location?.hash === '#academies') {
      sectionRef.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [load.state]);

  const reload = useCallback(() => {
    setWrite({ step: 'idle' });
    setGeneration((value) => value + 1);
  }, []);

  const confirm = useCallback((intent: AcademyIntent) => {
    setWrite({ step: 'sending', intent });
    const request =
      intent.kind === 'found'
        ? foundAcademy(intent.crewBaseId)
        : intent.kind === 'level'
          ? upgradeAcademy(intent.academyId)
          : buildAcademyModule(intent.academyId, intent.module, intent.family ?? undefined);
    // Sent once. A failure is reported, never retried: each write charges capital.
    void request
      .then((outcome) => {
        if (outcome.ok) {
          setLoad({ state: 'ready', value: outcome.state });
          setWrite({ step: 'done', intent, state: outcome.state });
        } else {
          // The academies on screen stay exactly as they were: the server refused.
          setWrite({ step: 'refused', intent, refusal: outcome.refusal });
        }
      })
      .catch(() => {
        setWrite({ step: 'unknown', intent });
      });
  }, []);

  const controls: WriteControls = {
    write,
    onArm: (intent) => {
      setWrite({ step: 'confirming', intent });
    },
    onConfirm: confirm,
    onCancel: () => {
      setWrite({ step: 'idle' });
    },
    onReload: reload,
  };

  return (
    <section
      id="academies"
      ref={sectionRef}
      className="crew-panel academy"
      aria-labelledby="academy-heading"
    >
      <div className="crew-panel__head">
        <h2 className="crew-panel__title" id="academy-heading">
          Training academies
        </h2>
        <p className="crew-panel__sub">Level sets how far crew can be trained; modules set what</p>
      </div>

      {load.state === 'loading' ? (
        <StateBlock kind="loading">Reading your academies…</StateBlock>
      ) : load.state === 'failed' ? (
        <StateBlock
          kind="broken"
          action={
            <Button variant="tertiary" size="sm" onClick={reload}>
              Reload academies
            </Button>
          }
        >
          Could not load your academies. What they permit and cost is unknown until they load.
        </StateBlock>
      ) : load.value === null ? (
        <StateBlock kind="empty">
          Found an airline first — an academy is built at one of its crew bases.
        </StateBlock>
      ) : (
        <AcademyBody
          academies={load.value}
          inGameTime={inGameTime}
          controls={controls}
          write={write}
        />
      )}
    </section>
  );
}

function AcademyBody({
  academies,
  inGameTime,
  controls,
  write,
}: {
  academies: AcademiesResponse;
  inGameTime: Date | null;
  controls: WriteControls;
  write: WriteState;
}): ReactNode {
  return (
    <>
      <p className="crew__hint">
        {academyPurposeInWords(academies.outsourcedConversionPerHeadMinor)}
      </p>

      {write.step === 'done' && (
        <p className="academy__done" role="status">
          {doneInWords(write.intent, write.state)}
        </p>
      )}

      {academies.academies.length === 0 && academies.sites.length === 0 ? (
        <StateBlock kind="empty">
          No crew base to build at. An academy is founded at an open crew base, one per base — open
          a base under Actions, and it appears here.
        </StateBlock>
      ) : (
        <>
          {academies.academies.length === 0 ? (
            <StateBlock kind="empty">
              No academy yet. Every conversion is bought in at the market rate until one opens.
            </StateBlock>
          ) : (
            <div className="academy-list">
              {academies.academies.map((academy) => (
                <AcademyCard
                  key={academy.id}
                  academy={academy}
                  inGameTime={inGameTime}
                  controls={controls}
                />
              ))}
            </div>
          )}
          {academies.sites.length > 0 && <Sites sites={academies.sites} controls={controls} />}
        </>
      )}
    </>
  );
}
