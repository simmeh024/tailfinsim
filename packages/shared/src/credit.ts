import { z } from 'zod';

import { MinorUnits, Timestamp, Uuid } from './primitives';

/**
 * Loans, credit tiers and borrowing capacity (M8-06, design doc §13).
 *
 * §13's brief is one sentence and the whole design follows from it:
 *
 * > **Loans support, they never carry.**
 *
 * A loan should let a profitable airline move faster. It must never let an
 * unprofitable airline keep existing. §13.1 makes that mechanical rather than a
 * rule anyone has to remember:
 *
 * ```
 * MaxTotalDebt = min( tierCap, 3.0 × trailing 12-month operating profit,
 *                     0.60 × tangible asset value )
 * ```
 *
 * > If you're losing money, `3.0 × operating profit` is zero or negative. **You
 * > cannot borrow at all.** No special-case rule needed — the formula does it.
 *
 * That is worth dwelling on, because it is the reason there is no "are you in
 * trouble?" check anywhere in this subsystem. The airlines that most want to
 * borrow their way out are the ones the arithmetic has already excluded.
 *
 * ## What is identity here, and what is balance
 *
 * The **tiers** and the **instruments** are identity: which rungs exist, what
 * they are called, what an instrument is secured on. Every number — each tier's
 * cap, rate and term, the 3.0 and the 0.60, the 1.25 DSCR floor, the instrument
 * rate deltas, the founder facility's $250K — is balance and lives in
 * `EconomyConfig.credit`, versioned and pinned per world like everything else.
 */

/**
 * §13.2's six rungs, weakest first.
 *
 * `startup` is not a rung an airline earns — it is where every airline begins,
 * and it is the **founder facility**: exempt from the profit test, capped small,
 * priced high, and personally guaranteed against the airline. Every other tier
 * is earned from demonstrated trading.
 */
export const CreditTier = z.enum(['startup', 'D', 'C', 'B', 'A', 'AA']);
export type CreditTier = z.infer<typeof CreditTier>;

/** Weakest to strongest — the order a rating moves along. */
export const CREDIT_TIERS: readonly CreditTier[] = CreditTier.options;

/** How far up the ladder a tier sits. `startup` is 0. */
export function creditTierRank(tier: CreditTier): number {
  return CREDIT_TIERS.indexOf(tier);
}

/**
 * §13.3's instruments, less the bond issue the issue puts out of scope.
 *
 * The rate differences are the design: an unsecured line is dear *on purpose*
 * because it funds a cash-flow gap rather than an asset, and aircraft finance is
 * the cheapest money in the game precisely because the bank can take the
 * aeroplane back.
 *
 * ## Sale-leaseback is in §13.3's table and is not here
 *
 * It is not a loan. It sells an owned aeroplane for cash and leases it back —
 * raising capital without creating debt, which is exactly why §13.3 calls it
 * *"the classic desperation move"*: it is the one option still open to an airline
 * whose borrowing capacity is zero.
 *
 * Modelling it needs the fleet to carry a **lease obligation on an airframe**,
 * and today it cannot: a lease rate lives on the `aircraft_order` a leased
 * airframe was delivered from, so converting an owned airframe would mean either
 * a synthetic order row or a new column on `airframe`. That is a fleet decision
 * about how leases are held, and taking it inside a credit issue would be
 * deciding it in the wrong place. M8-06 ships the three instruments that *are*
 * borrowing; sale-leaseback wants its own change.
 */
export const LoanInstrument = z.enum(['working_capital', 'aircraft_finance', 'facility']);
export type LoanInstrument = z.infer<typeof LoanInstrument>;

export const LOAN_INSTRUMENTS: readonly LoanInstrument[] = LoanInstrument.options;

/** What each instrument is secured on — §13.3's second column, as identity. */
export const LOAN_SECURITY: Readonly<Record<LoanInstrument, 'none' | 'airframe' | 'facility'>> = {
  working_capital: 'none',
  aircraft_finance: 'airframe',
  facility: 'facility',
};

/** A loan's life. Repayment and default are M8-07's; this is what M8-06 writes. */
export const LoanStatus = z.enum(['active', 'repaid', 'defaulted']);
export type LoanStatus = z.infer<typeof LoanStatus>;

/**
 * §13.5's ladder, in order (M8-07).
 *
 * > Missed payment → rating drop → refinancing at worse rates → **covenant
 * > breach** → lender takes control.
 *
 * And the last line of §13.5, which constrains every stage below it:
 *
 * > **Recoverable, not run-ending.** Losing your airline outright to a bad loan
 * > would push players away from the entire system, which defeats the point of
 * > having it.
 *
 * So `administration` is not the end. It is the bottom, and an airline comes out
 * of it holding its airline with a wrecked rating — which is a punishment a
 * player can play out of, unlike a deleted save.
 */
export const DefaultStage = z.enum([
  'none',
  'warning',
  'restriction',
  'forced_disposal',
  'repossession',
  'administration',
]);
export type DefaultStage = z.infer<typeof DefaultStage>;

/** The ladder in order, so a stage can be advanced without a switch. */
export const DEFAULT_STAGES: readonly DefaultStage[] = DefaultStage.options;

/** How far down the ladder a stage sits. `none` is 0. */
export function defaultStageRank(stage: DefaultStage): number {
  return DEFAULT_STAGES.indexOf(stage);
}

/**
 * The stages at which §13.5 stops the airline doing things.
 *
 * > **Restriction** — no new routes, no new aircraft, no dividends.
 *
 * From `restriction` down, and it stays in force through every stage below —
 * an airline in administration is not less restricted than one merely warned.
 */
