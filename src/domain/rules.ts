/** Правила игры — единственный источник истины по числам. */
export const RULES = {
  minPlayers: 3,
  maxPlayers: 15,
  /** начиная с этого числа игроков — две обезьянки */
  twoMonkeysFrom: 12,
  /** сколько действий в карточке; оно же потолок раундов — номера не повторяются */
  cardSize: 10,
  /** как часто запускать голосование: каждый раунд / каждые два / каждые три */
  voteEveryOptions: [1, 2, 3] as const,
  defaultVoteEvery: 1,
  countdownSeconds: 3,
} as const;

export const maxRounds = RULES.cardSize;

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

export function voteEveryLabel(n: number): string {
  if (n <= 1) return 'после каждого раунда';
  return n === 2 ? 'каждые 2 раунда' : `каждые ${n} раунда`;
}
