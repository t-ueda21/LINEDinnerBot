import { available, recordUsage, reserveUsage } from './ai.ts';
import { type Env, type Runtime, limitedBytes } from './environment.ts';
import { type Group, getGroup } from './store.ts';

const sof = new Set([0xc0,0xc1,0xc2]);
const imageMarkers = new Set([0xc0,0xc1,0xc2,0xc4,0xda,0xdb,0xdd]);

export function inspectJpeg(bytes: Uint8Array, strip = false) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  let width = 0, height = 0;
  let sawScan = false;
  let scanning = false;
  while (at < bytes.length) {
    if (scanning) {
      const start = at;
      for (;;) {
        at = bytes.indexOf(0xff, at);
        if (at < 0 || at + 1 >= bytes.length) return null;
        const next = bytes[at + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { at += 2; continue; }
        if (next === 0xff) { at++; continue; }
        break;
      }
      if (strip) kept.push(bytes.subarray(start, at));
      scanning = false;
    }
    const start = at;
    if (bytes[at++] !== 0xff) return null;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === 0xd9) {
      if (!width || !height || !sawScan || at !== bytes.length) return null;
      if (!strip) return { width, height, bytes };
      kept.push(bytes.subarray(start, at));
      const clean = new Uint8Array(kept.reduce((total, part) => total + part.length, 0));
      let offset = 0;
      for (const part of kept) { clean.set(part, offset); offset += part.length; }
      return { width, height, bytes: clean };
    }
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!metadata && !imageMarkers.has(marker)) return null;
    if (at + 1 >= bytes.length) return null;
    const length = (bytes[at] << 8) | bytes[at + 1];
    if (length < 2 || at + length > bytes.length) return null;
    if (sof.has(marker)) {
      if (width || length < 8) return null;
      height = (bytes[at + 3] << 8) | bytes[at + 4];
      width = (bytes[at + 5] << 8) | bytes[at + 6];
    }
    if (marker === 0xda) {
      if (!width || !height || length < 6) return null;
      sawScan = scanning = true;
    }
    at += length;
    if (strip && !metadata) kept.push(bytes.subarray(start, at));
  }
  return null;
}

function inspectPng(bytes: Uint8Array) {
  if (bytes.length < 33 || ![137,80,78,71,13,10,26,10].every((byte, i) => bytes[i] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null;
  let image = false;
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = view.getUint32(at), type = view.getUint32(at + 4);
    if (length > bytes.length - at - 12 || [0x6163544c,0x6663544c,0x66644154].includes(type)) return null;
    at += 12 + length;
    if (type === 0x49444154) image = true;
    if (type === 0x49454e44) return image && length === 0 && at === bytes.length
      ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
  }
  return null;
}

export async function normalizePhoto(
  env: Env, runtime: Runtime, group: Group, key: string, deadline: number, image: { mime: string; bytes: Uint8Array<ArrayBuffer> },
  stillAllowed: () => Promise<boolean>,
) {
  const info = image.mime === 'image/jpeg' ? inspectJpeg(image.bytes) : inspectPng(image.bytes);
  if (!info || info.width < 1 || info.height < 1 || Math.max(info.width, info.height) > 8192 ||
      info.width * info.height > 16_000_000 || !env.IMAGES || runtime.now() >= deadline ||
      !await stillAllowed() || !await reserveUsage(env, group, 'image_transform', key, runtime.now())) return null;
  let succeeded = false;
  try {
    const current = await getGroup(env.DB);
    if (current?.epoch !== group.epoch || !available(current, env, 'image_transform', runtime.now()) ||
        !await stillAllowed() || runtime.now() >= deadline) return null;
    const ratio = Math.min(1,1024 / Math.max(info.width, info.height));
    const resized = env.IMAGES.input(new Response(image.bytes).body!).transform({
      width: Math.max(1,Math.floor(info.width * ratio)), height: Math.max(1,Math.floor(info.height * ratio)),
    }).output({ format: 'image/jpeg', quality: 75 });
    const remaining = Math.min(6500, deadline - runtime.now());
    if (remaining <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([resized.then(async value => {
        const response = value.response();
        return response.ok ? limitedBytes(response.body, 256 * 1024) : null;
      }), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); })]);
      const clean = result && inspectJpeg(result, true);
      if (!clean || Math.max(clean.width, clean.height) > 1024 || runtime.now() >= deadline) return null;
      succeeded = true;
      return clean.bytes;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch {
    return null;
  } finally {
    await recordUsage(env, group, 'image_transform', key, succeeded ? 'succeeded' : 'failed');
  }
}
