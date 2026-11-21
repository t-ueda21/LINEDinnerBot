import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { reserveUsage } from '../src/ai.ts';
import { jstDate, parseCommand } from '../src/domain.ts';
import { getImage, sendReply } from '../src/line.ts';
import { inspectJpeg } from '../src/photo-image.ts';
import { readHistory } from '../src/recommendations.ts';
import { runSchedule } from '../src/scheduled.ts';
import { handleWebhook } from '../src/worker.ts';
import { recoverableRows } from '../scripts/admin.mjs';

const start = Date.parse('2026-11-22T12:00:00Z');
const DAY = 86_400_000;
const group = 'C' + '1'.repeat(32);
const other = 'C' + '2'.repeat(32);
const owner = 'U-owner-fixture';
const stranger = 'U-other-fixture';
const secret = 'fixture-channel-secret';
const JPEG = Uint8Array.from([
  255,216, 255,225,0,6, 1,2,3,4, 255,192,0,11,8,0,1,0,1,1,1,17,0,
  255,218,0,8,1,1,0,0,63,0, 0,255,217,
]);
const migration = readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8').replaceAll('\r\n','\n').trim()
  .split(/;\n+(?=(?:CREATE|INSERT INTO group_settings))/);

function text(id: string, input: string, timestamp = start, userId = owner, groupId = group) {
  return { type:'message', timestamp, webhookEventId:'event-'+id, replyToken:'reply-'+id,
    source:{ type:'group',groupId,userId }, message:{ type:'text',id,text:input }, mode:'active' };
}
function photo(id: string, timestamp = start+200, userId = owner, groupId = group) {
  return { ...text(id,'',timestamp,userId,groupId), message:{ type:'image',id,contentProvider:{type:'line'} } };
}
function unsend(id: string, timestamp = start+750) {
  return { ...text('unsend-'+id,'',timestamp), type:'unsend', message:undefined, unsend:{ messageId:id } };
}
function mockAI(value: object) {
  return Response.json({status:'completed',usage:{input_tokens:100,output_tokens:20},output:[{
    type:'message',content:[{ type:'output_text',text:JSON.stringify(value) }],
  }]});
}

async function fixture(t: TestContext) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules:true, script:'export default { fetch(){ return new Response("test"); } }',
    compatibilityDate:'2026-11-19', d1Databases:{DB:'phase-cases'},
  }));
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  await DB.batch(migration.map(sql=>DB.prepare(sql.trim())));
  await DB.prepare("UPDATE group_settings SET group_id=?, status='active', epoch=1, approved_at_ms=?").bind(group,start-2*DAY).run();
  const env = { DB, LINE_CHANNEL_SECRET:secret, LINE_CHANNEL_ACCESS_TOKEN:'fixture-line-token',
    LINE_BOT_USER_ID:'U-bot-fixture', LINE_ADMIN_USER_ID:owner, EVENT_KEY_SECRET:'fixture-pseudonym-key',
    OPENAI_API_KEY:'fixture-api-key',
    IMAGES: {
      input: () => ({
        transform: () => ({
          output: async () => ({ response: () => new Response(JPEG) }),
        }),
      }),
    },
  };
  const calls: { url: string; init?: RequestInit; body: any }[] = [];
  const state = {
    now: start+100,
    uuid: 'line-accepted',
    members: 4 as number | null,
    consumed: 196,
    image: () => new Response(JPEG,{headers:{'content-type':'image/jpeg'}}),
    ai: () => mockAI({status:'ok',dishes:['焼き魚']}),
    push: () => new Response(null,{status:200}),
  };
  const runtime = { now:()=>state.now, fetcher:async (request: string|URL|Request, init?: RequestInit) => {
    const url = String(request);
    calls.push({url,init,body:init?.body ? JSON.parse(String(init.body)) : null});
    if (url.includes('api-data.line.me')) return state.image();
    if (url.includes('api.openai.com')) return state.ai();
    if (url.endsWith('/members/count')) return Response.json({count:state.members});
    if (url.endsWith('/quota/consumption')) return Response.json({totalUsage:state.consumed});
    if (url.endsWith('/quota')) return Response.json({type:'limited',value:200});
    if (url.endsWith('/push')) return state.push();
    if (url.endsWith('/reply')) return new Response(null,{status:200});
    throw new Error('Unexpected test destination');
  }};
  async function post(events: unknown[], now = state.now, signature?: string) {
    state.now = now;
    const body = JSON.stringify({destination:env.LINE_BOT_USER_ID,events});
    const request = new Request('https://fixture.test/line/webhook',{method:'POST',body,headers:{
      'X-Line-Signature':signature ?? createHmac('sha256',secret).update(body).digest('base64'),
    }});
    const pending: Promise<unknown>[] = [];
    const result = await handleWebhook(request,env,{waitUntil:(task:Promise<unknown>)=>pending.push(task)},runtime);
    await Promise.all(pending);
    return result.status;
  }
  const query = (sql: string, ...bindings: unknown[]) => DB.prepare(sql).bind(...bindings).all();
  const run = (sql: string, ...bindings: unknown[]) => DB.prepare(sql).bind(...bindings).run();
  const setting = async () => (await query('SELECT * FROM group_settings')).results[0];
  const rows = async () => (await query("SELECT meal_date,dishes_json FROM meal_days WHERE dishes_json IS NOT NULL ORDER BY meal_date")).results;
  const reply = (id: string) => calls.find(call=>call.body?.replyToken==='reply-'+id)?.body.messages[0].text as string | undefined;
  const count = (needle: string) => calls.filter(call=>call.url.includes(needle)).length;
  const enablePhotos = () => run('UPDATE group_settings SET photos_enabled=1,ai_valid_until_ms=?,images_valid_until_ms=?',start+30*DAY,start+30*DAY);
  const enableAI = () => run('UPDATE group_settings SET suggestions_enabled=1,ai_valid_until_ms=?',start+30*DAY);
  return {env,post,query,run,setting,rows,reply,count,state,runtime,calls,enablePhotos,enableAI};
}

