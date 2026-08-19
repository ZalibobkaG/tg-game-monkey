import type { Context } from 'grammy';
import type { User } from './repo/users.js';

export interface BotContext extends Context {
  /** Заполняется middleware для любого апдейта с ctx.from */
  user: User;
}
