// One Telegram line per agent run (design §WS3: a run sends at most one summary message).
// Mirrors cadastre-data/api/src/lib/telegram.js: no-op with a warning when the bot vars are unset,
// never throws, so a messaging failure can never be what fails a run.

const MAX_MESSAGE_CHARS = 4000; // Telegram's own limit is 4096; leave room for the chunk marker.

function chunk(text, size) {
    const parts = [];
    for (let offset = 0; offset < text.length; offset += size) {
        parts.push(text.slice(offset, offset + size));
    }
    return parts;
}

/**
 * Send a plain-text Telegram message, split across messages when it is too long.
 *
 * @param {string} text
 * @param {{ fetchImpl?: Function, env?: object }} [options]
 * @returns {Promise<boolean>} true when every chunk was accepted
 */
export async function sendTelegram(text, { fetchImpl, env = process.env } = {}) {
    const token = env?.TELEGRAM_BOT_TOKEN;
    const chatId = env?.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.warn('[telegram] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — skipping message');
        return false;
    }
    const message = typeof text === 'string' ? text : String(text ?? '');
    if (message.trim() === '') {
        console.warn('[telegram] empty message — skipping');
        return false;
    }
    const send = fetchImpl || globalThis.fetch;
    if (typeof send !== 'function') {
        console.error('[telegram] no fetch implementation available — skipping message');
        return false;
    }

    let ok = true;
    for (const part of chunk(message, MAX_MESSAGE_CHARS)) {
        try {
            const res = await send(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: part })
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                console.error(`[telegram] sendMessage failed: ${res.status} ${body}`);
                ok = false;
            }
        } catch (err) {
            console.error('[telegram] sendMessage error:', err?.message || err);
            ok = false;
        }
    }
    return ok;
}
