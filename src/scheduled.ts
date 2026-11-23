import { DAY, MINUTE, jstDate, jstMidnight, jstMinute, shiftDate } from './domain.ts';
import type { Env, Runtime } from './environment.ts';
import { lineBase, lineHeaders } from './line.ts';
import { recommend } from './recommendations.ts';
import { type Group, getGroup } from './store.ts';

interface Quota { count: number; limit: number; usage: number }
interface Delivery {
  state: 'in_flight' | 'retryable' | 'accepted' | 'stopped' | 'skipped';
  epoch: number;
  history_rev: number;
  retry_key: string | null;
  body_json: string | null;
  reserved_count: number;
  attempt_count: number;
  deadline_ms: number;
  lease_until_ms: number | null;
  attempt_owner: string | null;
}

async function quota(env: Env, runtime: Runtime, groupId: string): Promise<Quota | null> {
  const get = async (suffix: string) => {
    const response = await runtime.fetcher(lineBase + suffix, {
      headers: lineHeaders(env), redirect: 'manual', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('LINE quota query failed');
    return response.json();
  };
  try {
    const [members, limit, usage] = await Promise.all([
      get('/group/' + encodeURIComponent(groupId) + '/members/count'), get('/message/quota'), get('/message/quota/consumption'),
    ]) as [{ count?: number }, { type?: string; value?: number }, { totalUsage?: number }];
    if (limit.type !== 'limited' || !Number.isSafeInteger(members.count) || members.count! < 1 ||
        !Number.isSafeInteger(limit.value) || limit.value! < 1 || !Number.isSafeInteger(usage.totalUsage) || usage.totalUsage! < 0) return null;
    return { count: members.count!, limit: Math.min(200,limit.value!), usage: usage.totalUsage! };
  } catch {
    return null;
  }
}

function allowance(month: string, target: string | null, limits: Quota) {
  return [limits.limit, limits.usage, month, month, target, limits.count];
}

const withinLimits = `? - MAX(?,(SELECT COALESCE(SUM(reserved_count),0) FROM push_deliveries
  WHERE billing_month_jst=? AND state='accepted')) -
  (SELECT COALESCE(SUM(reserved_count),0) FROM push_deliveries
  WHERE billing_month_jst=? AND uncertain=1 AND state<>'accepted' AND target_date IS NOT ?) >= ?`;

const getDelivery = (env: Env, groupId: string, target: string) =>
  env.DB.prepare('SELECT * FROM push_deliveries WHERE group_id=? AND target_date=?').bind(groupId,target).first<Delivery>();

async function skip(env: Env, group: Group, target: string, month: string, deadline: number, reason: string) {
  await env.DB.prepare(`INSERT OR IGNORE INTO push_deliveries(group_id,target_date,billing_month_jst,epoch,history_rev,state,deadline_ms,last_result)
    VALUES (?,?,?,?,?,'skipped',?,?)`).bind(group.group_id,target,month,group.epoch,group.history_rev,deadline,reason).run();
}

async function startDelivery(env: Env, runtime: Runtime, group: Group, date: string, target: string, deadline: number, owner: string, clock: number) {
  const recommendation = await recommend(env,runtime,group,target,date,deadline);
  const limits = await quota(env,runtime,group.group_id!);
  const now = runtime.now();
  const month = date.slice(0,7);
  if (now >= deadline) return false;
  if (!limits) {
    await skip(env,group,target,month,deadline,'quota_unknown');
    return false;
  }
  const payload = JSON.stringify({ to: group.group_id, messages: [{ type: 'text', text: recommendation.text }] });
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO push_deliveries(group_id,target_date,billing_month_jst,epoch,history_rev,state,
    retry_key,body_json,reserved_count,uncertain,attempt_count,attempt_owner,lease_until_ms,deadline_ms)
    SELECT ?,?,?,?,?,'in_flight',?,?,?,1,1,?,?,? WHERE ${withinLimits}
    AND EXISTS(SELECT 1 FROM group_settings WHERE group_id=? AND status='active' AND push_enabled=1 AND epoch=? AND history_rev=? AND push_minute_jst=?)`)
    .bind(group.group_id,target,month,group.epoch,recommendation.rev,crypto.randomUUID(),payload,limits.count,owner,now + 30_000,deadline,
      ...allowance(month,null,limits),group.group_id,group.epoch,recommendation.rev,clock).run();
  if (!result.meta.changes) await skip(env,group,target,month,deadline,'quota_or_state');
  return result.meta.changes === 1;
}

async function resumeDelivery(env: Env, runtime: Runtime, group: Group, date: string, target: string, row: Delivery, owner: string, clock: number) {
  if (row.state === 'accepted' || row.state === 'skipped' || row.state === 'stopped') return false;
  if (row.state === 'in_flight' && (row.lease_until_ms ?? 0) > runtime.now()) return false;
  const limits = await quota(env,runtime,group.group_id!);
  const now = runtime.now();
  if (!limits || limits.count > row.reserved_count || row.epoch !== group.epoch || row.history_rev !== group.history_rev ||
      row.deadline_ms <= now || row.attempt_count >= 3) {
    await env.DB.prepare(`UPDATE push_deliveries SET state='stopped',body_json=NULL,last_result='retry_unavailable'
      WHERE group_id=? AND target_date=? AND attempt_count=? AND (state='retryable' OR (state='in_flight' AND lease_until_ms<=?))`)
      .bind(group.group_id,target,row.attempt_count,now).run();
    return false;
  }
  const month = date.slice(0,7);
  const result = await env.DB.prepare(`UPDATE push_deliveries SET state='in_flight',attempt_count=attempt_count+1,attempt_owner=?,lease_until_ms=?
    WHERE group_id=? AND target_date=? AND attempt_count=? AND deadline_ms>?
      AND (state='retryable' OR (state='in_flight' AND lease_until_ms<=?)) AND ${withinLimits}
      AND EXISTS(SELECT 1 FROM group_settings WHERE group_id=? AND status='active' AND push_enabled=1 AND epoch=? AND history_rev=? AND push_minute_jst=?)`)
    .bind(owner,now+30_000,group.group_id,target,row.attempt_count,now,now,
      ...allowance(month,target,{ ...limits,count:row.reserved_count }),group.group_id,group.epoch,row.history_rev,clock).run();
  return result.meta.changes === 1;
}

async function sendPush(env: Env, runtime: Runtime, group: Group, target: string, owner: string, clock: number) {
  const row = await getDelivery(env,group.group_id!,target);
  if (!row?.body_json || !row.retry_key || row.attempt_owner !== owner) return;
  const current = await getGroup(env.DB);
  const remaining = row.deadline_ms - runtime.now();
  let state: Delivery['state'] = 'stopped';
  let reason = 'state_changed';
  let uncertain = 1;
  if (current?.group_id === group.group_id && current.status === 'active' && current.push_enabled &&
      current.epoch === row.epoch && current.history_rev === row.history_rev &&
      current.push_minute_jst === clock && remaining > 0) {
    try {
      const response = await runtime.fetcher(lineBase + '/message/push', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(Math.min(5000,remaining)),
        headers: { ...lineHeaders(env),'X-Line-Retry-Key': row.retry_key },
        body: row.body_json,
      });
      if (response.ok || (response.status === 409 && response.headers.has('X-Line-Accepted-Request-Id'))) {
        state = 'accepted'; reason = 'accepted'; uncertain = 0;
      } else if (response.status >= 500 && row.attempt_count < 3) {
        state = 'retryable'; reason = 'line_5xx';
      } else {
        reason = 'line_' + response.status;
      }
    } catch {
      state = row.attempt_count < 3 ? 'retryable' : 'stopped';
      reason = 'send_unknown';
    }
  }
  await env.DB.prepare(`UPDATE push_deliveries SET state=?,last_result=?,uncertain=?,body_json=CASE WHEN ?='retryable' THEN body_json ELSE NULL END
    WHERE group_id=? AND target_date=? AND attempt_owner=? AND state='in_flight'`)
    .bind(state,reason,uncertain,state,group.group_id,target,owner).run();
}

export async function runSchedule(env: Env, runtime: Runtime, scheduledTime: number) {
  const now = runtime.now();
  await purge(env,now,jstMinute(scheduledTime) === 180);
  const group = await getGroup(env.DB);
  if (group?.status !== 'active' || !group.group_id || !group.push_enabled || !env.LINE_CHANNEL_ACCESS_TOKEN) return;
  const date = jstDate(scheduledTime);
  if (date !== jstDate(now)) return;
  const clock = group.push_minute_jst;
  const start = jstMidnight(date) + clock * MINUTE;
  const deadline = Math.min(start + 15 * MINUTE, jstMidnight(shiftDate(date,1)));
  if (scheduledTime < start || now < start || now >= deadline) return;
  const target = shiftDate(date,1);
  const existing = await getDelivery(env,group.group_id,target);
  const owner = crypto.randomUUID();
  const reserved = existing
    ? await resumeDelivery(env,runtime,group,date,target,existing,owner,clock)
    : await startDelivery(env,runtime,group,date,target,deadline,owner,clock);
  if (reserved) await sendPush(env,runtime,group,target,owner,clock);
}

async function purge(env: Env, now: number, daily: boolean) {
  const db = env.DB;
  const today = jstDate(now);
  const tasks = [
    db.prepare('DELETE FROM photo_sessions WHERE deadline_ms<=?').bind(now),
    // Earlier versions stored the start of the target day as the cache deadline.
    db.prepare(`DELETE FROM recommendation_cache WHERE (expires_at_ms<=? AND (target_date<>? OR expires_at_ms<>?)) OR NOT EXISTS
      (SELECT 1 FROM group_settings g WHERE g.group_id=recommendation_cache.group_id AND g.epoch=recommendation_cache.epoch
      AND g.history_rev=recommendation_cache.history_rev)`).bind(now,today,jstMidnight(today)),
    db.prepare(`UPDATE push_deliveries SET body_json=NULL,state='stopped',last_result='expired'
      WHERE deadline_ms<=? AND state IN ('in_flight','retryable')`).bind(now),
  ];
  if (daily) tasks.push(
    db.prepare('DELETE FROM meal_days WHERE meal_date<?').bind(shiftDate(today,-364)),
    db.prepare('DELETE FROM webhook_events WHERE expires_at_ms<=?').bind(now),
    db.prepare('DELETE FROM unsent_messages WHERE expires_at_ms<=?').bind(now),
    db.prepare('DELETE FROM group_claim WHERE expires_at_ms<=? AND used_at_ms IS NULL').bind(now),
    db.prepare('DELETE FROM usage_attempts WHERE created_at_ms<=?').bind(now-90*DAY),
    db.prepare('DELETE FROM push_deliveries WHERE deadline_ms<=?').bind(now-90*DAY),
    db.prepare('DELETE FROM admin_log WHERE timestamp_ms<=?').bind(now-90*DAY),
    db.prepare('DELETE FROM deletion_journal WHERE recorded_at_ms<=?').bind(now-28*DAY),
  );
  await db.batch(tasks);
}