export function isRestricted(stage: DefaultStage): boolean {
  return defaultStageRank(stage) >= defaultStageRank('restriction');
}

/** Which of §13.1's three limits is actually binding — the one worth showing. */
export const BorrowingConstraint = z.enum(['tier_cap', 'profit_multiple', 'asset_advance']);
export type BorrowingConstraint = z.infer<typeof BorrowingConstraint>;

/* ---- The wire -------------------------------------------------------------- */

/** §13.5's ladder as the client sees it — the state, and what it costs the airline. */
export const DefaultStanding = z
  .object({
    stage: DefaultStage,
    /** Game time the current rung began. Null in good standing. */
    stageEnteredAt: Timestamp.nullable(),
    /**
     * Game time the arrears must be cleared by to avoid the next rung.
     *
     * Null in good standing, and also null at `administration` — there is no
     * next rung, so nothing is counting down. A UI must not read that null as
     * *"cured"*; `stage` is the state, this is only the deadline.
     */
    cureByAt: Timestamp.nullable(),
    /** Interest charged and unpaid across every loan. Zero clears the ladder. */
    arrearsMinor: MinorUnits.nonnegative(),
    /** §13.5 rung 2 and below: no new routes, no new aircraft. */
    restricted: z.boolean(),
    /** What is happening and what clears it, in plain words. Null in good standing. */
    message: z.string().nullable(),
    /** What one game day of interest costs across the whole book (§13.4). */
    dailyInterestMinor: MinorUnits.nonnegative(),
  })
  .strict();
export type DefaultStanding = z.infer<typeof DefaultStanding>;

/** One outstanding loan, as the client sees it. */
export const LoanView = z
  .object({
    id: Uuid,
    instrument: LoanInstrument,
    principalMinor: MinorUnits.positive(),
    /** Still owed. The principal; M8-07 charges interest on it but does not amortise it. */
    outstandingMinor: MinorUnits.nonnegative(),
    /** Interest charged that the airline could not pay — what the ladder watches (§13.5). */
    arrearsMinor: MinorUnits.nonnegative(),
    /** Game day interest has been charged up to. Null on a loan no sweep has reached. */
    interestAccruedThroughAt: Timestamp.nullable(),
    /** What one more game day of this loan costs at today's balance (§13.4). */
    dailyInterestMinor: MinorUnits.nonnegative(),
    /** Annual rate in basis points — 1400 is §13.2's 14% startup rate. */
    annualRateBps: z.number().int().nonnegative(),
    termMonths: z.number().int().positive(),
    /** The tier the airline held when it drew — a loan keeps the price it was written at. */
    tierAtDraw: CreditTier,
    status: LoanStatus,
    /** Game time, like every other in-world instant (ADR-0026). */
    drawnAt: Timestamp,
    /** The airframe a secured loan is written against, when there is one. */
    securedAirframeId: Uuid.nullable(),
  })
  .strict();
export type LoanView = z.infer<typeof LoanView>;

/** `GET /api/credit` — what this airline may borrow, and why not more. */
export const CreditStandingResponse = z
  .object({
    tier: CreditTier,
    /** The tier the airline's trading currently earns, before hysteresis. */
    earnedTier: CreditTier,
    annualRateBps: z.number().int().nonnegative(),
    termMonths: z.number().int().positive(),

    /** §13.1's three limits, each in minor units, so a UI can show what binds. */
    limits: z
      .object({
        tierCapMinor: MinorUnits.nonnegative(),
        profitMultipleMinor: MinorUnits.nonnegative(),
        assetAdvanceMinor: MinorUnits.nonnegative(),
      })
      .strict(),
    maxTotalDebtMinor: MinorUnits.nonnegative(),
    outstandingDebtMinor: MinorUnits.nonnegative(),
    /** What is left to draw. Zero when the airline is at or over its cap. */
    headroomMinor: MinorUnits.nonnegative(),
    bindingConstraint: BorrowingConstraint,

    /** §13.1's coverage test. Null when nothing is owed, so there is nothing to cover. */
    dscr: z.number().nullable(),
    minimumDscr: z.number(),
    /** Whether the airline may draw at all right now, and the plain reason if not. */
    canBorrow: z.boolean(),
    refusal: z.string().nullable(),

    /** The trading the assessment read, so the number is inspectable. */
    trailing: z
      .object({
        operatingProfitMinor: z.number().int(),
        ebitdaMinor: z.number().int(),
        tangibleAssetValueMinor: MinorUnits.nonnegative(),
        annualDebtServiceMinor: MinorUnits.nonnegative(),
        profitableMonths: z.number().int().nonnegative(),
        routes: z.number().int().nonnegative(),
        hubs: z.number().int().nonnegative(),
      })
      .strict(),

    /** §13.5's ladder: where the airline stands, and what it has to do about it. */
    standing: DefaultStanding,

    loans: z.array(LoanView),
  })
  .strict();
export type CreditStandingResponse = z.infer<typeof CreditStandingResponse>;

/** `POST /api/credit/loans` — draw one. */
export const DrawLoanRequest = z
  .object({
    instrument: LoanInstrument,
    principalMinor: MinorUnits.positive(),
    /** Required for `aircraft_finance`; the airframe the bank can repossess. */
    securedAirframeId: Uuid.optional(),
  })
  .strict();
export type DrawLoanRequest = z.infer<typeof DrawLoanRequest>;
