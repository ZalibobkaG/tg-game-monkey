import { RULES, monkeyCount } from './rules.js';
import { pick } from '../lib/shuffle.js';

export interface Deal {
  /** 10 действий карточки — одинаковых для всех мирных */
  actions: string[];
  monkeyUserIds: number[];
  /** все 10 номеров в случайном порядке — раунды берут их подряд */
  actionOrder: number[];
}

/**
 * Раздача. Список действий общий, обезьянки выбираются случайно,
 * порядок всех десяти номеров фиксируется заранее — чтобы не повторялись.
 * Играем до победы, поэтому потолок раундов равен размеру карточки.
 */
export function deal(deckActions: string[], userIds: number[]): Deal {
  if (deckActions.length < RULES.cardSize) {
    throw new Error(`В колоде ${deckActions.length} действий, нужно минимум ${RULES.cardSize}`);
  }
  const indices = Array.from({ length: RULES.cardSize }, (_, i) => i);
  return {
    actions: pick(deckActions, RULES.cardSize),
    monkeyUserIds: pick(userIds, monkeyCount(userIds.length)),
    actionOrder: pick(indices, RULES.cardSize),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── разбор голосования ───────────────────────────────────────────────────

export type Ballot =
  /** ничья на первом туре — переголосование между лидерами */
  | { kind: 'revote'; leaders: number[] }
  /** ничья и на переголосовании — никого не поймали */
  | { kind: 'tie' }
  /** есть единственный лидер */
  | { kind: 'accused'; userId: number };

/**
 * Состоялся ли бюллетень. Воздержаться можно, но если промолчало большинство,
 * решение принимать не с чего: одного голоса хватило бы, чтобы указать
 * на человека, и раскрытие роли по такому «решению» — чистая случайность.
 */
export function hasQuorum(votesCast: number, alivePlayers: number): boolean {
  return votesCast * 2 >= alivePlayers;
}

/** Кто набрал большинство. `isRevote` меняет исход ничьей. */
export function resolveBallot(votes: Map<number, number>, isRevote: boolean): Ballot {
  if (votes.size === 0) return { kind: 'tie' };

  const counts = new Map<number, number>();
  for (const target of votes.values()) counts.set(target, (counts.get(target) ?? 0) + 1);

  const top = Math.max(...counts.values());
  const leaders = [...counts.entries()].filter(([, n]) => n === top).map(([userId]) => userId);

  if (leaders.length === 1) return { kind: 'accused', userId: leaders[0]! };
  return isRevote ? { kind: 'tie' } : { kind: 'revote', leaders };
}