type Trial = (t: TestContext) => Promise<void> | void;

const ingress: Trial = async t => {
  const f=await fixture(t);
  assert.equal(await f.post([text('bad','晩ごはん カレー')],start+100,'bad'),401);
  assert.equal(await f.post([]),200);
  const direct = { ...text('d','晩ごはん サラダ'), source:{type:'user',userId:owner} };
  await f.post([direct,text('g','晩ごはん スープ',start,owner,other),text('unauth','通知を有効化',start,stranger),
    text('a','晩ごはん 鮭')]);
  assert.equal((await f.rows()).length,1);
  assert.equal(f.count('/reply'),1);
  assert.equal(f.count('openai'),0);
  assert.equal((await f.setting()).push_enabled,0);
};

const dates: Trial = () => {
  const jstBoundary = Date.parse('2026-11-30T15:00:00Z');
  assert.equal(jstDate(jstBoundary-1),'2026-11-30');
  assert.equal(jstDate(jstBoundary),'2026-12-01');
  assert.equal(parseCommand('晩ごはん 2026-02-29 煮物',start,start).type,'invalid');
  assert.equal(parseCommand('晩ごはん 2026-11-23 カレー',start,start).type,'invalid');
  assert.equal(parseCommand('晩ごはん '+ 'あ'.repeat(120),start,start).type,'register');
  assert.equal(parseCommand('晩ごはん '+ 'あ'.repeat(121),start,start).type,'invalid');
  assert.equal(parseCommand('晩ごはん 鮭、、サラダ',start,start).type,'invalid');
};

const history: Trial = async t => {
  const f=await fixture(t);
  await f.post([
    text('outside','晩ごはん 2026-10-20 スープ'),
    text('record','晩ごはん 2026-11-20 サバ、サバ、温野菜'),
    text('today','晩ごはん 焼き魚、温野菜'),
    text('invalid','晩ごはん 2026-11-32 みそ汁'),
  ]);
  await f.post([text('edit','晩ごはん修正 2026-11-20 サバ、温野菜',start+200),
    { ...text('line-edit','晩ごはん 焼肉',start+200),type:'messageEdited' },
    text('h','献立履歴',start+300),text('t','献立傾向',start+300)],start+400);
  assert.match(f.reply('h') ?? '',/2026-11-20.*サバ.*2026-11-22.*焼き魚/s);
  assert.doesNotMatch(f.reply('h')!,/スープ|焼肉/);
  assert.match(f.reply('t') ?? '',/2日分.*温野菜：2回.*サバ：1回/s);
  assert.match(f.reply('invalid') ?? '',/入力/);
  const snapshot = await readHistory(f.env,await f.setting() as any,'2026-11-22','2026-11-22');
  assert.equal(snapshot.frequencies.get('温野菜')?.count,2);
};

