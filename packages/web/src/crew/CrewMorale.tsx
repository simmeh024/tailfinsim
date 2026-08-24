import type { CrewBaseMorale, CrewResponse, HotelTierValue, PayBandValue } from '@tailfin/shared';

import type { ReactNode } from 'react';

/**
 * How each base feels, and why (M5-03, §9.2).
 *
 * ## Itemised, because a mood the player cannot argue with is a bug
 *
 * M5-03's second acceptance criterion asks for morale *"shown per base with its
 * contributing factors itemised"*, and the reason is §9.2's third word:
 * cost-cutting has a **visible** bill. A base losing crew with nothing on screen
 * explaining why reads as the game being arbitrary — and a player who concludes
 * that stops making the decision the mechanic exists to offer.
 *
 * So every factor gets a bar and a sentence, and the weighted values sum to the
 * target exactly. The bar is never the only reading: the sentence beside it says
 * what the player chose or what happened to the crew.
 *
 * ## Two numbers, and the gap between them is the point
 *
 * `score` is where morale is; `target` is where it is heading. They differ
 * whenever a policy has changed recently, and showing only the first would hide
 * the one thing the player can act on — while showing only the second would
 * promise a consequence that has not arrived. §9.2 asks for a *delayed* bill;
 * this is where the delay becomes legible.
 */

export interface CrewMoraleProps {
  crew: CrewResponse;
  busy: boolean;
  onSetPolicies: (input: {
    crewBaseId: string;
    payBand?: PayBandValue;
    hotelTier?: HotelTierValue;
  }) => void;
}

const PAY_LABEL: Record<PayBandValue, string> = {
  lean: 'Lean',
  market: 'Market',
  generous: 'Generous',
};

const HOTEL_LABEL: Record<HotelTierValue, string> = {
  budget: 'Budget',
  standard: 'Standard',
  premium: 'Premium',
};

const FACTOR_LABEL: Record<CrewBaseMorale['factors'][number]['factor'], string> = {
  pay: 'Pay',
  rosterStability: 'Rosters',
  hotel: 'Hotels',
  rest: 'Rest',
};

export function CrewMorale({ crew, busy, onSetPolicies }: CrewMoraleProps): ReactNode {
  const bases = crew.bases.filter((base) => base.morale !== null);

  return (
    <section className="crew-panel" aria-labelledby="crew-morale-heading">
      <div className="crew-panel__head">
        <h2 className="crew-panel__title" id="crew-morale-heading">
          Morale
        </h2>
        <p className="crew-panel__sub">What each base thinks of you</p>
      </div>

      {bases.length === 0 ? (
        <p className="crew__note">
          No open crew bases yet. Morale is felt per base, so there is nowhere for it to be.
        </p>
      ) : (
        bases.map((base) => {
          const morale = base.morale;
          if (morale === null) return null;
          return (
            <article className="crew-morale" key={base.id}>
              <header className="crew-morale__head">
                <h3 className="crew-morale__base figure">{base.airportIcao}</h3>
                <p className="crew-morale__score" data-mood={moodOf(morale.score)}>
                  <span className="figure">{Math.round(morale.score * 100)}%</span>
                  <span className="crew-morale__mood">{MOOD_LABEL[moodOf(morale.score)]}</span>
                </p>
              </header>

              <p className="crew-morale__trend">
                {trendSentence(morale)}
                {morale.reviewedAt === null && ' Not yet reviewed.'}
              </p>

              {/*
               * The itemisation. A table because it is genuinely tabular — four
               * named things with a number each — and because a screen reader
               * then reads "Pay, Lean pay band, 10%" rather than a soup of
               * adjacent spans.
               */}
              <table className="crew-morale__factors">
                <caption className="visually-hidden">
                  What morale at {base.airportIcao} is made of
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Factor</th>
                    <th scope="col">What it is</th>
                    <th scope="col">Contribution</th>
                  </tr>
                </thead>
                <tbody>
                  {morale.factors.map((factor) => (
                    <tr key={factor.factor}>
                      <th scope="row">{FACTOR_LABEL[factor.factor]}</th>
                      <td>{factor.detail}</td>
                      <td className="crew-morale__bar-cell">
                        <span className="crew-morale__bar" aria-hidden="true">
                          {/*
                           * Width is the weighted share of the whole, so the
                           * four bars together are the score. A bar scaled to
                           * each factor's own maximum would look like four
                           * unrelated ratings.
                           */}
                          <span
                            className="crew-morale__fill"
                            style={{ width: `${String(Math.round(factor.weighted * 100))}%` }}
                          />
                        </span>
                        <span className="figure">{Math.round(factor.weighted * 100)}</span>
                      </td>
                    </tr>
                  ))}
                  <tr className="crew-morale__total">
                    <th scope="row">Target</th>
                    <td>Where morale is heading</td>
                    <td className="crew-morale__bar-cell">
                      <span className="figure">{Math.round(morale.target * 100)}</span>
                    </td>
                  </tr>
                </tbody>
              </table>

              <div className="crew-morale__policies">
                <label>
                  Pay band
                  <select
                    value={morale.payBand}
                    disabled={busy}
                    onChange={(event) => {
                      onSetPolicies({
                        crewBaseId: base.id,
                        payBand: event.target.value as PayBandValue,
                      });
                    }}
                  >
                    {(Object.keys(PAY_LABEL) as PayBandValue[]).map((band) => (
                      <option key={band} value={band}>
                        {PAY_LABEL[band]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Hotels
                  <select
                    value={morale.hotelTier}
                    disabled={busy}
                    onChange={(event) => {
                      onSetPolicies({
                        crewBaseId: base.id,
                        hotelTier: event.target.value as HotelTierValue,
                      });
                    }}
                  >
                    {(Object.keys(HOTEL_LABEL) as HotelTierValue[]).map((tier) => (
                      <option key={tier} value={tier}>
                        {HOTEL_LABEL[tier]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <p className="crew__hint">
                Changing a band moves the target now and the score over the following weeks. Paying
                less is a real saving and a real risk — crew who stay unhappy call in sick, and then
                they leave.
              </p>
            </article>
          );
        })
      )}
    </section>
  );
}

type Mood = 'poor' | 'fair' | 'good';

function moodOf(score: number): Mood {
  if (score < 0.4) return 'poor';
  if (score < 0.7) return 'fair';
  return 'good';
}

/** Colour is never the only signal (App. H.7), so the mood is a word too. */
const MOOD_LABEL: Record<Mood, string> = {
  poor: 'Unhappy',
  fair: 'Getting by',
  good: 'Content',
};

/**
 * Where morale is going, in a sentence.
 *
 * A 1% band around the target counts as settled: a base sitting a fraction below
 * its target for ever is not *falling*, and saying so every week would train the
 * player to ignore the line.
 */
function trendSentence(morale: CrewBaseMorale): string {
  const gap = morale.target - morale.score;
  if (Math.abs(gap) < 0.01) return 'Settled at its target.';
  const direction = gap > 0 ? 'Rising toward' : 'Falling toward';
  return `${direction} ${String(Math.round(morale.target * 100))}%.`;
}
