import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { recoverableRows } from '../scripts/admin.mjs';

// D1 のローカル代替。複数の SQL 文を一つのトランザクションで実行する。
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  function prepare(sql: string, params: any[] = []) {
    const statement = () => sqlite.prepare(sql);
    const run = () => {
      const results = statement().columns().length ? statement().all(...params) : (statement().run(...params), []);
      const changes = Number(sqlite.prepare('SELECT changes() AS n').get()!.n);
      return { results, success: true, meta: { changes } };
    };
    return {
      bind: (...values: any[]) => prepare(sql, values),
      first: async () => statement().get(...params) ?? null,
      all: async () => ({ results: statement().all(...params), success: true }),
      run: async () => run(),
      execute: run,
    };
  }
  const DB = {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, DB };
}

const time = Date.parse('2026-11-22T12:00:00Z');
const credentials = {
  LINE_CHANNEL_SECRET: 'test-channel-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-channel-token',
  LINE_BOT_USER_ID: 'Utestbot',
  LINE_ADMIN_USER_ID: 'Uadmin',
  EVENT_KEY_SECRET: 'test-key-for-event-pseudonyms-only',
  OPENAI_API_KEY: 'fake-key',
};

function message(id: string, contents: string, groupId = 'Cfamily', userId = 'Ufamily') {
  return {
    type: 'message', webhookEventId: 'event-' + id, timestamp: time, mode: 'active',
    source: { type: 'group', groupId, userId }, replyToken: 'reply-' + id,
    message: { id, type: 'text', text: contents },
  };
}

function fixture(options: { fetch?: typeof fetch, images?: unknown, approved?: boolean } = {}) {
  const { sqlite, DB } = database();
  if (options.approved !== false) sqlite.prepare(
    "UPDATE group_settings SET group_id='Cfamily', status='active', approved_at_ms=?, epoch=1",
  ).run(time - 1000);
  const outbound: { url: string, body: any }[] = [];
  const env = { ...credentials, DB, IMAGES: options.images };
  async function post(events: any[], signature?: string, now = time + 100) {
    const workerPath = '../src/worker.ts';
    const { handleWebhook } = await import(workerPath);
    const body = JSON.stringify({ destination: credentials.LINE_BOT_USER_ID, events });
    const request = new Request('https://worker.test/line/webhook', {
      method: 'POST', body, headers: { 'X-Line-Signature': signature ?? createHmac('sha256', credentials.LINE_CHANNEL_SECRET).update(body).digest('base64') },
    });
    const background: Promise<any>[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      outbound.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return options.fetch ? options.fetch(input, init) : Response.json({});
    };
    const response = await handleWebhook(request, env, { waitUntil(p: Promise<any>) { background.push(p); } }, { now: () => now, fetcher });
    await Promise.all(background);
    return response;
  }
  return { sqlite, DB, env, outbound, post };
}

