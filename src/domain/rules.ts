/** Правила игры — единственный источник истины по числам. */
export const RULES = {
  minPlayers: 4,
  maxPlayers: 15,
  /** начиная с этого числа игроков — две обезьянки */
  twoMonkeysFrom: 12,
  /** сколько действий в карточке */
  cardSize: 10,
  roundsOptions: [3, 5, 7] as const,
  defaultRounds: 5,
  /** сколько секунд карточка остаётся открытой после нажатия «Показать» */
  cardRevealSeconds: 5,
  countdownSeconds: 3,
  points: {
    /** обезьянке, если её не нашли */
    monkeySurvived: 3,
    /** каждому, кто верно указал обезьянку */
    correctVote: 1,
    /** обезьянке за каждый ошибочный голос */
    monkeyPerWrongVote: 1,
  },
} as const;

export function monkeyCount(players: number): number {
  return players >= RULES.twoMonkeysFrom ? 2 : 1;
}

export function canStart(players: number): { ok: true } | { ok: false; reason: string } {
  if (players < RULES.minPlayers) {
    return { ok: false, reason: `Нужно минимум ${RULES.minPlayers} игрока, сейчас ${players}` };
  }
  if (players > RULES.maxPlayers) {
    return { ok: false, reason: `Максимум ${RULES.maxPlayers} игроков, сейчас ${players}` };
  }
  return { ok: true };
}
