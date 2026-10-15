import { describe, expect, it } from 'vitest';

import { AcademyRefusal } from '@tailfin/shared';

import {
  academyPurposeInWords,
  blockedInWords,
  BUILD_STALLED_AFTER_GAME_MINUTES,
  buildProgressInWords,
  ceilingRows,
  confirmInWords,
  doneInWords,
  intentKey,
  isBuildStalled,
  levelUnlocksInWords,
  refusalInWords,
  type AcademyIntent,
} from './academy-presentation';
import { academies, EHAM_ID, GAME_NOW, LFPG_BASE, offer, quote } from './test-academies';

/**
 * The academies section's sentences (SURFACE-10).
 *
 * Each is a claim about a building the player is paying for; the tests hold the
 * ones a careless render would get wrong.
 */

/** Words that would present an academy as anything but cheaper and slower-to-build (§10.4). */
const POPULARITY = /demand|reputation|price tolerance|\bfares?\b|load factor|market share/i;

describe('a build on the world’s clock', () => {
  it('counts whole game days, rounded up', () => {
    expect(buildProgressInWords('2031-03-04T00:00:00.000Z', GAME_NOW)).toEqual({
      tone: 'building',
      text: 'Ready 2031-03-04, 3 game days from now.',
    });
    expect(buildProgressInWords('2031-03-02T12:00:00.000Z', GAME_NOW).text).toBe(
      'Ready 2031-03-02, 1 game day from now.',
    );
  });

  it('shows the date and nothing else before the clock has synced', () => {
    expect(buildProgressInWords('2031-03-04T00:00:00.000Z', null)).toEqual({
      tone: 'building',
      text: 'Ready 2031-03-04, world time.',
    });
  });

  it('calls a build due inside the stall threshold, and stalled past it', () => {
    const justDue = new Date(GAME_NOW.getTime() - 10 * 60_000).toISOString();
    expect(buildProgressInWords(justDue, GAME_NOW).tone).toBe('due');

    const late = new Date(
      GAME_NOW.getTime() - (BUILD_STALLED_AFTER_GAME_MINUTES + 1) * 60_000,
    ).toISOString();
    expect(isBuildStalled(late, GAME_NOW)).toBe(true);
    expect(buildProgressInWords(late, GAME_NOW).tone).toBe('stalled');
    // A clock that has not synced never claims a stall.
    expect(isBuildStalled(late, null)).toBe(false);
  });
});

describe('what a level permits', () => {
  it('says a Training Room trains no flight deck', () => {
    expect(
      ceilingRows({
        flightDeckUpTo: null,
        cabinUpTo: 'cabin_crew',
        researchTier: 1,
        trainingSlots: 5,
        slotsInUse: 0,
      }),
    ).toEqual([
      { label: 'Flight deck up to', value: 'None yet' },
      { label: 'Cabin up to', value: 'Cabin Crew' },
      { label: 'Research tier', value: 'Up to tier 1' },
      { label: 'Training slots', value: '0 of 5 in use' },
    ]);
  });

  it('describes the next level as a ceiling and never a bonus', () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const words = levelUnlocksInWords(level);
      expect(words).toMatch(/opens research tier \d/);
      expect(words).not.toMatch(/%|bonus|boost|faster|cheaper/i);
      expect(words).not.toMatch(POPULARITY);
    }
    expect(levelUnlocksInWords(5)).toMatch(/flight deck up to Training Captain/);
  });
});

describe('module offers', () => {
  it('says what blocks one in the server’s own terms', () => {
    expect(blockedInWords(offer({ kind: 'cbt_suite' }))).toBeNull();
    expect(
      blockedInWords(offer({ kind: 'fixed_base_sim', fromLevel: 3, blockedBy: 'level' })),
    ).toBe('From level 3 (Flight Academy)');
    expect(blockedInWords(offer({ kind: 'cbt_suite', blockedBy: 'under_construction' }))).toBe(
      'Being built',
    );
    expect(
      blockedInWords(
        offer({ kind: 'full_flight_sim', perFamily: true, blockedBy: 'already_built' }),
      ),
    ).toBe('Built for every family this world flies');
  });
});

describe('the confirmation', () => {
  const found: AcademyIntent = {
    kind: 'found',
    crewBaseId: LFPG_BASE,
    icao: 'LFPG',
    quote: quote(1_234_567, 5, 151_500),
  };

  it('restates the server’s quote and that money cannot hurry or undo it', () => {
    const words = confirmInWords(found);
    expect(words).toContain('$12,346 now');
    expect(words).toContain('5 game weeks');
    expect(words).toContain('$1,515 a game month');
    expect(words).toMatch(/Nothing shortens the build/);
    expect(words).toMatch(/cannot be sold or demolished/);
  });

  it('warns that an inert module teaches nothing today, and only then', () => {
    const module: AcademyIntent = {
      kind: 'module',
      academyId: EHAM_ID,
      icao: 'EHAM',
      module: 'dispatch_lab',
      family: null,
      readToday: false,
      quote: quote(5_000_000, 10, 250_000),
    };
    expect(confirmInWords(module)).toMatch(/teaches nothing today/);
    expect(confirmInWords({ ...module, module: 'cbt_suite', readToday: true })).not.toMatch(
      /teaches nothing/,
    );
  });

  it('keys a confirmation to the control that raised it', () => {
    expect(intentKey(found)).toBe(`found:${LFPG_BASE}`);
    expect(
      intentKey({
        kind: 'module',
        academyId: EHAM_ID,
        icao: 'EHAM',
        module: 'full_flight_sim',
        family: 'A320neo',
        readToday: true,
        quote: quote(1, 1, 1),
      }),
    ).toBe(`module:${EHAM_ID}:full_flight_sim`);
  });

  it('reads the promised date back out of the server’s answer', () => {
    const state = academies();
    expect(
      doneInWords(
        { kind: 'level', academyId: EHAM_ID, icao: 'EHAM', level: 3, quote: quote(1, 1, 1) },
        {
          ...state,
          academies: state.academies.map((row) =>
            row.id === EHAM_ID
              ? { ...row, pendingLevel: 3, constructionReadyAt: '2031-07-01T00:00:00.000Z' }
              : row,
          ),
        },
      ),
    ).toBe('Level 3 started at EHAM: ready 2031-07-01, world time.');
  });
});

describe('a refusal', () => {
  it('has a hint for every code in the closed set, and says nothing was charged', () => {
    for (const code of AcademyRefusal.options) {
      const words = refusalInWords({ status: 409, code, message: 'The server said no' });
      expect(words.startsWith('The server said no. ')).toBe(true);
      // A hint beyond the server's sentence, so each code has something to act on.
      expect(words.length).toBeGreaterThan('The server said no. Nothing was charged.'.length + 10);
      expect(words.endsWith('Nothing was charged and nothing changed.')).toBe(true);
    }
  });

  it('falls back to the server’s words for a code outside the set', () => {
    expect(
      refusalInWords({ status: 400, code: 'invalid_input', message: 'Malformed module' }),
    ).toBe('Malformed module. Nothing was charged and nothing changed.');
  });
});

describe('§10.4: cheaper, never more popular', () => {
  it('names the outsourced rate from the server and no in-house figure', () => {
    const words = academyPurposeInWords(219_900);
    expect(words).toContain('$2,199 a head');
    expect(words).toContain('a fraction of that');
    expect(words).not.toMatch(/\d+\s*%/);
    expect(words).not.toMatch(POPULARITY);
  });
});