test('署名検証の入口があり不正な署名を拒否する', async () => {
  const workerPath = '../src/worker.ts';
  let worker;
  try { worker = await import(workerPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  assert.equal(typeof worker?.handleWebhook, 'function', 'Webhook の入口が未実装');
  const bot = fixture();
  assert.equal((await bot.post([message('1', '晩ごはん カレー')], 'bad')).status, 401);
  assert.equal(bot.outbound.length, 0);
});

test('日次記録、同日競合、再送、別グループを扱う', async () => {
  const bot = fixture();
  const first = message('1', '晩ごはん 鮭、サラダ');
  assert.equal((await bot.post([first, message('2', '晩ごはん カレー')])).status, 200);
  await bot.post([first, message('3', '献立履歴', 'Cother')]);
  const rows = bot.sqlite.prepare('SELECT meal_date, dishes_json FROM meal_days WHERE dishes_json IS NOT NULL').all();
  assert.deepEqual(rows.map(r => [r.meal_date, JSON.parse(String(r.dishes_json))]), [['2026-11-22', ['鮭', 'サラダ']]]);
  assert.equal(bot.outbound.length, 2);
});

test('取消の先着と修正後の旧投稿取消は献立を復活・削除させない', async () => {
  const bot = fixture();
  function unsend(id: string) {
    const event = message('u-' + id, '');
    return { ...event, type: 'unsend', message: undefined, unsend: { messageId: id } };
  }
  await bot.post([unsend('1')]);
  await bot.post([message('1', '晩ごはん カレー'), message('2', '晩ごはん 焼き魚')]);
  await bot.post([{ ...message('3', '晩ごはん修正 2026-11-22 親子丼'), timestamp: time + 200 }], undefined, time + 300);
  await bot.post([unsend('2')]);
  assert.equal(bot.sqlite.prepare('SELECT dishes_json FROM meal_days').get()!.dishes_json, '["親子丼"]');
  await bot.post([unsend('3')]);
  assert.equal(bot.sqlite.prepare('SELECT dishes_json FROM meal_days').get()!.dishes_json, null);
});

test('履歴を集計し AI 無効時は履歴に基づく簡易案を返す', async () => {
  const bot = fixture();
  await bot.post([message('1', '晩ごはん サバ、サバ、サラダ')]);
  await bot.post([message('2', '献立傾向'), message('3', '明日の献立')]);
  assert.match(bot.outbound.find(call => call.body.replyToken === 'reply-2')?.body.messages[0].text ?? '', /サバ：1回/);
  assert.match(bot.outbound.find(call => call.body.replyToken === 'reply-3')?.body.messages[0].text ?? '', /2026-11-23.*簡易案/s);
  assert.ok(bot.outbound.every(call => call.url.includes('api.line.me')));
});

export const sampleJpeg = Uint8Array.from([
  255,216, 255,225,0,6, 1,2,3,4, 255,192,0,11,8,0,1,0,1,1,1,17,0,
  255,218,0,8,1,1,0,0,63,0, 0,255,217,
]);

function photo(id: string, userId: string) {
  const event = message(id, '', 'Cfamily', userId);
  return { ...event, timestamp: time + 200, message: { id, type: 'image', contentProvider: { type: 'line' } } };
}

test('本人が指定した写真だけを取得し、本人の確定で初めて登録する', async () => {
  const images = { input: () => ({ transform: () => ({
    output: async () => ({ response: () => new Response(sampleJpeg) }),
  }) }) };
  const bot = fixture({ images, fetch: async input => {
    if (String(input).includes('api-data.line.me')) return new Response(sampleJpeg, { headers: { 'Content-Type': 'image/jpeg' } });
    if (String(input).includes('api.openai.com')) return Response.json({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"status":"ok","dishes":["カレー"]}' }] }],
    });
    return Response.json({});
  } });
  bot.sqlite.prepare('UPDATE group_settings SET photos_enabled=1,ai_valid_until_ms=?,images_valid_until_ms=?')
    .run(time + 1_000_000, time + 1_000_000);
  await bot.post([photo('101', 'Uother')], undefined, time + 300);
  await bot.post([message('1', '写真で晩ごはん')]);
  await bot.post([photo('102', 'Uother'), photo('103', 'Ufamily')], undefined, time + 310);
  assert.equal(bot.outbound.filter(call => call.url.includes('api-data.line.me')).length, 1);
  const ai = bot.outbound.find(call => call.url.includes('api.openai.com'));
  assert.equal(ai?.body.store, false);
  assert.ok(!JSON.stringify(ai?.body).includes('Ufamily'));
  const imageUrl = ai?.body.input[0].content[0].image_url as string;
  assert.ok(!Buffer.from(imageUrl.split(',')[1],'base64').includes(Buffer.from([255,225])));
  assert.equal(bot.sqlite.prepare('SELECT * FROM meal_days').all().length, 0);
  await bot.post([{ ...message('2', '晩ごはん確定', 'Cfamily', 'Uother'), timestamp: time + 400 }], undefined, time + 500);
  assert.equal(bot.sqlite.prepare('SELECT * FROM meal_days').all().length, 0);
  await bot.post([{ ...message('3', '晩ごはん確定 ビーフカレー'), timestamp: time + 450 }], undefined, time + 500);
  assert.equal(bot.sqlite.prepare('SELECT dishes_json FROM meal_days').get()!.dishes_json, '["ビーフカレー"]');
});

test('定時通知は不明な送信の再試行でも同一キーを使い、2回目の受付後は送らない', async () => {
  const schedulerPath = '../src/scheduled.ts';
  let scheduler;
  try { scheduler = await import(schedulerPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  assert.equal(typeof scheduler?.runSchedule, 'function', '定時配信の入口が未実装');
  const bot = fixture();
  bot.sqlite.exec('UPDATE group_settings SET push_enabled=1');
  let now = time + 100;
  const sends: { key: string | null; body: string }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/members/count')) return Response.json({ count: 4 });
    if (target.endsWith('/quota')) return Response.json({ type: 'limited', value: 200 });
    if (target.endsWith('/consumption')) return Response.json({ totalUsage: 196 });
    assert.ok(target.endsWith('/push'));
    sends.push({ key: new Headers(init?.headers).get('X-Line-Retry-Key'), body: String(init?.body) });
    return sends.length === 1 ? new Response(null,{status:503}) :
      new Response(null,{status:409,headers:{'X-Line-Accepted-Request-Id':'fake-accepted'}});
  };
  await scheduler.runSchedule(bot.env,{now:() => now,fetcher},time);
  now += 300_000;
  await scheduler.runSchedule(bot.env,{now:() => now,fetcher},time+300_000);
  now += 300_000;
  await scheduler.runSchedule(bot.env,{now:() => now,fetcher},time+600_000);
  assert.equal(sends.length,2);
  assert.ok(sends[0].key);
  assert.deepEqual(sends[0],sends[1]);
});

test('管理者の短期コードを受け取っても明示承認までは記録しない', async () => {
  const bot = fixture({ approved: false });
  const code = '7f9dc926779b57aa8d99b116a4a99221';
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code))).toString('hex');
  bot.sqlite.prepare('INSERT INTO group_claim(singleton,code_hash,expires_at_ms) VALUES (1,?,?)').run(hash,time+600_000);
  await bot.post([message('1','晩ごはんBot確認 '+code,'Cfamily','Uother')]);
  assert.equal(bot.sqlite.prepare('SELECT candidate_group_id FROM group_claim').get()!.candidate_group_id,null);
  await bot.post([message('2','晩ごはんBot確認 '+code,'Cfamily','Uadmin')]);
  assert.equal(bot.sqlite.prepare('SELECT candidate_group_id FROM group_claim').get()!.candidate_group_id,'Cfamily');
  await bot.post([message('3','晩ごはん カレー')]);
  assert.equal(bot.sqlite.prepare('SELECT COUNT(*) AS n FROM meal_days').get()!.n,0);
});

