export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const JST = 9 * 60 * MINUTE;

export function jstDate(time: number) {
  return new Date(time + JST).toISOString().slice(0, 10);
}

export function jstMidnight(date: string) {
  return Date.parse(date + 'T00:00:00Z') - JST;
}

export function shiftDate(date: string, days: number) {
  return jstDate(jstMidnight(date) + days * DAY);
}

export function jstMinute(time: number) {
  const shifted = new Date(time + JST);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

export function validDate(date: string) {
  const midnight = jstMidnight(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(midnight) && jstDate(midnight) === date;
}

export function parseDishes(value: string) {
  if (!value || [...value].length > 120 || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const parts = value.split('、').map(part => part.trim());
  return parts.every(Boolean) ? parts : null;
}

export function dishKey(name: string) {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export type Command =
  | { type: 'register' | 'edit'; date: string; dishes: string[] }
  | { type: 'delete'; date: string }
  | { type: 'photo-confirm'; dishes: string[] | null }
  | { type: 'history' | 'trends' | 'recommend' | 'photo' | 'photo-cancel' | 'invalid' | 'ignore' };

const commands = [
  ['晩ごはん修正', 'edit'], ['晩ごはん削除', 'delete'], ['晩ごはん確定', 'photo-confirm'],
  ['晩ごはん取消', 'photo-cancel'], ['写真で晩ごはん', 'photo'], ['明日の献立', 'recommend'],
  ['献立履歴', 'history'], ['献立傾向', 'trends'], ['晩ごはん', 'register'],
] as const;

export function parseCommand(value: string, eventTime: number, now: number): Command {
  const text = value.trim();
  const invalid = { type: 'invalid' } as const;
  for (const [name, type] of commands) {
    if (text !== name && !text.startsWith(name + ' ') && !text.startsWith(name + '　')) continue;
    const input = text.slice(name.length).trim();
    if (type === 'photo-confirm') {
      const dishes = input ? parseDishes(input) : null;
      return input && !dishes ? invalid : { type, dishes };
    }
    if (type !== 'register' && type !== 'edit' && type !== 'delete') return input ? invalid : { type };
    const [first] = input.split(/[ 　]+/, 1);
    const explicit = type !== 'register' || /^\d{4}-\d/.test(first);
    const date = explicit ? first : jstDate(eventTime);
    const today = jstDate(now);
    if (!validDate(date) || date > today || date < shiftDate(today, -364)) return invalid;
    const rest = explicit ? input.slice(first.length).trim() : input;
    if (type === 'delete') return rest ? invalid : { type, date };
    const dishes = parseDishes(rest);
    return dishes ? { type, date, dishes } : invalid;
  }
  return { type: 'ignore' };
}
