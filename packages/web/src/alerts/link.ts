import type { Alert, AlertScreen } from '@tailfin/shared';

/**
 * Where an alert goes when the player acts on it (M8-13's third criterion).
 *
 * The server names the **subsystem** that owns the decision; this maps it to a
 * path, because the router's shape is the client's business and a server
 * emitting `/network?route=…` would be asserting a URL it cannot verify. It is
 * M8-10's `drillHref` split, one page along.
 *
 * The difference from `drillHref` is that this **never returns null**. A
 * drill-down with no page yet is named rather than linked, because a figure is
 * still useful unlinked; an alert is not — *"each alert links directly to the
 * screen where it can be acted on"* is the criterion, so a screen with no page
 * is a rule that should not have shipped. `alerts-ui.test.tsx` fails on any
 * member of `AlertScreen` this map does not cover **and** on any path the router
 * does not serve, which is the pair of failures a type cannot catch.
 */
export function alertHref(alert: Pick<Alert, 'screen' | 'subjectType' | 'subjectId'>): string {
  switch (alert.screen) {
    case 'network':
      /*
       * A route alert opens the network page **on that route**, so the §14.4
       * diagnosis the alert's own sentence points at is one click rather than a
       * search through a list. The same query parameter M8-10's drill-down uses.
       */
      return alert.subjectType === 'route'
        ? `/network?route=${encodeURIComponent(alert.subjectId)}`
        : '/network';
    case 'finance':
      return '/finance';
    case 'credit':
      // §13's lending lives on the Financial dashboard, which carries the
      // standing, the headroom and the loans. There is no separate credit page.
      return '/finance';
    case 'crew':
      return '/crew';
    case 'fleet':
      /*
       * An airframe alert — a check due and unbooked — opens the Fleet page's
       * maintenance planner on that aircraft (SURFACE-04), so booking the check
       * the alert is about is one click from it.
       */
      return alert.subjectType === 'airframe'
        ? `/fleet?maintenance=${encodeURIComponent(alert.subjectId)}`
        : '/fleet';
    case 'ground':
      /*
       * The Network page's Ground view (SURFACE-05), open on the contract the
       * alert is about: its station, its term and what leaving it would cost,
       * beside the vendors that could replace it. Before that view existed this
       * went to the Operations dashboard, which lists expiries but cannot act.
       */
      return alert.subjectType === 'ground_contract'
        ? `/network?view=ground&contract=${encodeURIComponent(alert.subjectId)}`
        : '/network?view=ground';
  }
}

/** Every screen a rule may name, for the guard that checks the router serves them. */
export const ALERT_SCREENS: readonly AlertScreen[] = [
  'network',
  'finance',
  'credit',
  'crew',
  'fleet',
  'ground',
];

/** A severity's glyph, so meaning survives without hue (§14.6, H.7). */
export function severityGlyph(severity: Alert['severity']): string {
  return severity === 'critical' ? '▲' : '●';
}

/** The words beside the glyph, for the same reason. */
export function severityLabel(severity: Alert['severity']): string {
  return severity === 'critical' ? 'Critical' : 'Warning';
}
