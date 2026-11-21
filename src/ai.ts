import { jstDate } from './domain.ts';
import { type Env, type Runtime, limitedBytes } from './environment.ts';
import { type Group, getGroup } from './store.ts';

type Kind = 'recommendation' | 'photo_ai' | 'image_transform';
type AiKind = Exclude<Kind, 'image_transform'>;

export function available(group: Group | null, env: Env, kind: Kind, time: number) {
  if (!group?.group_id || group.status !== 'active' || group.ai_hold_code || !env.OPENAI_API_KEY ||
      (group.ai_valid_until_ms ?? 0) <= time) return false;
  if (kind === 'recommendation') return group.suggestions_enabled === 1;
  return group.photos_enabled === 1 && !!env.IMAGES && (group.images_valid_until_ms ?? 0) > time;
}

export async function reserveUsage(env: Env, group: Group, kind: Kind, target: string, now: number) {
  if (!available(group, env, kind, now)) return false;
  const month = jstDate(now).slice(0, 7);
  const feature = kind === 'recommendation' ? 'suggestions_enabled' : 'photos_enabled';
  const photoGate = kind === 'recommendation' ? '' : 'AND images_valid_until_ms > ?5';
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO usage_attempts(kind,group_id,target_key,month_jst,created_at_ms,execution_id)
    SELECT ?1,?2,?3,?4,?5,?6 WHERE
      (SELECT COUNT(*) FROM usage_attempts WHERE kind=?1 AND month_jst=?4) < 31
      AND EXISTS(SELECT 1 FROM group_settings WHERE status='active' AND group_id=?2 AND epoch=?7
        AND ${feature}=1 AND ai_hold_code IS NULL AND ai_valid_until_ms>?5 ${photoGate})`)
    .bind(kind, group.group_id, target, month, now, crypto.randomUUID(), group.epoch).run();
  return result.meta.changes === 1;
}

type TokenUsage = { input_tokens?: number; output_tokens?: number };
export async function recordUsage(env: Env, group: Group, kind: Kind, target: string, status: 'succeeded' | 'failed' | 'unknown', usage?: TokenUsage) {
  const tokens = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
  await env.DB.prepare(`UPDATE usage_attempts SET status=?,input_tokens=?,output_tokens=?
    WHERE kind=? AND group_id=? AND target_key=? AND status='reserved'`)
    .bind(status,tokens(usage?.input_tokens),tokens(usage?.output_tokens),kind,group.group_id,target).run();
}

export async function requestResponse(
  env: Env, runtime: Runtime, group: Group, kind: AiKind, target: string, deadline: number,
  instructions: string, content: object[], schema: object, stillAllowed: () => Promise<boolean> = async () => true,
): Promise<unknown> {
  if (runtime.now() >= deadline || !await stillAllowed() || !await reserveUsage(env, group, kind, target, runtime.now())) return null;
  let final: 'succeeded' | 'failed' | 'unknown' = 'failed';
  let usage: TokenUsage | undefined;
  try {
    const current = await getGroup(env.DB);
    if (current?.epoch !== group.epoch || !available(current, env, kind, runtime.now()) || !await stillAllowed()) return null;
    const remaining = deadline - runtime.now();
    if (remaining <= 0) return null;
    final = 'unknown';
    const response = await runtime.fetcher('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(remaining),
      headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-luna', store: false, tools: [], reasoning: { effort: 'none' }, instructions,
        max_output_tokens: kind === 'recommendation' ? 512 : 256,
        text: { format: { type: 'json_schema', name: kind, strict: true, schema } },
        input: [{ role: 'user', content }],
      }),
    });
    final = 'failed';
    const bytes = await limitedBytes(response.body, 65536);
    const data = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    usage = data?.usage;
    if (!response.ok) {
      if (response.status === 401 || response.status === 402 || response.status === 403 ||
          ['insufficient_quota','credit_balance_exhausted','billing_hard_limit_reached','organization_usage_limit_exceeded']
            .includes(data?.error?.code)) {
        await env.DB.prepare('UPDATE group_settings SET ai_hold_code=? WHERE group_id=? AND epoch=?')
          .bind(response.status === 429 ? 'quota' : 'billing_or_auth', group.group_id, group.epoch).run();
      }
      return null;
    }
    if (data?.status !== 'completed' || !Array.isArray(data.output)) return null;
    const messages = data.output.filter((entry: { type?: string }) => entry?.type === 'message');
    if (messages.length !== 1 || messages[0].content?.length !== 1 || messages[0].content[0]?.type !== 'output_text') return null;
    const value = JSON.parse(messages[0].content[0].text);
    final = 'succeeded';
    return value;
  } catch {
    return null;
  } finally {
    await recordUsage(env,group,kind,target,final,usage);
  }
}
