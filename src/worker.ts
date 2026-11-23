import { DAY, MINUTE, jstDate, parseCommand, shiftDate } from './domain.ts';
import { type Env, type Runtime, digest, hmacKey, identifier, limitedBytes, runtime } from './environment.ts';
import { sendReply } from './line.ts';
import { cancelPhoto, claimPhoto, finishPhoto, recognizePhoto, startPhoto } from './photo-session.ts';
import { historyText, readHistory, recommend, simpleRecommendation } from './recommendations.ts';
import { runSchedule } from './scheduled.ts';
import { type EventContext, changeMeal, changeMembership, eventInsert, getGroup, unsend } from './store.ts';

interface LineEvent {
  type: string;
  webhookEventId: string;
  timestamp: number;
  mode?: string;
  source?: { type: string; groupId?: string; userId?: string };
  replyToken?: string;
  message?: { id: string; type: string; text?: string; contentProvider?: { type?: string } };
  unsend?: { messageId: string };
}

const priority = (type: string) => ['memberJoined','memberLeft','leave','join'].includes(type) ? 0 : type === 'unsend' ? 1 : 2;

function validEvent(value: unknown): value is LineEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<LineEvent>;
  if (typeof event.type !== 'string' || typeof event.webhookEventId !== 'string' || !event.webhookEventId ||
    typeof event.timestamp !== 'number' || !Number.isSafeInteger(event.timestamp) || event.timestamp < 0) return false;
  if (event.type === 'message') return typeof event.message?.id === 'string' && typeof event.message?.type === 'string' &&
    (event.message.type !== 'text' || typeof event.message.text === 'string');
  return event.type !== 'unsend' || typeof event.unsend?.messageId === 'string';
}

const acknowledgement = (status: number) => new Response(null, { status });

async function signatureValid(env: Env, header: string | null, body: Uint8Array<ArrayBuffer>) {
  if (!header || !/^[A-Za-z0-9+/]{43}=$/.test(header)) return false;
  const bytes = Uint8Array.from(atob(header), char => char.charCodeAt(0));
  return crypto.subtle.verify('HMAC', await hmacKey(env.LINE_CHANNEL_SECRET), bytes, body);
}

function changeMessage(result: string, date: string, dishes?: string[]) {
  switch (result) {
    case 'created': return `${date}の晩ごはんを記録したよ。\n${dishes?.join('、')}`;
    case 'updated': return `${date}の記録を修正したよ。\n${dishes?.join('、')}`;
    case 'deleted': return `${date}の記録を削除したよ。`;
    case 'exists': return `その日は記録済みだよ。「晩ごはん修正 ${date} 料理名」で直せるよ。`;
    case 'missing': return `${date}の記録はまだないよ。`;
    case 'stale': return '新しい変更が先に反映されているよ。「献立履歴」で確認してね。';
    default: return undefined;
  }
}

