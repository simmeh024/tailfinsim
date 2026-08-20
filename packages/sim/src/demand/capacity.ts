/**
 * Demand is not bookings (M3-05, App. A.5).
 *
 * A.3–A.4 decided who each passenger *wants* to fly with. This decides who
 * actually gets a seat, and what happens to the ones who do not.
 *
 * ```
 * 1. Booked(i)  = min( Demand(i), Seats(i) )
 * 2. Spill      = Σ max( 0, Demand(i) − Seats(i) )
 * 3. Redistribute Spill across operators with remaining seats,
 *    using shares re-normalised over that subset
 * 4. Repeat once. Any remaining spill is lost demand (not carried over).
 * ```
 *
 * ## Two passes, on purpose
 *
 * A.5 is explicit — *"two passes, not convergence to a fixed point — cheap and
 * close enough"* — and that is a design decision rather than an optimisation to
 * be improved on later.
 *
 * Iterating to a fixed point would mean a full aircraft's spill cascading
 * through every competitor until the market cleared, which is both more
 * expensive and less true: a passenger who cannot get their first choice looks
 * at the alternatives once, and if the good ones are also full they do not keep
 * hunting down the list. Two passes models exactly that, and the third-pass
 * demand is deliberately **lost rather than carried over** — A.5 again. Nobody
 * books tomorrow's flight because today's was full; they take the train.
 *
 * {@link CAPACITY_PASSES} is the number, and the tests assert that demand which
 * would only be absorbed on a third pass stays lost. That is the property a
 * well-meaning "just loop until it converges" change would break.
 *
 * ## Why spill is worth surfacing
 *
 * A.5 makes the point that this is not bookkeeping:
 *
 * > *"Spill is a real strategic signal. A route where you consistently spill is
 * > a route where you should upgauge or add frequency, and the game should
 * > surface it as 'you turned away 40 passengers a day.'"*
 *
 * So the result keeps the two apart. **Recaptured** passengers were somebody
 * else's spill that you picked up; **spilled** passengers were yours that you
 * turned away. An operator can do both at once, and adding them together would
 * destroy the only two numbers a player can act on.
 *
 * ## Fractions stay fractions
 *
 * The logit allocates fractional passengers and so does this. Rounding here and
 * then dividing the result across a day's departures would compound the error
 * twice; the rounding belongs at the point a specific flight is loaded, which
 * is M3-08's booking curve. `flight_result.passengers` is the integer.
 */

/** A.5 runs the allocation twice. Not a tuning knob — see the module note. */
export const CAPACITY_PASSES = 2;

export interface CapacityOperator {
  id: string;
  /** Passengers who want this operator, from A.4's share model. */
  demand: number;
  /** Seats on offer across the period the demand covers. */
  seats: number;
  /**
   * The operator's share of this market, used to re-normalise the redistribution.
   *
   * A.5 says spill is redistributed *"using shares re-normalised over that
   * subset"*, so the same shares A.4 produced come back in here rather than
   * spill being split evenly. A passenger denied their first choice falls back
   * on the market's preferences, not on a coin toss.
   */
  share: number;
}

export interface OperatorCapacity {
  operatorId: string;
  demand: number;
  seats: number;
  /** Passengers who wanted this operator and got a seat. */
  bookedOwn: number;
  /** Passengers who wanted somebody else, could not get on, and took this instead. */
  recaptured: number;
  /** `bookedOwn + recaptured`, and what actually flies. */
  booked: number;
  /**
   * Passengers this operator wanted to carry and could not.
   *
   * The number A.5 asks the game to show. It counts passengers turned away from
   * *this* operator, whether or not a competitor picked them up — a route where
   * you spill is a route to upgauge even if the market did not lose the traffic.
   */
  spilled: number;
  /** Seats left after everything. */
  emptySeats: number;
  /** Booked ÷ seats, or 0 when there are no seats. */
  loadFactor: number;
}

