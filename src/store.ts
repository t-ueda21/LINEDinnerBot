import { DAY } from './domain.ts';

export interface Group {
  group_id: string | null;
  status: 'unbound' | 'candidate' | 'active' | 'paused' | 'left';
  epoch: number;
  approved_at_ms: number | null;
  history_rev: number;
  suggestions_enabled: number;
  photos_enabled: number;
  push_enabled: number;
  push_minute_jst: number;
  ai_valid_until_ms: number | null;
  images_valid_until_ms: number | null;
  ai_hold_code: string | null;
}

export interface EventContext {
  group: string;
  epoch: number;
  key: string;
  source: string | null;
  timestamp: number;
  received: number;
  execution: string;
  replyToken?: string;
}

export interface PhotoSession {
  group_id: string;
  actor_key: string;
  session_id: string;
  epoch: number;
  state: 'awaiting' | 'processing' | 'reply_pending' | 'ready';
  declared_at_ms: number;
  ready_at_ms: number | null;
  deadline_ms: number;
  photo_key: string | null;
  meal_date: string | null;
  candidate_json: string | null;
}

export const getGroup = (db: D1Database) => db.prepare('SELECT * FROM group_settings WHERE singleton=1').first<Group>();

export interface ReplyGuard {
  sessionId?: string;
  revision?: number;
}

export function eventInsert(db: D1Database, event: EventContext) {
  return db.prepare(`INSERT OR IGNORE INTO webhook_events(event_key,group_id,execution_id,expires_at_ms)
    VALUES (?,?,?,?)`).bind(event.key, event.group, event.execution, event.received + 7 * DAY);
}

export async function reserveReply(db: D1Database, event: EventContext, guard: ReplyGuard) {
  const result = await db.prepare(`UPDATE webhook_events SET reply_used=1
    WHERE event_key=?1 AND execution_id=?2 AND reply_used=0
    AND EXISTS(SELECT 1 FROM group_settings WHERE group_id=?3 AND epoch=?4 AND status='active'
      AND (?6 IS NULL OR history_rev=?6))
    AND NOT EXISTS(SELECT 1 FROM unsent_messages WHERE group_id=?3 AND message_key=?5)
    AND (?7 IS NULL OR EXISTS(SELECT 1 FROM photo_sessions WHERE session_id=?7 AND state='reply_pending'))`)
    .bind(event.key,event.execution,event.group,event.epoch,event.source,guard.revision ?? null,guard.sessionId ?? null).run();
  return result.meta.changes === 1;
}

type Change = { date: string; kind: 'register' | 'edit' | 'delete'; dishes?: string[]; photo?: PhotoSession; now?: number };