export async function handleWebhook(
  request: Request, env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>, services: Runtime = runtime,
) {
  const received = services.now();
  if (new URL(request.url).pathname !== '/line/webhook') return acknowledgement(404);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_BOT_USER_ID || !env.EVENT_KEY_SECRET) {
    return acknowledgement(503);
  }
  try {
    const bytes = await limitedBytes(request.body, 512 * 1024);
    if (!bytes) return acknowledgement(413);
    if (!await signatureValid(env, request.headers.get('X-Line-Signature'), bytes)) return acknowledgement(401);
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
    catch { return acknowledgement(400); }
    const input = payload as { destination?: unknown; events?: unknown } | null;
    if (!input || input.destination !== env.LINE_BOT_USER_ID || !Array.isArray(input.events) || !input.events.every(validEvent)) {
      return acknowledgement(400);
    }
    const secret = await hmacKey(env.EVENT_KEY_SECRET);
    const events = input.events.sort((a: LineEvent, b: LineEvent) =>
      priority(a.type) - priority(b.type) || a.timestamp - b.timestamp || a.webhookEventId.localeCompare(b.webhookEventId));
    for (const e of events as LineEvent[]) {
      const groupId = e.source?.groupId;
      if (e.source?.type !== 'group' || !groupId || e.mode === 'standby') continue;
      const group = await getGroup(env.DB);
      if (!group) return acknowledgement(503);
      const text = e.message?.type === 'text' ? e.message.text : undefined;
      if (text?.startsWith('晩ごはんBot確認 ') && e.source.userId && e.source.userId === env.LINE_ADMIN_USER_ID &&
          (group.status === 'unbound' || (group.status === 'left' && group.group_id === groupId))) {
        const code = text.slice('晩ごはんBot確認 '.length);
        if (/^[0-9a-f]{32}$/.test(code)) await env.DB.prepare(`UPDATE group_claim SET used_at_ms=?,candidate_group_id=?
          WHERE singleton=1 AND used_at_ms IS NULL AND expires_at_ms>? AND code_hash=?
          AND EXISTS(SELECT 1 FROM group_settings WHERE status IN ('unbound','left'))`)
          .bind(received, groupId, received, await digest(code)).run();
        continue;
      }
      if (group.group_id !== groupId) continue;
      const ordinary = e.type === 'message';
      if (ordinary && (group.status !== 'active' || e.timestamp < (group.approved_at_ms ?? 0) ||
          e.timestamp <= received - 7 * DAY || e.timestamp > received + 5 * MINUTE)) continue;
      if (!ordinary && !['memberJoined','memberLeft','leave','unsend'].includes(e.type)) continue;
      const event: EventContext = {
        group: groupId, epoch: group.epoch, timestamp: e.timestamp, received,
        key: await identifier(secret, 'event', groupId, e.webhookEventId),
        source: e.message ? await identifier(secret, 'message', groupId, e.message.id) : null,
        execution: crypto.randomUUID(),
        replyToken: typeof e.replyToken === 'string' ? e.replyToken : undefined,
      };
      if (e.type === 'unsend' && e.unsend) {
        await unsend(env.DB, event, await identifier(secret, 'message', groupId, e.unsend.messageId));
        continue;
      }
      if (!ordinary) {
        await changeMembership(env.DB, event, e.type === 'leave');
        continue;
      }
      const actor = e.source.userId ? await identifier(secret, 'actor', groupId, e.source.userId) : null;
      if (e.message?.type === 'image' && e.message.contentProvider?.type === 'line' && actor) {
        const photo = await claimPhoto(env, group, event, actor, services.now());
        if (photo?.sessionId) {
          const id = e.message.id;
          ctx.waitUntil(recognizePhoto(env,services,group,event,photo.sessionId,photo.mealDate,id).catch(async () => {
            await sendReply(env,services,event,'写真の処理ができなかったよ。「晩ごはん 料理名」で記録してね。',received+25_000).catch(() => false);
          }));
        } else if (photo?.text) {
          ctx.waitUntil(sendReply(env,services,event,photo.text,received+5000).catch(() => false));
        }
        continue;
      }
      if (text === undefined) continue;
      const command = parseCommand(text, e.timestamp, received);
      if (command.type === 'ignore') continue;
      let response: string | undefined;
      if (command.type === 'register' || command.type === 'edit' || command.type === 'delete') {
        const dishes = 'dishes' in command ? command.dishes : undefined;
        response = changeMessage(await changeMeal(env.DB, event, { kind: command.type, date: command.date, dishes }), command.date, dishes);
      } else if (command.type === 'photo' && actor) {
        response = await startPhoto(env,group,event,actor,services.now());
      } else if (command.type === 'photo-confirm' && actor) {
        const result = await finishPhoto(env,event,actor,services.now(),command.dishes);
        response = result.date ? changeMessage(result.result,result.date,result.dishes) :
          result.result === 'no_candidate' ? '確定できる候補がないよ。写真の案内からやり直すか、料理名を入力してね。' : undefined;
      } else if (command.type === 'photo-cancel' && actor) {
        response = await cancelPhoto(env,event,actor);
      } else if ((await eventInsert(env.DB, event).run()).meta.changes === 1) {
        if (command.type === 'history' || command.type === 'trends' || command.type === 'recommend') {
          const date = jstDate(e.timestamp);
          const today = jstDate(received);
          const deadline = received + (command.type === 'recommend' ? 25_000 : 5000);
          ctx.waitUntil((async () => {
            try {
              if (command.type === 'recommend') {
                const target = shiftDate(date, command.daysAhead);
                const proposed = await recommend(env,services,group,target,today,deadline);
                const current = await getGroup(env.DB);
                const answer = current?.history_rev === proposed.rev ? proposed : await simpleRecommendation(env,group,target,today);
                await sendReply(env,services,event,answer.text,deadline,{ revision: answer.rev });
              } else {
                const snapshot = await readHistory(env,group,date,today);
                await sendReply(env,services,event,historyText(snapshot,date,command.type === 'trends'),deadline,{ revision: snapshot.rev });
              }
            } catch {
              await sendReply(env,services,event,'献立の情報を読み出せなかったよ。少し待ってからもう一度試してね。',deadline);
            }
          })().catch(() => undefined));
        } else if (command.type === 'invalid') {
          response = '「晩ごはん カレー、サラダ」のように入力してね。日付を指定する場合は YYYY-MM-DD を使えるよ。';
        }
      }
      if (response) ctx.waitUntil(sendReply(env, services, event, response, received + 5000).catch(() => false));
    }
    return acknowledgement(200);
  } catch {
    return acknowledgement(503);
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => handleWebhook(request, env, ctx),
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runSchedule(env,runtime,event.scheduledTime).catch(() => console.error('scheduled_processing_failed')));
  },
} satisfies ExportedHandler<Env>;
