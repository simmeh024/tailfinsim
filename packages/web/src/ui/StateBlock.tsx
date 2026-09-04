import type { ReactNode } from 'react';

/**
 * The four things a panel can have to say instead of its content (UX-07).
 *
 * Before this existed the app said all four with a bare `<p className="admin__note">`
 * or a bare `<p className="page__note">`, chosen more or less at random — the
 * competition tab announced its loading state with one class and the failure
 * beside it with the other. Worse, the two were indistinguishable to a screen
 * reader: a failure was an `alert`, but "Loading the market..." was silent, so
 * a slow request read as an empty panel.
 *
 * The kinds are deliberately these four and not a free-form tone, because they
 * are the four answers the server can give a panel:
 *
 * - `loading`  the request is in flight; nothing is known yet.
 * - `empty`    the request succeeded and there is genuinely nothing.
 * - `refused`  the request was answered, and the answer is no.
 * - `broken`   the request failed; what should be here is unknown.
 *
 * `empty` and `broken` are the pair worth keeping apart most carefully. A
 * catalogue with no aircraft in a 1950s world is a correct, meaningful answer;
 * a catalogue that could not be read is a fault. Painting both as grey text
 * hid the difference from the player.
 */
export const STATE_KINDS = ['loading', 'empty', 'refused', 'broken'] as const;

export type StateKind = (typeof STATE_KINDS)[number];

/**
 * How each kind announces itself.
 *
 * `loading` is a polite `status`, so it is read after whatever the user is
 * doing rather than interrupting. `refused` and `broken` are `alert`s: both are
 * the outcome of something the user asked for, and both preserve what the
 * hand-written notes already did. `empty` announces nothing — it is the normal
 * resting state of a panel, and a world with no worlds yet should not shout.
 */
const LIVE_ROLE: Record<StateKind, 'status' | 'alert' | undefined> = {
  loading: 'status',
  empty: undefined,
  refused: 'alert',
  broken: 'alert',
};

function Glyph({ kind }: { kind: StateKind }): ReactNode {
  // Every glyph is decoration: the sentence beside it carries the meaning, so
  // none of them is exposed to assistive technology.
  if (kind === 'loading') {
    return (
      <span className="state__dots" aria-hidden="true">
        <span className="state__dot" />
        <span className="state__dot" />
        <span className="state__dot" />
      </span>
    );
  }
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 14 14',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (kind === 'broken') {
    return (
      <svg {...common}>
        <path d="M7 1.6 12.9 12H1.1z" />
        <path d="M7 5.6v2.9" />
        <path d="M7 10.4h.01" />
      </svg>
    );
  }
  if (kind === 'refused') {
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="5.4" />
        <path d="M3.2 3.2l7.6 7.6" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeDasharray="2 2.4">
      <circle cx="7" cy="7" r="5.4" />
    </svg>
  );
}

export interface StateBlockProps {
  kind: StateKind;
  /** The sentence to show. Written by the caller, because only the caller knows the subject. */
  children: ReactNode;
  /**
   * A control or link that resolves the state — "Back to players", "Open the
   * founding desk". Several of these notes already had one sitting after them
   * as a loose sibling; this puts it inside the block it belongs to.
   */
  action?: ReactNode;
  /** Escape hatch for the few callers that need to place the block in a grid. */
  className?: string;
}

export function StateBlock({ kind, children, action, className }: StateBlockProps): ReactNode {
  const classes = ['state', `state--${kind}`];
  if (className !== undefined) classes.push(className);
  return (
    <div className={classes.join(' ')} role={LIVE_ROLE[kind]} data-state={kind}>
      <span className="state__glyph">
        <Glyph kind={kind} />
      </span>
      <div className="state__body">
        <p className="state__message">{children}</p>
        {action !== undefined && <div className="state__action">{action}</div>}
      </div>
    </div>
  );
}
