/* The admin surface.
 *
 * Every route here is POST, every route requires the ADMIN_TOKEN secret, and
 * nothing here is linked from a public page. If ADMIN_TOKEN is unset the whole
 * surface returns 503 rather than defaulting open — an unconfigured deployment
 * has no administration rather than unauthenticated administration.
 *
 * Cloudflare Access would be the better door and is the documented upgrade
 * path. It is not enabled on this account, and enabling it is a Zero Trust
 * onboarding decision for a human to make, not a side effect of shipping this.
 */

import type { Env } from '../env';
import { tokenMatches } from '../util';
import { isWriterId } from '../config';
import * as ops from './operations';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/* Per-isolate token bucket. This is a speed bump, not a distributed rate
   limiter — Cloudflare may run several isolates. It is enough to stop a loop
   or a stuck script, and the controls that actually bound cost are the budget
   check in generate() and the AI Gateway rate limit. Said plainly here so
   nobody mistakes it for more than it is. */
const bucket = { tokens: 30, refilledAt: Date.now() };
function allow(): boolean {
  const now = Date.now();
  const refill = Math.floor((now - bucket.refilledAt) / 2000);
  if (refill > 0) {
    bucket.tokens = Math.min(30, bucket.tokens + refill);
    bucket.refilledAt = now;
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens--;
  return true;
}

export async function handleAdmin(req: Request, env: Env, path: string): Promise<Response> {
  if (!env.ADMIN_TOKEN) {
    return json({ error: 'admin disabled: ADMIN_TOKEN is not set' }, 503);
  }
  if (req.method !== 'POST') {
    return json({ error: 'admin operations are POST only' }, 405);
  }

  const auth = req.headers.get('authorization') ?? '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!supplied || !tokenMatches(supplied, env.ADMIN_TOKEN)) {
    return json({ error: 'unauthorised' }, 401);
  }
  if (!allow()) return json({ error: 'slow down' }, 429);

  let body: any = {};
  try { body = await req.json(); } catch { /* an empty body is fine for most ops */ }

  const writer = body.writer;
  const needWriter = () => {
    if (!isWriterId(writer)) throw new Error('writer must be one of mara, kit, rowan, vale, soren, iona');
    return writer;
  };

  try {
    switch (path) {
      case '/admin/seed':
        return json({ writers: await ops.seedWriters(env), sources: await ops.seedSources(env) });

      case '/admin/radar':
        return json(await ops.triggerRadar(env, 'admin'));

      case '/admin/reading':
        return json(await ops.runWriterReading(env, needWriter(), {
          trigger: 'admin',
          seedTopic: typeof body.seedTopic === 'string' ? body.seedTopic.slice(0, 2000) : undefined,
          autoArticle: body.autoArticle === true,
        }));

      case '/admin/seed-topic':
        if (typeof body.topic !== 'string' || body.topic.length < 10) {
          return json({ error: 'topic required' }, 400);
        }
        return json(await ops.runSeedTopic(env, body.topic.slice(0, 2000)));

      case '/admin/notebook':
        return json(await ops.inspectNotebook(env, needWriter()));

      case '/admin/thought':
        return json(await ops.developThought(env, needWriter(), body.thoughtId, body.status));

      case '/admin/article/start':
        return json(await ops.startArticle(env, needWriter(), body.thoughtId));

      case '/admin/article/approve':
        return json(await ops.approveArticle(env, body.articleId, body.note, body.edited === true));

      case '/admin/article/reject':
        return json(await ops.rejectArticle(env, body.articleId, body.note));

      case '/admin/article/revise':
        if (typeof body.note !== 'string' || !body.note) return json({ error: 'note required' }, 400);
        return json(await ops.returnForRevision(env, body.articleId, body.note, body.factual === true));

      case '/admin/article/edit':
        if (typeof body.body !== 'string' || body.body.length < 20) {
          return json({ error: 'body required' }, 400);
        }
        return json(await ops.recordHumanEdit(env, body.articleId, body.body, body.note));

      case '/admin/status':
        return json(await ops.systemStatus(env));

      default:
        return json({ error: 'unknown operation' }, 404);
    }
  } catch (e: any) {
    return json({ error: String(e?.message ?? e).slice(0, 300) }, 400);
  }
}
