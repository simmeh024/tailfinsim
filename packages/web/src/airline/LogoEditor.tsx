import { useState } from 'react';

import {
  AIRLINE_LOGO_SHAPES,
  AIRLINE_LOGO_SYMBOLS,
  type AirlineLogo,
  type AirlineLogoShape,
  type AirlineLogoSymbol,
} from '@tailfin/shared';

import { AirlineLogoEmblem } from './AirlineLogoEmblem';

import type { ReactNode } from 'react';

/**
 * The brand-logo editor (§15/§16) — a controlled emblem editor with a live
 * preview. Every control edits the same {@link AirlineLogo} the viewer renders,
 * so the preview is not an approximation of the save: it is the save.
 *
 * The logo is a paid identity event, so this component only edits the working
 * value; the airline page owns the draft, the dirty check and the rebrand submit.
 */

const SHAPE_LABELS: Record<AirlineLogoShape, string> = {
  roundel: 'Roundel',
  shield: 'Shield',
  square: 'Square',
  hexagon: 'Hexagon',
};

const SYMBOL_LABELS: Record<AirlineLogoSymbol, string> = {
  wings: 'Wings',
  star: 'Star',
  globe: 'Globe',
  mountain: 'Mountain',
  bird: 'Bird',
};

function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}): ReactNode {
  return (
    <div className="logo-editor__color">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function LogoEditor({
  value,
  onChange,
}: {
  value: AirlineLogo;
  onChange: (next: AirlineLogo) => void;
}): ReactNode {
  // Remember the text and symbol across a mark-type toggle, so flipping to Symbol
  // and back does not throw away the monogram the player typed.
  const [lastText, setLastText] = useState(
    value.mark.kind === 'monogram' ? value.mark.text : 'AIR',
  );
  const [lastSymbol, setLastSymbol] = useState<AirlineLogoSymbol>(
    value.mark.kind === 'symbol' ? value.mark.symbol : 'wings',
  );

  const set = (patch: Partial<AirlineLogo>): void => onChange({ ...value, ...patch });

  return (
    <div className="logo-editor">
      <div className="logo-editor__preview">
        <AirlineLogoEmblem logo={value} size={128} label="Logo preview" />
      </div>

      <div className="logo-editor__controls">
        <fieldset className="logo-editor__group">
          <legend>Shape</legend>
          <div className="logo-editor__segmented" role="group" aria-label="Logo shape">
            {AIRLINE_LOGO_SHAPES.map((shape) => (
              <button
                key={shape}
                type="button"
                aria-pressed={value.shape === shape}
                onClick={() => set({ shape })}
              >
                {SHAPE_LABELS[shape]}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="logo-editor__group">
          <legend>Mark</legend>
          <div className="logo-editor__segmented" role="group" aria-label="Mark type">
            <button
              type="button"
              aria-pressed={value.mark.kind === 'monogram'}
              onClick={() => set({ mark: { kind: 'monogram', text: lastText } })}
            >
              Initials
            </button>
            <button
              type="button"
              aria-pressed={value.mark.kind === 'symbol'}
              onClick={() => set({ mark: { kind: 'symbol', symbol: lastSymbol } })}
            >
              Symbol
            </button>
          </div>

          {value.mark.kind === 'monogram' ? (
            <div className="logo-editor__field">
              <label htmlFor="logo-monogram">Initials (1–3)</label>
              <input
                id="logo-monogram"
                className="figure"
                value={value.mark.text}
                maxLength={3}
                onChange={(event) => {
                  const text = event.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, '')
                    .slice(0, 3);
                  if (text.length === 0) return;
                  setLastText(text);
                  set({ mark: { kind: 'monogram', text } });
                }}
              />
            </div>
          ) : (
            <div className="logo-editor__symbols" role="group" aria-label="Symbol">
              {AIRLINE_LOGO_SYMBOLS.map((symbol) => {
                const selected = value.mark.kind === 'symbol' && value.mark.symbol === symbol;
                return (
                  <button
                    key={symbol}
                    type="button"
                    className="logo-editor__symbol"
                    aria-pressed={selected}
                    title={SYMBOL_LABELS[symbol]}
                    onClick={() => {
                      setLastSymbol(symbol);
                      set({ mark: { kind: 'symbol', symbol } });
                    }}
                  >
                    <AirlineLogoEmblem
                      logo={{ ...value, mark: { kind: 'symbol', symbol } }}
                      size={44}
                      label={SYMBOL_LABELS[symbol]}
                    />
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>

        <fieldset className="logo-editor__group">
          <legend>Colours</legend>
          <div className="logo-editor__colors">
            <ColorField
              id="logo-background"
              label="Background"
              value={value.background}
              onChange={(background) => set({ background })}
            />
            <ColorField
              id="logo-foreground"
              label="Mark"
              value={value.foreground}
              onChange={(foreground) => set({ foreground })}
            />
            <ColorField
              id="logo-accent"
              label="Ring"
              value={value.accent}
              onChange={(accent) => set({ accent })}
            />
          </div>
        </fieldset>
      </div>
    </div>
  );
}
