export type Notifier = (message: string) => Promise<void>;

const TELEGRAM_LIMIT = 4096;

/** Telegram's legacy Markdown chokes on unescaped _ * ` [ in ticker names. */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*`[\]])/g, "\\$1");
}

export function createNotifier(token: string, chatId: string): Notifier {
  return async (message: string): Promise<void> => {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message.slice(0, TELEGRAM_LIMIT),
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      // Notification is a convenience. Losing it must never cost a trading run.
      console.error(`Telegram delivery failed: ${(err as Error).message}`);
    }
  };
}

export function createNullNotifier(): Notifier {
  return async (message: string) => {
    console.log(`[notify] ${message}`);
  };
}

export function notifierFromEnv(env: NodeJS.ProcessEnv = process.env): Notifier {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  return token && chatId ? createNotifier(token, chatId) : createNullNotifier();
}

export { escapeMarkdown };
