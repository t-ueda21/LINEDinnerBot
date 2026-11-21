import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DAY = 86_400_000;
const JST = 32_400_000;
const MAX_BACKUP_AGE = 28 * DAY;
const todayAt = (now, offset = 0) => new Date(now + JST + offset * DAY).toISOString().slice(0,10);
const keyed = value => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
const groupId = value => typeof value === 'string' && /^C[a-f\d]{32}$/i.test(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const integer = value => Number.isSafeInteger(value) && value >= 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function openDatabase() {
  const { CLOUDFLARE_ACCOUNT_ID: account, D1_DATABASE_ID: database, CLOUDFLARE_API_TOKEN: token } = process.env;
  assert(/^[a-f\d]{32}$/i.test(account ?? '') &&
    /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(database ?? '') && token,
  'CLOUDFLARE_ACCOUNT_ID、D1_DATABASE_ID、CLOUDFLARE_API_TOKEN が必要。');
  const submit = async body => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert(response.ok, 'Cloudflare D1 API に接続できなかった。HTTP ' + response.status);
    const data = await response.json();
    assert(data.success && Array.isArray(data.result) && data.result.every(entry => entry.success), 'D1 の操作に失敗した。');
    return data.result;
  };
  const query = async (sql, ...params) => (await submit({ sql, params: params.map(String) }))[0];
  const batch = async statements => submit({ batch: statements.map(([sql,...params]) => ({ sql, params: params.map(String) })) });
  return { query, batch };
}

const audit = (action, reason, time) =>
  ['INSERT INTO admin_log(action,reason,timestamp_ms) VALUES (?,?,?)',action,reason,time];

export function recoverableRows(backup, journal, group, now) {
  assert(backup?.format === 1 && journal?.format === 1 && backup.group === group && journal.group === group,
    'バックアップと削除照合の形式またはグループが一致しない。');
  assert(integer(backup.createdAt) && integer(journal.createdAt) && integer(journal.pausedAt) &&
    backup.createdAt >= now-MAX_BACKUP_AGE && backup.createdAt <= journal.createdAt &&
    journal.pausedAt <= journal.createdAt && journal.createdAt <= now && now-journal.createdAt <= DAY,
  'バックアップの保持期限または停止後に取得した最新の削除照合時刻を確認してね。');
  assert(Array.isArray(backup.rows) && backup.rows.length <= 365 && Array.isArray(journal.removed) &&
    journal.removed.length <= 365,'復旧データの件数が不正。');
  const removed = new Map();
  for (const entry of journal.removed) {
    assert(validDate(entry?.meal_date) && integer(entry?.max_removed_version) && integer(entry?.recorded_at_ms), '削除照合の行が不正。');
    removed.set(entry.meal_date, Math.max(removed.get(entry.meal_date) ?? 0,entry.max_removed_version));
  }
  const dates = new Set();
  return backup.rows.filter(row => {
    assert(validDate(row?.meal_date) && integer(row?.version) && row.version > 0 && integer(row?.event_time_ms) &&
      integer(row?.updated_at_ms) && keyed(row?.event_key) && keyed(row?.source_key) &&
      (row.photo_key === null || keyed(row.photo_key)) && typeof row.dishes_json === 'string', 'バックアップの行が不正。');
    const dishes = JSON.parse(row.dishes_json);
    assert(Array.isArray(dishes) && dishes.length > 0 && dishes.every(dish => typeof dish === 'string' && dish.trim() &&
      !/[\p{Cc}\p{Cf}]/u.test(dish)) && [...dishes.join('、')].length <= 120, '料理名の形式が不正。');
    assert(!dates.has(row.meal_date),'バックアップの日付が重複している。');
    dates.add(row.meal_date);
    return row.meal_date >= todayAt(now,-364) && row.meal_date <= todayAt(now) &&
      row.version > (removed.get(row.meal_date) ?? 0);
  });
}

function requiredReason(value) {
  assert(value && value.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(value),'120文字以内の作業理由を指定してね。');
  return value;
}

function expiry(value, now) {
  const time = Date.parse(value ?? '');
  assert(Number.isSafeInteger(time) && time > now && /(?:Z|[+-]\d{2}:\d{2})$/.test(value ?? ''), '将来の期限を時差付き ISO 時刻で指定してね。');
  return time;
}

async function currentGroup(db) {
  return (await db.query('SELECT * FROM group_settings WHERE singleton=1')).results[0];
}

