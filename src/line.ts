import { type Env, type Runtime, limitedBytes } from './environment.ts';
import { type EventContext, type ReplyGuard, reserveReply } from './store.ts';

const LINE = 'https://api.line.me/v2/bot';

export async function sendReply(env: Env, runtime: Runtime, event: EventContext, text: string, deadline: number, guard: ReplyGuard = {}) {
  if (!event.replyToken || runtime.now() >= deadline) return false;
  if (!await reserveReply(env.DB,event,guard)) return false;
  const remaining = deadline - runtime.now();
  if (remaining <= 0) return false;
  try {
    const result = await runtime.fetcher(LINE + '/message/reply', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(Math.min(3000, remaining)),
      headers: lineHeaders(env),
      body: JSON.stringify({ replyToken: event.replyToken, messages: [{ type: 'text', text }] }),
    });
    return result.ok;
  } catch {
    return false;
  }
}

export function lineHeaders(env: Env) {
  return { Authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN, 'Content-Type': 'application/json' };
}

export const lineBase = LINE;

export async function getImage(env: Env, runtime: Runtime, id: string, deadline: number) {
  const remaining = deadline - runtime.now();
  if (!/^\d{1,32}$/.test(id) || remaining <= 0) return null;
  try {
    const response = await runtime.fetcher(`https://api-data.line.me/v2/bot/message/${id}/content`, {
      headers: lineHeaders(env), redirect: 'manual', signal: AbortSignal.timeout(Math.min(6000, remaining)),
    });
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!response.ok || (mime !== 'image/jpeg' && mime !== 'image/png') ||
        Number(response.headers.get('content-length')) > 5_000_000) return null;
    const bytes = await limitedBytes(response.body, 5_000_000);
    return bytes ? { bytes, mime } : null;
  } catch {
    return null;
  }
}