export async function changeMeal(db: D1Database, event: EventContext, change: Change) {
  const { date, kind, dishes, photo, now = event.received } = change;
  const allowed = `EXISTS(SELECT 1 FROM webhook_events WHERE event_key=?1 AND execution_id=?2)
    AND EXISTS(SELECT 1 FROM group_settings WHERE group_id=?3 AND epoch=?4 AND status='active')
    AND NOT EXISTS(SELECT 1 FROM unsent_messages WHERE group_id=?3 AND message_key IN (?5,?11))
    AND (?12 IS NULL OR EXISTS(SELECT 1 FROM photo_sessions WHERE session_id=?12 AND epoch=?4
      AND state='ready' AND ready_at_ms<=?6 AND deadline_ms>?7))`;
  const args = [event.key, event.execution, event.group, event.epoch, event.source, event.timestamp,
    now, date, dishes ? JSON.stringify(dishes) : null, kind, photo?.photo_key ?? null, photo?.session_id ?? null];
  const later = '(?6 > event_time_ms OR (?6 = event_time_ms AND ?1 > event_key))';
  const operation = kind === 'register'
    ? db.prepare(`INSERT INTO meal_days(group_id,meal_date,dishes_json,version,event_time_ms,event_key,source_key,photo_key,updated_at_ms)
       SELECT ?3,?8,?9,COALESCE((SELECT max_removed_version+1 FROM deletion_journal WHERE group_id=?3 AND meal_date=?8),1),
         ?6,?1,?5,?11,?7 WHERE ${allowed} AND ?10='register'
       ON CONFLICT(group_id,meal_date) DO UPDATE SET dishes_json=excluded.dishes_json,version=version+1,
         event_time_ms=excluded.event_time_ms,event_key=excluded.event_key,source_key=excluded.source_key,
         photo_key=excluded.photo_key,updated_at_ms=excluded.updated_at_ms
       WHERE meal_days.dishes_json IS NULL AND ${later}
       RETURNING meal_date`).bind(...args)
    : db.prepare(`UPDATE meal_days SET dishes_json=?9,version=version+1,event_time_ms=?6,event_key=?1,
       source_key=CASE WHEN ?10='delete' THEN NULL ELSE ?5 END,photo_key=NULL,updated_at_ms=?7
       WHERE group_id=?3 AND meal_date=?8 AND dishes_json IS NOT NULL AND ${later} AND ${allowed}
       RETURNING meal_date`).bind(...args);
  const statements = [eventInsert(db, event), operation];
  if (photo) statements.push(db.prepare(`DELETE FROM photo_sessions WHERE session_id=? AND state='ready'
    AND ready_at_ms<=? AND deadline_ms>?
    AND EXISTS(SELECT 1 FROM webhook_events WHERE event_key=? AND execution_id=?)
    AND EXISTS(SELECT 1 FROM group_settings WHERE group_id=? AND epoch=? AND status='active')`)
    .bind(photo.session_id, event.timestamp, now, event.key, event.execution, event.group, event.epoch));
  statements.push(db.prepare('SELECT dishes_json,event_time_ms,event_key FROM meal_days WHERE group_id=? AND meal_date=?')
    .bind(event.group, date));
  const results = await db.batch<{ dishes_json: string | null; event_time_ms: number; event_key: string }>(statements);
  if (results[0].meta.changes !== 1) return 'duplicate';
  if (results[1].results.length === 1) return kind === 'register' ? 'created' : kind === 'edit' ? 'updated' : 'deleted';
  const row = results.at(-1)?.results[0];
  if (!row?.dishes_json) return kind === 'register' ? 'blocked' : 'missing';
  return kind === 'register' ? 'exists' : 'stale';
}

export async function unsend(db: D1Database, event: EventContext, messageKey: string) {
  const gate = `EXISTS(SELECT 1 FROM webhook_events WHERE event_key=? AND execution_id=?)`;
  await db.batch([
    eventInsert(db, event),
    db.prepare(`INSERT OR IGNORE INTO unsent_messages(group_id,message_key,expires_at_ms)
      SELECT ?,?,? WHERE ${gate}`)
      .bind(event.group, messageKey, event.received + 7 * DAY, event.key, event.execution),
    db.prepare(`UPDATE meal_days SET dishes_json=NULL,version=version+1,
      event_key=CASE WHEN ?>=event_time_ms THEN ? ELSE event_key END,event_time_ms=MAX(?,event_time_ms),
      source_key=NULL,photo_key=NULL,updated_at_ms=?
      WHERE group_id=? AND dishes_json IS NOT NULL AND (source_key=? OR photo_key=?) AND ${gate}`)
      .bind(event.timestamp, event.key, event.timestamp, event.received, event.group, messageKey, messageKey, event.key, event.execution),
    db.prepare(`DELETE FROM photo_sessions WHERE group_id=? AND photo_key=? AND ${gate}`)
      .bind(event.group, messageKey, event.key, event.execution),
  ]);
}

export async function changeMembership(db: D1Database, event: EventContext, leave: boolean) {
  await db.batch([
    eventInsert(db, event),
    db.prepare(`UPDATE group_settings SET status=CASE WHEN status='left' OR ? THEN 'left' ELSE 'paused' END,
      epoch=epoch+1,updated_at_ms=?,last_membership_ms=MAX(COALESCE(last_membership_ms,0),?)
      WHERE group_id=? AND status IN ('active','candidate','paused','left')
      AND EXISTS(SELECT 1 FROM webhook_events WHERE event_key=? AND execution_id=?)`)
      .bind(Number(leave), event.received, event.timestamp, event.group, event.key, event.execution),
    db.prepare(`DELETE FROM photo_sessions WHERE group_id=?
      AND EXISTS(SELECT 1 FROM webhook_events WHERE event_key=? AND execution_id=?)`)
      .bind(event.group, event.key, event.execution),
  ]);
}
