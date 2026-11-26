import type { Api } from 'grammy';
import { config } from '../config.js';
import { log } from '../lib/log.js';

/**
 * Кнопка-меню в чате с ботом — та, что слева от поля ввода. Ставим её на
 * старте, а не руками в @BotFather: адрес мини-аппа меняется вместе с
 * туннелем, и держать его в двух местах — верный способ однажды открыть
 * вчерашний туннель.
 *
 * Права `web_app` требуют https: Telegram просто не откроет http://localhost.
 */
export async function setupMiniApp(api: Api): Promise<void> {
  if (config.webapp.devTgId) {
    log.warn(
      { devTgId: config.webapp.devTgId },
      '⚠️ WEBAPP_DEV_TG_ID задан: API мини-аппа пускает без подписи Telegram. Только для разработки!',
    );
  }
  if (!config.webapp.url || !config.webapp.menuButton) return;

  if (!config.webapp.url.startsWith('https://')) {
    log.warn({ url: config.webapp.url }, '🪟 WEBAPP_URL не https — Telegram такой мини-апп не откроет');
    return;
  }

  try {
    await api.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: 'Играть',
        web_app: { url: config.webapp.url },
      },
    });
    log.info({ url: config.webapp.url }, '🪟 кнопка-меню мини-аппа поставлена');
  } catch (e) {
    log.error({ err: e }, 'не смог поставить кнопку-меню мини-аппа');
  }
}
