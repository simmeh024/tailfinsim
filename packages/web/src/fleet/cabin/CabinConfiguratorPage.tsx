/**
 * The cabin configurator (§6, M6-08) — a full-screen builder like the livery
 * studio and the founding desk, which is why it sits outside the AppShell chrome
 * (see `App.tsx`). The mockup in one page: a toolbar, a module/action rail, the
 * top-down cabin plan, the inspector, and the live summary with a CG bar.
 *
 * ## What is and isn't wired
 *
 * §6's cabin builder has no server endpoints yet — nothing writes
 * `airframe.cabin_config_id`. So, exactly like the route planner shipped its
 * editor before Publish existed, this is the **whole editor** over a client-side
 * model seeded from `presets.ts`: selection, insertion, class/product/pitch
 * edits, undo/redo and every readout are real and correct. "Save config" writes a
 * local draft (a per-type `localStorage` key) and flashes a confirmation; it does
 * not yet POST, because there is nothing to POST to. When the endpoint lands,
 * swapping the seed and the save for `fetch` is a data-source change, not a
 * rewrite of any of this.
 */

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { evaluateConstraints, worstStatus } from './analysis';
import { CabinMap } from './CabinMap';
import { CABIN_CLASS_ACCENT, MONUMENT_SPECS } from './catalogue';
import { canRedo, canUndo, cabinReducer, createHistory, type CabinAction } from './editor';
import { Inspector } from './Inspector';
import { sectionsOf } from './layout';
import { CABIN_PRESETS, cloneConfig, presetFor } from './presets';
import { SummaryBar } from './SummaryBar';
import { CABIN_CLASS_META, MONUMENT_KINDS } from './types';

import type { Constraint, ConstraintStatus } from './analysis';
import type { CabinConfig } from './types';
import type { CSSProperties, ReactNode } from 'react';

import './cabin.css';

function draftKey(type: string): string {
  return `tailfin.cabin.draft.${type}`;
}