const write: Trial = async t => {
  const f=await fixture(t);
  const first = text('first','晩ごはん カレー'), second = text('second','晩ごはん 焼き魚',start,stranger);
  await Promise.all([f.post([first],start+100),f.post([second],start+100)]);
  assert.equal((await f.rows()).length,1);
  assert.ok(/記録済み/.test(f.reply('first') ?? '') || /記録済み/.test(f.reply('second') ?? ''));
  await f.post([first,second],start+200);
  assert.equal(f.count('/reply'),2);
  await f.post([unsend('blocked',start+300)],start+301);
  await f.post([text('blocked','晩ごはん 2026-11-21 玉子',start+250)],start+400);
  assert.equal((await f.rows()).length,1);
  await f.post([text('changed','晩ごはん修正 2026-11-22 親子丼',start+500)],start+600);
  await f.post([unsend('first'),unsend('second')],start+800);
  assert.equal((await f.rows())[0].dishes_json,'["親子丼"]');
  await f.post([unsend('changed',start+900)],start+901);
  assert.deepEqual(await f.rows(),[]);
};

const suggest: Trial = async t => {
  const f=await fixture(t);
  const end=Date.parse('2026-11-30T13:00:00Z');
  await f.post([text('empty','明日の献立',end)],end+100);
  assert.match(f.reply('empty') ?? '',/2026-12-01.*簡易案.*一般的/s);
  const meals = Array.from({length:7},(_,i)=>text('m'+i,`晩ごはん 2026-11-${24+i} さばの塩焼き、温野菜`,end+i));
  await f.post(meals,end+100);
  await f.post([text('rich','明日の献立',end+200)],end+300);
  const selected = f.reply('rich') ?? '';
  assert.match(selected,/7日分.*さばの塩焼き（7回）/s);
  assert.equal(selected.split('\n').filter(line=>line.startsWith('・')).length,3);
  assert.doesNotMatch(selected,/・さばの塩焼き/);
};

const ai: Trial = async t => {
  const f=await fixture(t);
  await f.enableAI();
  f.state.ai=()=>mockAI({candidates:[{main:'肉じゃが',side:null,reason_ids:[]},{main:'鶏の照り焼き',side:'温野菜',reason_ids:[]}]});
  await f.post([text('record','晩ごはん カレー、taro@example.test'),text('talk','秘密メモ')]);
  await f.post([text('a','明日の献立'),text('b','明日の献立')]);
  assert.equal(f.count('openai'),1);
  const request = f.calls.find(call=>call.url.includes('openai'))!.body;
  assert.equal(request.store,false);
  assert.deepEqual(request.tools,[]);
  assert.doesNotMatch(JSON.stringify(request),/example\.test|秘密メモ|U-owner|晩ごはん カレー|input_image/);
  await f.post([text('repeat','明日の献立',start+300)],start+400);
  assert.match(f.reply('repeat') ?? '',/肉じゃが/);
  assert.equal(f.count('openai'),1);
  await f.post([text('edit','晩ごはん修正 2026-11-22 親子丼',start+500)],start+600);
  await f.post([text('latest','明日の献立',start+700)],start+800);
  assert.match(f.reply('latest') ?? '',/簡易案/);
  assert.equal(f.count('openai'),1);
};

const usage: Trial = async t => {
  const f=await fixture(t);
  await f.enablePhotos();
  await f.enableAI();
  const settings=await f.setting() as any;
  const attempts = await Promise.all(Array.from({length:32},(_,i)=>reserveUsage(f.env,settings,'photo_ai','target-'+i,start)));
  assert.equal(attempts.filter(Boolean).length,31);
  assert.equal(await reserveUsage(f.env,settings,'recommendation','target-0',start),true);
  assert.equal(await reserveUsage(f.env,settings,'photo_ai','target-0',start+12*DAY),false);
  assert.equal(await reserveUsage(f.env,settings,'photo_ai','unique',start+12*DAY),true);
};

