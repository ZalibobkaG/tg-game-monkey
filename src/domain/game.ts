import { RULES, monkeyCount } from './rules.js';
import { pick } from '../lib/shuffle.js';

export interface Deal {
  /** 10 действий карточки — одинаковых для всех мирных */
  actions: string[];
  monkeyUserIds: number[];
  /** индексы действий по раундам, без повторов внутри игры */
  actionOrder: number[];
}

/**
 * Раздача. Список действий общий, обезьянки выбираются случайно,
 * порядок раундов фиксируется заранее — чтобы номера не повторялись.
 */
export function deal(deckActions: string[], userIds: number[], roundsCount: number): Deal {
  if (deckActions.length < RULES.cardSize) {
    throw new Error(`В колоде ${deckActions.length} действий, нужно минимум ${RULES.cardSize}`);
  }
  const indices = Array.from({ length: RULES.cardSize }, (_, i) => i);
  return {
    actions: pick(deckActions, RULES.cardSize),
    monkeyUserIds: pick(userIds, monkeyCount(userIds.length)),
    actionOrder: pick(indices, Math.min(roundsCount, RULES.cardSize)),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