export interface CapacityResult {
  operators: readonly OperatorCapacity[];
  /** Everything anybody wanted, before capacity. */
  totalDemand: number;
  /** Everything that actually flew. */
  totalBooked: number;
  /** Turned away at the first pass, summed across operators. */
  totalSpilled: number;
  /** Spill a competitor absorbed on the second pass. */
  totalRecaptured: number;
  /**
   * Demand nobody could carry, and which does not come back.
   *
   * The market's loss rather than any one airline's — this is the number that
   * says a route is under-served in total, as opposed to under-served by you.
   */
  lostDemand: number;
}

function validate(operators: readonly CapacityOperator[]): void {
  const seen = new Set<string>();
  for (const o of operators) {
    if (seen.has(o.id)) {
      throw new Error(`Duplicate operator ${o.id} in the same market`);
    }
    seen.add(o.id);

    if (!Number.isFinite(o.demand) || o.demand < 0) {
      throw new Error(`Operator ${o.id} demand must be zero or more, got ${String(o.demand)}`);
    }
    if (!Number.isFinite(o.seats) || o.seats < 0) {
      throw new Error(`Operator ${o.id} seats must be zero or more, got ${String(o.seats)}`);
    }
    if (!Number.isFinite(o.share) || o.share < 0) {
      throw new Error(`Operator ${o.id} share must be zero or more, got ${String(o.share)}`);
    }
  }
}

/**
 * Turn demand into bookings, and say what was turned away (A.5).
 *
 * Pure and deterministic like everything else here: the same market always
 * clears the same way.
 */
export function allocateCapacity(operators: readonly CapacityOperator[]): CapacityResult {
  validate(operators);

  const booked = new Map<string, number>();
  const recaptured = new Map<string, number>();
  for (const o of operators) {
    booked.set(o.id, 0);
    recaptured.set(o.id, 0);
  }

  // ---- Pass 1: everyone books their own demand, up to capacity. -----------
  let spill = 0;
  const spilledBy = new Map<string, number>();

  for (const o of operators) {
    const taken = Math.min(o.demand, o.seats);
    booked.set(o.id, taken);
    const turnedAway = o.demand - taken;
    spilledBy.set(o.id, turnedAway);
    spill += turnedAway;
  }

  const firstPassSpill = spill;

  // ---- Pass 2: one redistribution across whoever still has room. ---------
  //
  // One, not "until it settles". See the module note — the third-pass demand is
  // lost by design, not by an unfinished loop.
  if (spill > 0) {
    const withRoom = operators.filter((o) => o.seats - (booked.get(o.id) ?? 0) > 0);
    const shareTotal = withRoom.reduce((sum, o) => sum + o.share, 0);

    if (withRoom.length > 0 && shareTotal > 0) {
      let absorbed = 0;

      for (const o of withRoom) {
        const room = o.seats - (booked.get(o.id) ?? 0);
        // Re-normalised over the subset with room, so the split follows the
        // market's remaining preferences rather than being shared out evenly.
        const offered = spill * (o.share / shareTotal);
        const taken = Math.min(offered, room);

        recaptured.set(o.id, taken);
        booked.set(o.id, (booked.get(o.id) ?? 0) + taken);
        absorbed += taken;
      }

      spill -= absorbed;
    }
  }

  const rows: OperatorCapacity[] = operators.map((o) => {
    const total = booked.get(o.id) ?? 0;
    const gained = recaptured.get(o.id) ?? 0;
    return {
      operatorId: o.id,
      demand: o.demand,
      seats: o.seats,
      bookedOwn: total - gained,
      recaptured: gained,
      booked: total,
      spilled: spilledBy.get(o.id) ?? 0,
      emptySeats: o.seats - total,
      loadFactor: o.seats === 0 ? 0 : total / o.seats,
    };
  });

  const totalRecaptured = rows.reduce((sum, r) => sum + r.recaptured, 0);

  return {
    operators: rows,
    totalDemand: operators.reduce((sum, o) => sum + o.demand, 0),
    totalBooked: rows.reduce((sum, r) => sum + r.booked, 0),
    totalSpilled: firstPassSpill,
    totalRecaptured,
    // What the market could not carry at all. Not the same as `totalSpilled`,
    // which counts passengers a competitor may well have picked up.
    lostDemand: spill,
  };
}