async function approve(db, args, now) {
  const [group, reason] = args;
  assert(groupId(group),'確認した LINE グループ ID を指定してね。');
  const steps = await db.batch([
    [`UPDATE group_settings SET group_id=?,status='active',epoch=epoch+1,approved_at_ms=?,updated_at_ms=?,
      suggestions_enabled=0,photos_enabled=0,push_enabled=0,ai_valid_until_ms=NULL,images_valid_until_ms=NULL,ai_hold_code=NULL
      WHERE singleton=1 AND ((status='paused' AND group_id=?) OR
        ((status='unbound' OR (status='left' AND group_id=?)) AND
        EXISTS(SELECT 1 FROM group_claim WHERE used_at_ms IS NOT NULL AND candidate_group_id=? AND expires_at_ms>?))) RETURNING group_id`,
      group,now,now,group,group,group,now],
    [`DELETE FROM group_claim WHERE candidate_group_id=? AND EXISTS(
      SELECT 1 FROM group_settings WHERE singleton=1 AND status='active' AND group_id=? AND approved_at_ms=?)`,group,group,now],
    audit('approve',requiredReason(reason),now),
  ]);
  assert(steps[0].results.length === 1,'期限内の確認候補、または停止中の同じグループが必要。');
  console.log('グループを承認した。AI・写真・定時通知は停止状態。');
}

async function configure(db, args, now) {
  const [feature, mode, arg, reason, photoExpiry] = args;
  assert(['suggestions','photos','push'].includes(feature) && ['on','off'].includes(mode),'feature の用途または on/off が不正。');
  const column = feature + '_enabled';
  let sql, values;
  if (mode === 'off') {
    sql = `UPDATE group_settings SET ${column}=0,epoch=epoch+1,updated_at_ms=? WHERE singleton=1`;
    values = [now];
  } else if (feature === 'push') {
    const [,h,m] = /^(\d{2}):(\d{2})$/.exec(arg ?? '') ?? [];
    assert(h && Number(h) <= 23 && Number(m) <= 59 && Number(m)%5 === 0, 'JST の時刻を5分刻みの HH:MM で指定してね。');
    sql = `UPDATE group_settings SET push_enabled=1,push_minute_jst=?,epoch=epoch+1,updated_at_ms=?
      WHERE singleton=1 AND status='active' RETURNING group_id`;
    values = [Number(h)*60+Number(m),now];
  } else {
    const until = expiry(arg,now);
    const imageClause = feature === 'photos' ? ',images_valid_until_ms=?' : '';
    sql = `UPDATE group_settings SET ${column}=1,ai_valid_until_ms=?,ai_hold_code=NULL,epoch=epoch+1,updated_at_ms=?${imageClause}
      WHERE singleton=1 AND status='active' RETURNING group_id`;
    values = feature === 'photos' ? [until,now,expiry(photoExpiry,now)] : [until,now];
  }
  const [result] = await db.batch([[sql,...values],audit(feature+'_'+mode,requiredReason(reason),now)]);
  if (mode === 'on') assert(result.results.length === 1,'承認済みグループが必要。');
  console.log(feature + ' ' + mode);
}

const meals = `SELECT meal_date,dishes_json,version,event_time_ms,event_key,source_key,photo_key,updated_at_ms
  FROM meal_days WHERE group_id=? AND dishes_json IS NOT NULL AND meal_date BETWEEN ? AND ? ORDER BY meal_date`;

async function exportData(db, command, file, now) {
  assert(file, '秘密データも保護できるローカル保存先を指定してね。');
  const group = await currentGroup(db);
  assert(group?.group_id,'グループ ID が設定されていない。');
  if (command === 'export-journal') {
    assert(group.status === 'paused','削除照合ファイルは停止中に取得してね。');
    const removed = (await db.query('SELECT meal_date,max_removed_version,recorded_at_ms FROM deletion_journal WHERE group_id=? AND meal_date>=?',
      group.group_id,todayAt(now,-364))).results;
    await writeFile(file,JSON.stringify({ format:1,group:group.group_id,createdAt:now,pausedAt:group.updated_at_ms,removed }),{ flag:'wx',mode:0o600 });
  } else {
    const rows = (await db.query(meals,group.group_id,todayAt(now,-364),todayAt(now))).results;
    const csvCell = value => {
      const text = String(value);
      return '"' + (/^[=+\-@\t\r]/.test(text.trimStart()) ? "'" : '') + text.replaceAll('"','""') + '"';
    };
    const data = command === 'export-csv' ? '食事日,料理\r\n' + rows.map(row =>
      [row.meal_date,JSON.parse(row.dishes_json).join('、')].map(csvCell).join(',')).join('\r\n') + '\r\n' :
      JSON.stringify({ format:1,group:group.group_id,createdAt:now,rows });
    await writeFile(file,data,{ flag:'wx',mode:0o600 });
  }
}

