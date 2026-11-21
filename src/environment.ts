export interface Env {
  DB: D1Database;
  IMAGES?: ImagesBinding;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_BOT_USER_ID: string;
  LINE_ADMIN_USER_ID: string;
  EVENT_KEY_SECRET: string;
  OPENAI_API_KEY?: string;
}

export interface Runtime {
  now: () => number;
  fetcher: typeof fetch;
}

export const runtime: Runtime = { now: () => Date.now(), fetcher: (...args) => fetch(...args) };

export async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function identifier(key: CryptoKey, kind: string, group: string, value: string) {
  const bytes = new TextEncoder().encode(JSON.stringify([kind, group, value]));
  const signature = await crypto.subtle.sign('HMAC', key, bytes);
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function digest(value: string) {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function limitedBytes(body: ReadableStream<Uint8Array> | null, limit: number) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