const aiFailures: Trial = async t => {
  const f=await fixture(t);
  await f.post([text('save','晩ごはん カレー')]);
  await f.post([text('off','明日の献立')]);
  assert.equal(f.count('openai'),0);
  assert.match(f.reply('off') ?? '',/簡易案/);
  await f.enableAI();
  f.state.ai=()=>Response.json({error:{code:'insufficient_quota'}},{status:429});
  await f.post([text('cut','明日の献立')]);
  assert.match(f.reply('cut') ?? '',/簡易案/);
  assert.equal((await f.setting()).ai_hold_code,'quota');
  await f.post([text('next','明日の献立',start+DAY)],start+DAY+100);
  assert.equal(f.count('openai'),1);
  assert.equal(f.count('/push'),0);
};

const imageSource: Trial = async t => {
  const f=await fixture(t);
  let calls = 0;
  const proxy = { ...f.runtime,fetcher:async (_url: unknown,init: RequestInit) => {
    calls++;
    assert.equal(init.redirect,'manual');
    return new Response(JPEG,{headers:{'content-type':'image/jpeg','content-length':'5000001'}});
  }};
  assert.equal(await getImage(f.env,proxy,'https://other.invalid',start+1000),null);
  assert.equal(calls,0);
  assert.equal(await getImage(f.env,proxy,'123',start+1000),null);
  assert.equal(calls,1);
  f.state.image=()=>new Response(JPEG,{headers:{'content-type':'image/png'}});
  await f.enablePhotos();
  await f.post([text('declare','写真で晩ごはん')]);
  await f.post([photo('121')],start+350);
  assert.equal(f.count('openai'),0);
  assert.match(f.reply('121') ?? '',/料理名/);
};

const clean: Trial = () => {
  const result=inspectJpeg(JPEG,true);
  assert.equal(result?.width,1);
  assert.equal(result?.height,1);
  assert.ok(!Buffer.from(result!.bytes).includes(Buffer.from([255,225])));
  assert.equal(inspectJpeg(JPEG.subarray(0,JPEG.length-1),true),null);
  assert.equal(inspectJpeg(Uint8Array.from([...JPEG,1]),true),null);
};

const images: Trial = async t => {
  const f=await fixture(t);
  await f.enablePhotos();
  await f.post([photo('100')],start+250);
  await f.post([text('declare','写真で晩ごはん')],start+250);
  await f.post([photo('101',start+300,stranger),photo('102',start+310,owner,other),photo('103',start+320)],start+350);
  assert.match(f.reply('declare') ?? '',/OpenAI/);
  assert.equal(f.count('api-data'),1);
  assert.equal(f.count('openai'),1);
  const api = f.calls.find(call=>call.url.includes('openai'))?.body;
  assert.equal(api.store,false);
  const data = api.input[0].content[0].image_url as string;
  assert.ok(!Buffer.from(data.split(',')[1],'base64').includes(Buffer.from([255,225])));
  assert.doesNotMatch(JSON.stringify(api),/U-owner|C111111111/);
  assert.deepEqual(await f.rows(),[]);
  await f.post([text('stranger','晩ごはん確定',start+500,stranger)],start+600);
  assert.deepEqual(await f.rows(),[]);
  const nextDay=Date.parse('2026-11-22T15:00:00Z');
  // 認識を23:59に開始し、翌日直後の確定でも元の食事日を維持する。
  await f.post([text('cancel-early','晩ごはん取消',start+800)],start+900);
  await f.run('DELETE FROM usage_attempts'); // 新しい試験シナリオの枠にリセット
  await f.post([text('late','写真で晩ごはん',nextDay-60_000)],nextDay-59_950);
  await f.post([photo('104',nextDay-5_000)],nextDay-4_950);
  await f.post([text('confirm','晩ごはん確定 鮭',nextDay+100)],nextDay+200);
  assert.deepEqual((await f.rows()).map(row=>[row.meal_date,row.dishes_json]),[['2026-11-22','["鮭"]']]);
  await f.post([unsend('104',nextDay+300)],nextDay+400);
  assert.deepEqual(await f.rows(),[]);
};

