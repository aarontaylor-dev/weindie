/* Small shared things. */

export const nowIso = () => new Date().toISOString();
export const today = (d = new Date()) => d.toISOString().slice(0, 10);
export const month = (d = new Date()) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export const uid = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

/* Article slugs and any other identifier that reaches a URL or a SQL parameter.
   Every id from outside is checked against this before it is used. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
export const isSafeId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);

export function slugify(title: string, suffix?: string) {
  const base = title.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
  return suffix ? `${base}-${suffix}` : base;
}

export async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Constant-time-ish comparison for the admin token. */
export function tokenMatches(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