async function restore(db, command, args, now) {
  const [backupPath,journalPath,expectedGroup,confirmation] = args;
  assert(backupPath && journalPath && groupId(expectedGroup),'バックアップ、最新の削除照合ファイル、対象グループ ID が必要。');
  const backup = JSON.parse(await readFile(backupPath,'utf8'));
  const journal = JSON.parse(await readFile(journalPath,'utf8'));
  const rows = recoverableRows(backup,journal,expectedGroup,now);
  if (command === 'restore-preview') {
    console.log('復旧対象 ' + rows.length + ' 日分。除外 ' + (backup.rows.length-rows.length) + ' 日分。');
    return;
  }
  assert(confirmation === 'EMPTY_PAUSED_TARGET','空で停止中の復旧用 DB を指定し、EMPTY_PAUSED_TARGET を指定してね。');
  const group = await currentGroup(db);
  assert(group?.group_id === expectedGroup && group.status === 'paused' && !group.push_enabled &&
    !group.photos_enabled && !group.suggestions_enabled,'復旧対象は停止中の同じグループで、各送信機能も停止が必要。');
  const [result] = await db.batch([
    [`INSERT INTO meal_days(group_id,meal_date,dishes_json,version,event_time_ms,event_key,source_key,photo_key,updated_at_ms)
       SELECT g.group_id,json_extract(j.value,'$.meal_date'),json_extract(j.value,'$.dishes_json'),
              json_extract(j.value,'$.version'),json_extract(j.value,'$.event_time_ms'),json_extract(j.value,'$.event_key'),
              json_extract(j.value,'$.source_key'),json_extract(j.value,'$.photo_key'),json_extract(j.value,'$.updated_at_ms')
       FROM json_each(?) j JOIN group_settings g ON g.group_id=? AND g.status='paused' AND g.epoch=?
       WHERE NOT EXISTS(SELECT 1 FROM meal_days) AND NOT EXISTS(SELECT 1 FROM push_deliveries)
       AND NOT EXISTS(SELECT 1 FROM usage_attempts) RETURNING meal_date`,JSON.stringify(rows),expectedGroup,group.epoch],
    [`INSERT INTO deletion_journal(group_id,meal_date,max_removed_version,recorded_at_ms)
       SELECT g.group_id,json_extract(j.value,'$.meal_date'),json_extract(j.value,'$.max_removed_version'),
              json_extract(j.value,'$.recorded_at_ms')
       FROM json_each(?) j JOIN group_settings g ON g.group_id=? AND g.status='paused' AND g.epoch=?
       WHERE changes()=CAST(? AS INTEGER) AND NOT EXISTS(SELECT 1 FROM push_deliveries) AND NOT EXISTS(SELECT 1 FROM usage_attempts)
       ON CONFLICT(group_id,meal_date) DO UPDATE SET max_removed_version=MAX(max_removed_version,excluded.max_removed_version),
         recorded_at_ms=MAX(recorded_at_ms,excluded.recorded_at_ms)`,
      JSON.stringify(journal.removed),expectedGroup,group.epoch,rows.length],
    audit('restore','空の復旧先へ照合済みの履歴を登録',now),
  ]);
  assert(result.results.length === rows.length,'復旧先が空で停止中であることを再確認してね。');
  console.log('復旧した日数: ' + rows.length + '。グループは停止状態。');
}

async function main() {
  const [command,...args] = process.argv.slice(2);
  const supported = ['status','claim','approve','pause','feature','export-csv','export-backup','export-journal','restore-preview','restore'];
  assert(supported.includes(command),'管理コマンド: ' + supported.join(', '));
  const now = Date.now();
  if (command === 'restore-preview') return restore(null,command,args,now);
  const db = await openDatabase();
  if (command === 'status') {
    const group = await currentGroup(db);
    const candidate = (await db.query('SELECT candidate_group_id,expires_at_ms FROM group_claim WHERE singleton=1')).results[0];
    const push = (await db.query('SELECT target_date,state,last_result,reserved_count FROM push_deliveries ORDER BY target_date DESC LIMIT 5')).results;
    const usage = (await db.query(`SELECT kind,month_jst,count(*) AS attempts,
      SUM(input_tokens) AS reported_input_tokens,SUM(output_tokens) AS reported_output_tokens
      FROM usage_attempts WHERE month_jst=? GROUP BY kind,month_jst`,todayAt(now).slice(0,7))).results;
    console.log(JSON.stringify({ group,candidate,push,usage },null,2));
  } else if (command === 'claim') {
    const code = randomBytes(16).toString('hex');
    const group = await currentGroup(db);
    assert(group && ['unbound','left'].includes(group.status),'未登録か退出状態でだけ確認コードを発行できる。');
    await db.query(`INSERT INTO group_claim(singleton,code_hash,expires_at_ms) VALUES (1,?,?)
      ON CONFLICT(singleton) DO UPDATE SET code_hash=excluded.code_hash,expires_at_ms=excluded.expires_at_ms,used_at_ms=NULL,candidate_group_id=NULL`,
      createHash('sha256').update(code).digest('hex'),now+600_000);
    console.log('管理者本人が承認したい家族グループへ送信（10分以内）\n晩ごはんBot確認 ' + code);
  } else if (command === 'approve') {
    await approve(db,args,now);
  } else if (command === 'pause') {
    await db.batch([
      [`UPDATE group_settings SET status='paused',epoch=epoch+1,suggestions_enabled=0,photos_enabled=0,push_enabled=0,updated_at_ms=?
        WHERE singleton=1 AND status IN ('active','paused')`,now],
      ['DELETE FROM photo_sessions'],
      audit('pause',requiredReason(args[0]),now),
    ]);
  } else if (command === 'feature') {
    await configure(db,args,now);
  } else if (command.startsWith('export-')) {
    await exportData(db,command,args[0],now);
  } else {
    await restore(db,command,args,now);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : '管理操作に失敗した。');
    process.exitCode = 1;
  });
}
