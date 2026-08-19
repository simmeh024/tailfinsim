/**
 * Weather — the system §24 says four others depend on and nothing defined (M2-09).
 *
 *   `climate` — what it is normally like here in this month, from latitude alone
 *   `weather` — the day itself, drawn from those norms; the forecast that sees it
 *               through progressively worse glass; and what it does to a flight
 *
 * Feeds M2-08's disruption risk, §9.3's de-icing, and §10.2's crew difficulty
 * multiplier. It does not decide what any of them do about it.
 */
export * from './climate';
export * from './weather';