const photoEdges: Trial = async t => {
  const f=await fixture(t);
  await f.enablePhotos();
  let seen!: ()=>void;
  const sent=new Promise<void>(resolve=>{seen=resolve});
  let resolve!: (response:Response)=>void;
  f.state.ai=()=>{seen();return new Promise<Response>(callback=>{resolve=callback}) as unknown as Response;};
  await f.post([text('declare','写真で晩ごはん')]);
  const pending=f.post([photo('202',start+300)],start+400);
  await sent;
  await f.post([text('cancel','晩ごはん取消',start+500)],start+600);
  resolve(mockAI({status:'ok',dishes:['煮物']}));
  await pending;
  assert.equal(f.reply('202'),undefined);
  await f.post([text('confirm','晩ごはん確定',start+700)],start+800);
  assert.deepEqual(await f.rows(),[]);
  await f.post([text('next','写真で晩ごはん',start+1000)],start+1100);
  const before = f.count('api-data');
  await f.post([photo('203',start+301000)],start+301001);
  assert.equal(f.count('api-data'),before);
};

const retry: Trial = async t => {
  const f=await fixture(t);
  await f.run('UPDATE group_settings SET push_enabled=1');
  f.state.push=()=>new Response(null,{status:503});
  await Promise.all([runSchedule(f.env,f.runtime,start),runSchedule(f.env,f.runtime,start)]);
  assert.equal(f.count('/push'),1);
  const first=f.calls.find(call=>call.url.endsWith('/push'))!;
  f.state.push=()=>new Response(null,{status:409,headers:{'X-Line-Accepted-Request-Id':'fixture-push'}});
  f.state.now=start+5*60_000+100;
  await runSchedule(f.env,f.runtime,start+5*60_000);
  f.state.now=start+10*60_000+100;
  await runSchedule(f.env,f.runtime,start+10*60_000);
  const attempts=f.calls.filter(call=>call.url.endsWith('/push'));
  assert.equal(attempts.length,2);
  assert.deepEqual(attempts[1].body,first.body);
  assert.equal(new Headers(attempts[1].init?.headers).get('X-Line-Retry-Key'),new Headers(first.init?.headers).get('X-Line-Retry-Key'));
  assert.equal((await f.query('SELECT state FROM push_deliveries')).results[0].state,'accepted');
};

const quota: Trial = async t => {
  const f=await fixture(t);
  await runSchedule(f.env,f.runtime,start);
  assert.equal(f.count('/push'),0);
  await f.run('UPDATE group_settings SET push_enabled=1');
  f.state.consumed=197;
  await runSchedule(f.env,f.runtime,start);
  assert.equal(f.count('/push'),0);
  assert.equal((await f.query('SELECT state FROM push_deliveries')).results[0].state,'skipped');
  f.state.now=start+DAY+100;
  f.state.members=null;
  await runSchedule(f.env,f.runtime,start+DAY);
  assert.equal(f.count('/push'),0);
  assert.ok((await f.query('SELECT last_result FROM push_deliveries')).results.some(row=>row.last_result==='quota_unknown'));
  f.state.now=start+2*DAY+100;
  f.state.members=4;
  f.state.consumed=196;
  await runSchedule(f.env,f.runtime,start+2*DAY);
  assert.equal(f.count('/push'),1);
  f.state.now=start+4*DAY+100;
  await runSchedule(f.env,f.runtime,start+3*DAY);
  assert.equal(f.count('/push'),1);
};