test('期限を過ぎた写真は取得せず、写真解析の上限で API を呼び出さない', async () => {
  const bot = fixture({ images: {}, fetch: async () => Response.json({}) });
  bot.sqlite.prepare('UPDATE group_settings SET photos_enabled=1,ai_valid_until_ms=?,images_valid_until_ms=?')
    .run(time+30*86_400_000,time+30*86_400_000);
  await bot.post([message('1','写真で晩ごはん')]);
  await bot.post([{ ...photo('201','Ufamily'), timestamp:time+300_000 }],undefined,time+300_001);
  assert.equal(bot.outbound.filter(call => call.url.includes('api-data.line.me')).length,0);
  const ai = await import('../src/ai.ts');
  const group = bot.sqlite.prepare('SELECT * FROM group_settings').get();
  const results = await Promise.all(Array.from({ length: 32 }, (_, i) => ai.reserveUsage(bot.env,group,'photo_ai','day-'+i,time)));
  assert.equal(results.filter(Boolean).length,31);
  assert.equal(await ai.reserveUsage(bot.env,group,'photo_ai','day-0',time+12*86_400_000),false);
  assert.equal(await ai.reserveUsage(bot.env,group,'photo_ai','different-day',time+12*86_400_000),true);
  assert.equal(bot.outbound.filter(call => call.url.includes('api.openai.com')).length,0);
});

test('バックアップから削除済み・期限外の料理を除外する', () => {
  const row = (date: string) => ({
    meal_date: date, version: 1, event_time_ms: time-1000, updated_at_ms: time-1000,
    event_key: 'a'.repeat(64), source_key: 'b'.repeat(64), photo_key: null, dishes_json: '["焼き魚"]',
  });
  const group = 'C'+'1'.repeat(32);
  const backup = { format:1,group,createdAt:time-3000,rows:[row('2025-10-22'),row('2026-11-20'),row('2026-11-21')] };
  const journal = { format:1,group,createdAt:time-100,pausedAt:time-200,
    removed:[{meal_date:'2026-11-20',max_removed_version:1,recorded_at_ms:time-500}] };
  assert.deepEqual(recoverableRows(backup,journal,group,time).map(entry=>entry.meal_date),['2026-11-21']);
  assert.throws(()=>recoverableRows(backup,{...journal,createdAt:time-4000},group,time),/時刻/);
});

test('AI 提案を再利用し、献立が修正された後は古い提案も再課金も行わない', async () => {
  const bot = fixture({ fetch: async url => {
    if (!String(url).includes('api.openai.com')) return Response.json({});
    return Response.json({ status:'completed', usage:{ input_tokens:120,output_tokens:50 }, output:[{
      type:'message',content:[{type:'output_text',text:JSON.stringify({
        candidates:[{main:'肉じゃが',side:null,reason_ids:[]},{main:'鶏の照り焼き',side:'温野菜',reason_ids:[]}],
      })}],
    }] });
  } });
  bot.sqlite.prepare('UPDATE group_settings SET suggestions_enabled=1,ai_valid_until_ms=?').run(time+3600_000);
  await bot.post([message('1','晩ごはん カレー')]);
  await bot.post([message('2','明日の献立')]);
  await bot.post([message('3','明日の献立')]);
  const findReply = (id: string) => bot.outbound.find(call => call.body?.replyToken === 'reply-'+id)?.body.messages[0].text;
  assert.match(findReply('2'),/晩ごはん候補/);
  assert.equal(findReply('2'), findReply('3'));
  await bot.post([{ ...message('4','晩ごはん修正 2026-11-22 親子丼'),timestamp:time+200 }],undefined,time+300);
  await bot.post([{ ...message('5','明日の献立'),timestamp:time+300 }],undefined,time+400);
  assert.match(findReply('5'),/簡易案/);
  assert.equal(bot.outbound.filter(call=>call.url.includes('api.openai.com')).length,1);
  assert.equal(bot.sqlite.prepare('SELECT input_tokens FROM usage_attempts').get()!.input_tokens,120);
});