function loadDraft(type: string): CabinConfig | null {
  try {
    const raw = window.localStorage.getItem(draftKey(type));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as CabinConfig;
    if (!Array.isArray(parsed.elements)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveDraft(config: CabinConfig): boolean {
  try {
    window.localStorage.setItem(draftKey(config.typeDesignation), JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

const STATUS_GLYPH: Record<ConstraintStatus, string> = { ok: '✓', warn: '●', error: '✕' };

/** The header pills — exit clearance always, then anything not OK. */
function headerPills(constraints: readonly Constraint[]): Constraint[] {
  const exit = constraints.find((constraint) => constraint.id === 'exit-clearance');
  const notOk = constraints.filter(
    (constraint) => constraint.status !== 'ok' && constraint.id !== 'exit-clearance',
  );
  return [...(exit ? [exit] : []), ...notOk].slice(0, 4);
}

export function CabinConfiguratorPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const requestedType = params.get('type') ?? CABIN_PRESETS[0]!.frame.typeDesignation;
  const preset = useMemo(() => presetFor(requestedType), [requestedType]);
  const frame = preset.frame;

  const [history, dispatch] = useReducer(cabinReducer, preset, (initial) =>
    createHistory(loadDraft(initial.frame.typeDesignation) ?? cloneConfig(initial.config)),
  );
  const { config, selectedId } = history.present;

  const [tool, setTool] = useState<'select' | 'move'>('select');
  const [saveFlash, setSaveFlash] = useState<string | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  // Switching aircraft loads that type's draft (or its preset) into a new history.
  const switchType = useCallback(
    (type: string) => {
      const next = presetFor(type);
      dispatch({ type: 'reset', config: loadDraft(type) ?? cloneConfig(next.config) });
      setParams((prev) => {
        prev.set('type', next.frame.typeDesignation);
        return prev;
      });
      setTemplatesOpen(false);
    },
    [setParams],
  );

  const constraints = useMemo(() => evaluateConstraints(config, frame), [config, frame]);
  const overall = worstStatus(constraints);
  const pills = headerPills(constraints);
  const sections = useMemo(() => sectionsOf(config), [config]);

  const onSave = useCallback(() => {
    const ok = saveDraft(config);
    setSaveFlash(
      ok ? 'Configuration saved as a local draft' : 'Could not save — storage unavailable',
    );
    window.setTimeout(() => {
      setSaveFlash(null);
    }, 2600);
  }, [config]);

  // Keyboard: undo/redo, delete the selection, nudge in Move mode.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        dispatch(event.shiftKey ? { type: 'redo' } : { type: 'undo' });
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId !== null) {
        event.preventDefault();
        dispatch({ type: 'delete', id: selectedId });
      } else if (tool === 'move' && selectedId !== null && event.key === 'ArrowUp') {
        event.preventDefault();
        dispatch({ type: 'move', id: selectedId, dir: 'up' });
      } else if (tool === 'move' && selectedId !== null && event.key === 'ArrowDown') {
        event.preventDefault();
        dispatch({ type: 'move', id: selectedId, dir: 'down' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [selectedId, tool]);

  const insertModule = (action: CabinAction): void => {
    dispatch(action);
  };

  return (
    <div className="cc" data-status={overall}>
      {/* Toolbar */}
      <header className="cc-toolbar">
        <div className="cc-toolbar__id">
          <Link to="/fleet" className="cc-back" aria-label="Back to fleet">
            ‹
          </Link>
          <div>
            <p className="cc-toolbar__eyebrow">Cabin configurator</p>
            <h1 className="cc-toolbar__title">{frame.label}</h1>
          </div>
          <span className="cc-version">Current configuration · v{String(config.version)}</span>
        </div>

        <div className="cc-toolbar__actions">
          <div className="cc-menu">
            <button
              type="button"
              className="cc-btn cc-btn--ghost"
              aria-haspopup="menu"
              aria-expanded={templatesOpen}
              onClick={() => {
                setTemplatesOpen((open) => !open);
              }}
            >
              Templates ▾
            </button>
            {templatesOpen && (
              <ul className="cc-menu__list" role="menu">
                {CABIN_PRESETS.map((option) => (
                  <li key={option.frame.typeDesignation} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className="cc-menu__item"
                      onClick={() => {
                        switchType(option.frame.typeDesignation);
                      }}
                    >
                      {option.frame.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" className="cc-btn cc-btn--ghost" disabled title="Coming soon">
            Compare
          </button>
          <button
            type="button"
            className="cc-btn cc-btn--ghost"
            disabled={!canUndo(history)}
            onClick={() => {
              dispatch({ type: 'undo' });
            }}
          >
            ↶ Undo
          </button>
          <button
            type="button"
            className="cc-btn cc-btn--ghost"
            disabled={!canRedo(history)}
            onClick={() => {
              dispatch({ type: 'redo' });
            }}
          >
            ↷ Redo
          </button>
          <button type="button" className="cc-btn cc-btn--accent" onClick={onSave}>
            Save config
          </button>
        </div>
      </header>

      {/* Status row */}
      <div className="cc-statusrow">
        <span className="cc-statusrow__seats">
          Certified max seats: <strong className="figure">{frame.certifiedMaxSeats}</strong>
        </span>
        <span className="cc-statusrow__pills">
          {pills.map((pill) => (
            <span key={pill.id} className={`cc-pill cc-pill--${pill.status}`} title={pill.detail}>
              <span aria-hidden="true">{STATUS_GLYPH[pill.status]}</span> {pill.label}
            </span>
          ))}
        </span>
        {saveFlash !== null && (
          <span className="cc-statusrow__flash" role="status">
            {saveFlash}
          </span>
        )}
      </div>

      {/* Main three-column area */}
      <div className="cc-main">
        <nav className="cc-rail" aria-label="Tools">
          <p className="cc-rail__heading">Modules</p>
          <button
            type="button"
            className="cc-rail__btn"
            onClick={() => {
              insertModule({ type: 'insertRow', afterId: selectedId });
            }}
          >
            <span className="cc-rail__glyph" aria-hidden="true">
              ▤
            </span>
            Seat row
          </button>
          {MONUMENT_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="cc-rail__btn"
              onClick={() => {
                insertModule({ type: 'insertMonument', afterId: selectedId, kind });
              }}
            >
              <span className="cc-rail__glyph" aria-hidden="true">
                ◫
              </span>
              {MONUMENT_SPECS[kind].label}
            </button>
          ))}

          <p className="cc-rail__heading">Actions</p>
          <div className="cc-rail__tools">
            <button
              type="button"
              className={`cc-rail__tool${tool === 'select' ? ' is-active' : ''}`}
              aria-pressed={tool === 'select'}
              onClick={() => {
                setTool('select');
              }}
            >
              Select
            </button>
            <button
              type="button"
              className={`cc-rail__tool${tool === 'move' ? ' is-active' : ''}`}
              aria-pressed={tool === 'move'}
              onClick={() => {
                setTool('move');
              }}
            >
              Move
            </button>
          </div>
          <button
            type="button"
            className="cc-rail__btn"
            disabled={selectedId === null}
            onClick={() => {
              if (selectedId !== null) dispatch({ type: 'move', id: selectedId, dir: 'up' });
            }}
          >
            ↑ Move forward
          </button>
          <button
            type="button"
            className="cc-rail__btn"
            disabled={selectedId === null}
            onClick={() => {
              if (selectedId !== null) dispatch({ type: 'move', id: selectedId, dir: 'down' });
            }}
          >
            ↓ Move aft
          </button>
          <button
            type="button"
            className="cc-rail__btn cc-rail__btn--danger"
            disabled={selectedId === null}
            onClick={() => {
              if (selectedId !== null) dispatch({ type: 'delete', id: selectedId });
            }}
          >
            🗑 Delete
          </button>
        </nav>

        <div className="cc-stage">
          <div className="cc-sections" aria-hidden="true">
            {sections.map((section, index) => (
              <div
                key={`${section.cabinClass}-${String(index)}`}
                className="cc-sectionband"
                style={
                  {
                    flexGrow: section.rowCount,
                    '--sec': CABIN_CLASS_ACCENT[section.cabinClass],
                  } as CSSProperties
                }
              >
                <span className="cc-sectionband__name">{section.label}</span>
                <span className="cc-sectionband__meta">
                  Rows {section.firstRow}–{section.lastRow} · {section.seats} seats
                </span>
              </div>
            ))}
          </div>

          <div className="cc-mapwrap">
            <CabinMap
              config={config}
              frame={frame}
              selectedId={selectedId}
              onSelect={(id) => {
                dispatch({ type: 'select', id });
              }}
            />
          </div>

          <p className="cc-hint">
            {selectedId === null
              ? 'Click a row or module to select it. Add from the Modules rail; drag order with Move.'
              : tool === 'move'
                ? 'Move mode: use ↑ / ↓ or the rail to reorder the selected element.'
                : 'Editing the selected element. Switch tabs in the inspector to change its product or check its constraints.'}
          </p>
        </div>

        <Inspector config={config} frame={frame} selectedId={selectedId} dispatch={dispatch} />
      </div>

      <SummaryBar config={config} frame={frame} />

      {/* A tiny legend so the class colours are named somewhere. */}
      <div className="cc-legend" aria-hidden="true">
        {sections.length > 0 &&
          [...new Set(sections.map((section) => section.cabinClass))].map((cabinClass) => (
            <span
              key={cabinClass}
              className="cc-legend__item"
              style={{ '--sec': CABIN_CLASS_ACCENT[cabinClass] } as CSSProperties}
            >
              {CABIN_CLASS_META[cabinClass].label}
            </span>
          ))}
      </div>
    </div>
  );
}
