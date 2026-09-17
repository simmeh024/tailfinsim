import { deriveRng } from '../random';

/**
 * Naming a crew member (M9-03, §10.2).
 *
 * §10.2 asks for crew who cross a threshold to become *"named, tracked
 * individuals"*, and a name is the whole point of the mechanic: *"a legendary
 * Captain is a status object"*. So it has to be a name a player can say, and it
 * has to be **stable for ever** once given.
 *
 * ## Deterministic, for the reason everything else in this package is
 *
 * `deriveRng(worldSeed, 'crew-name', crewBaseId, ordinal)` — the member's own
 * stream, so the same world names the same person whatever order things
 * happened in, and a replay of a world's history produces the same roster. The
 * alternative, drawing at insert time from a global random, would make a crew
 * member one of the few things in the game that cannot be re-derived.
 *
 * It also means the **name is decided before the row is written** and does not
 * need to be, which matters for the sweep: two workers racing to name the same
 * pool cannot produce two different people, because they would draw the same
 * name from the same stream and the unique constraint refuses the second.
 *
 * ## The lists
 *
 * Deliberately multinational and deliberately short. A world's airlines are
 * global, and a roster of exclusively Anglophone names would read as an
 * oversight rather than as a choice. Short because this is flavour: 48 × 48 is
 * 2,304 combinations before a repeat matters, and a base with more named crew
 * than that has other problems.
 *
 * No titles here. A rank is a column, and gluing "Capt." onto a stored name
 * would go stale the moment somebody was promoted.
 */

/** Given names, from the regions the catalogue's airlines fly between. */
const GIVEN_NAMES: readonly string[] = [
  'Aino',
  'Amara',
  'Ana',
  'Anders',
  'Arjun',
  'Beatriz',
  'Chidi',
  'Dilan',
  'Eero',
  'Elif',
  'Emeka',
  'Farida',
  'Freya',
  'Gabriel',
  'Hana',
  'Hiroshi',
  'Ingrid',
  'Isabel',
  'Ivan',
  'Jae-won',
  'Johan',
  'Kaito',
  'Kwame',
  'Lars',
  'Leila',
  'Lucia',
  'Maarten',
  'Mateo',
  'Mei',
  'Nadia',
  'Niamh',
  'Nikolai',
  'Omar',
  'Pilar',
  'Priya',
  'Rafael',
  'Rania',
  'Rosa',
  'Sanne',
  'Siobhan',
  'Sofia',
  'Takumi',
  'Tariq',
  'Thandiwe',
  'Tomas',
  'Yara',
  'Yusuf',
  'Zofia',
];

/** Surnames, likewise. */
const SURNAMES: readonly string[] = [
  'Abiola',
  'Almeida',
  'Andersen',
  'Bakker',
  'Bergström',
  'Caldeira',
  'Chowdhury',
  'Costa',
  'Delacroix',
  'Dubois',
  'Eriksen',
  'Fernández',
  'Fitzgerald',
  'Gonçalves',
  'Halonen',
  'Hartmann',
  'Ibrahim',
  'Iversen',
  'Jansen',
  'Kaur',
  'Kimura',
  'Kowalski',
  'Laurent',
  'Lindqvist',
  'Marchetti',
  'Meijer',
  'Mensah',
  'Moreau',
  'Nakamura',
  'Novak',
  'Okafor',
  'Oyelaran',
  'Petrov',
  'Ramos',
  'Reyes',
  'Rossi',
  'Salcedo',
  'Sharma',
  'Silva',
  'Sørensen',
  'Tanaka',
  'Vargas',
  'Virtanen',
  'Wanjiru',
  'Weber',
  'Yilmaz',
  'Zhang',
  'Ziegler',
];

export const CREW_NAME_COMBINATIONS = GIVEN_NAMES.length * SURNAMES.length;

/**
 * The name for the `ordinal`-th crew member named at this base.
 *
 * `ordinal` is a per-base counter rather than a global one, so two bases naming
 * their first veteran on the same tick draw from different streams and cannot
 * collide by construction — and so a base's roster is reproducible from its own
 * history alone.
 */
export function crewNameFor(worldSeed: string, crewBaseId: string, ordinal: number): string {
  const rng = deriveRng(worldSeed, 'crew-name', crewBaseId, String(ordinal));
  const given = GIVEN_NAMES[Math.floor(rng() * GIVEN_NAMES.length)] ?? 'Alex';
  const surname = SURNAMES[Math.floor(rng() * SURNAMES.length)] ?? 'Meijer';
  return `${given} ${surname}`;
}
