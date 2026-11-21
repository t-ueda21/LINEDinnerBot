import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const replies = [];
const outboundRequests = [];
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  scriptPath: 'dist/worker.js',
  compatibilityDate: '2026-11-19',
  d1Databases: { DB: 'local-smoke' },
  bindings: {
    LINE_CHANNEL_SECRET: 'fixture-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'fixture-token',
    LINE_BOT_USER_ID: 'Utestbot',
    LINE_ADMIN_USER_ID: 'Uadmin',
    EVENT_KEY_SECRET: 'fixture-identifier-key',
  },
  outboundService: async request => {
    outboundRequests.push(request.url);
    if (new URL(request.url).pathname !== '/v2/bot/message/reply') return new Response(null, { status: 404 });
    replies.push(await request.json());
    return new Response(null, { status: 200 });
  },
}));

try {
  const db = await mf.getD1Database('DB');
  const sql = readFileSync('migrations/0001_initial.sql', 'utf8').replaceAll('\r\n','\n').trim();
  const statements = sql.split(/;\n+(?=(?:CREATE|INSERT INTO group_settings))/).map(statement => db.prepare(statement.trim()));
  await db.batch(statements);
  const now = Date.now();
  await db.prepare("UPDATE group_settings SET group_id='Cfamily',status='active',approved_at_ms=?,epoch=1").bind(now-1000).run();
  const body = JSON.stringify({
    destination: 'Utestbot', events: [{
      type: 'message', webhookEventId: 'runtime-test', timestamp: now, mode: 'active', replyToken: 'fixture-reply',
      source: { type: 'group', userId: 'Ufamily', groupId: 'Cfamily' },
      message: { type: 'text', id: '777', text: '晩ごはん 鮭' },
    }],
  });
  const send = signature => mf.dispatchFetch('https://example.test/line/webhook', {
    method: 'POST', body, headers: { 'X-Line-Signature': signature },
  });
  assert.equal((await send('bogus')).status, 401);
  const signature = createHmac('sha256','fixture-secret').update(body).digest('base64');
  assert.equal((await send(signature)).status, 200);
  assert.equal((await send(signature)).status, 200);
  for (let i = 0; i < 50 && !replies.length; i++) await delay(20);
  assert.equal((await db.prepare('SELECT dishes_json FROM meal_days').first()).dishes_json, '["鮭"]');
  assert.equal((await db.prepare('SELECT history_rev FROM group_settings').first()).history_rev, 1);
  const reply = await db.prepare('SELECT reply_used FROM webhook_events').first();
  assert.equal(replies.length, 1, JSON.stringify({ reply, outboundRequests }));
  assert.match(replies[0].messages[0].text, /鮭/);
  console.log('Worker runtime and D1 smoke passed with a stubbed LINE reply.');
} finally {
  await mf.dispose();
}
