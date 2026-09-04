import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/**
 * The action hierarchy (UX-08).
 *
 * These four are not invented. Every one of them already existed in the client,
 * in a different place under a different name, which is precisely the problem:
 *
 * - **primary** — a filled accent. `login__button` and `market-action--primary`.
 * - **secondary** — outlined on an inset ground. `net-btn`, `cc-btn`,
 *   `admin__submit`, `gate__retry`.
 * - **tertiary** — text weight, no chrome. `admin__cancel`, `account__signout`.
 * - **danger** — the cancelled status colour. `net-btn--danger`,
 *   `admin__danger-button`.
 *
 * So there were around eight button classes, each named after the page that
 * needed it, and nothing said which was dominant. In practice the answer was
 * "whichever one the page already had" — which is how the player-facing network
 * planner came to open routes with a class called `admin__submit`.
 */
export const BUTTON_VARIANTS = ['primary', 'secondary', 'tertiary', 'danger'] as const;

export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

export interface ButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'className'> {
  /**
   * Defaults to `secondary`, deliberately.
   *
   * `primary` means *this is the one action of this task region*, and there is
   * meant to be one. If the default were `primary`, every button nobody thought
   * about would be dominant, and the hierarchy would be gone within a milestone
   * — which is roughly how the old classes lost theirs.
   */
  variant?: ButtonVariant;
  /** `sm` for row actions and dense toolbars. */
  size?: 'sm' | 'md';
  /** Layout only — the caller owns where the button sits, the variant owns how it looks. */
  className?: string;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type,
  ...rest
}: ButtonProps): ReactNode {
  const classes = ['btn', `btn--${variant}`];
  if (size === 'sm') classes.push('btn--sm');
  if (className !== undefined) classes.push(className);
  return (
    // `button` unless the caller says otherwise. A <button> inside a <form> with
    // no type submits it, which is never what an inline action meant; the eight
    // forms in this client all name `type="submit"` explicitly, so nothing
    // depends on the accident.
    <button type={type ?? 'button'} className={classes.join(' ')} {...rest} />
  );
}