const approval: Trial = async t => {
  const f=await fixture(t);
  await f.run("UPDATE group_settings SET status='unbound',group_id=NULL");
  const code='a'.repeat(32);
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code))).toString('hex');
  await f.run('INSERT INTO group_claim(singleton,code_hash,expires_at_ms) VALUES(1,?,?)',hash,start+50_000);
  await f.post([text('wrong','晩ごはんBot確認 '+code,start,stranger)]);
  assert.equal((await f.query('SELECT candidate_group_id FROM group_claim')).results[0].candidate_group_id,null);
  await f.post([text('claim','晩ごはんBot確認 '+code)]);
  assert.equal((await f.query('SELECT candidate_group_id FROM group_claim')).results[0].candidate_group_id,group);
  await f.post([text('copy','晩ごはんBot確認 '+code,start,owner,other),text('early','晩ごはん カレー')]);
  assert.deepEqual(await f.rows(),[]);
  // 管理端末の承認を模擬し、公開 Webhook だけで状態を切り替えられないことを確認する。
  await f.run("UPDATE group_settings SET status='active',group_id=?,epoch=2,approved_at_ms=?",group,start+100);
  await f.post([{...text('member','',start+200),type:'memberJoined',message:undefined},text('after','晩ごはん 鮭',start+300)],start+400);
  assert.equal((await f.setting()).status,'paused');
  assert.deepEqual(await f.rows(),[]);
  await f.run("UPDATE group_settings SET status='active',epoch=epoch+1,approved_at_ms=?",start+500);
  await f.post([text('reopened','晩ごはん 煮物',start+550)],start+600);
  assert.equal((await f.rows()).length,1);
  await f.post([{...text('leave','',start+650),type:'leave',message:undefined}],start+700);
  assert.equal((await f.setting()).status,'left');
};

const reply: Trial = async t => {
  const f=await fixture(t);
  const ctx = {group,epoch:1,key:'sample',source:null,timestamp:start,received:start,execution:'one',replyToken:'sample'};
  await f.run('INSERT INTO webhook_events(event_key,group_id,execution_id,expires_at_ms) VALUES(?,?,?,?)','sample',group,'one',start+DAY);
  assert.equal(await sendReply(f.env,f.runtime,ctx,'期限外',f.state.now),false);
  assert.equal(await sendReply(f.env,f.runtime,{...ctx,epoch:0},'未承認',start+1000),false);
  await Promise.all([sendReply(f.env,f.runtime,ctx,'返信',start+1000),sendReply(f.env,f.runtime,ctx,'重複',start+1000)]);
  assert.equal(f.count('/reply'),1);
  assert.equal(f.count('/push'),0);
};

const retention: Trial = async t => {
  const f=await fixture(t);
  const contents = (meal_date:string,version=1)=>({meal_date,version,event_time_ms:start-1000,updated_at_ms:start-1000,
    event_key:'a'.repeat(64),source_key:'b'.repeat(64),photo_key:null,dishes_json:'["焼き魚"]'});
  const backup={format:1,group,createdAt:start-1000,rows:[contents('2025-01-01'),contents('2026-11-21'),contents('2026-11-22',2)]};
  const journal={format:1,group,createdAt:start,pausedAt:start-100,removed:[{meal_date:'2026-11-21',max_removed_version:1,recorded_at_ms:start-200}]};
  assert.deepEqual(recoverableRows(backup,journal,group,start).map(row=>row.meal_date),['2026-11-22']);
  assert.throws(()=>recoverableRows(backup,{...journal,createdAt:start-2000},group,start));
  await f.run("INSERT INTO meal_days(group_id,meal_date,dishes_json,version,event_time_ms,event_key,updated_at_ms) VALUES(?,?,?,?,?,?,?)",
    group,'2025-01-01','["早い記録"]',1,start-1000,'old',start-1000);
  const maintenance = Date.parse('2026-11-22T18:00:00Z');
  f.state.now=maintenance+100;
  await runSchedule(f.env,f.runtime,maintenance);
  assert.deepEqual(await f.rows(),[]);
};

const trials: Record<string, Trial[]> = {
  UT:[ingress,dates,write,history,suggest,usage,photoEdges,imageSource,clean,images,reply,retry,quota,approval,retention],
  IT:[ingress,write,history,ai,usage,photoEdges,imageSource,clean,images,reply,retry,quota,approval,retention],
  ST:[ingress,approval,dates,write,history,write,history,suggest,ai,aiFailures,quota,retry,ai,aiFailures,retention,
    images,images,imageSource,photoEdges,images],
};

for (const [phase,cases] of Object.entries(trials)) {
  cases.forEach((verify,index)=>test(`${phase}-${String(index+1).padStart(2,'0')}`,verify));
}
