/* weindie-agents — the only Worker.
 *
 * Public routes are read-only GETs. Administration is a separate, authenticated,
 * POST-only surface that nothing public links to. The scheduled handler is the
 * only thing that can start work without a person asking, and it does nothing at
 * all while AGENTS_ENABLED is "false".
 */

import type { Env } from './env';
import { agentsEnabled } from './env';
import { SCHEDULE } from './config';
import { handleAdmin } from './ops/admin';
import { triggerRadar, runWriterReading } from './ops/operations';
import { notFound } from './site/layout';
import { thoughtsPage, articlePage, writersPage, writerPage, statusPage } from './site/pages';
import { isSafeId } from './util';

export { WriterAgent } from './writers/WriterAgent';
export { RadarWorkflow } from './workflows/radar';
export { ReadingWorkflow } from './workflows/reading';
export { ArticleWorkflow } from './workflows/article';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path.startsWith('/admin')) return handleAdmin(req, env, path);

    /* Everything below is public, and public means read-only. */
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    /* The stylesheet and webfonts, lifted from the main site at deploy time so
       these pages make no third-party request either. */
    if (path === '/site.css' || path.startsWith('/fonts/')) {
      return env.ASSETS.fetch(req);
    }

    try {
      if (path === '/' ) {
        return Response.redirect(new URL('/thoughts', url).toString(), 302);
      }
      if (path === '/thoughts') return thoughtsPage(env, req);
      if (path.startsWith('/thoughts/')) {
        const slug = path.slice('/thoughts/'.length);
        return isSafeId(slug) ? articlePage(env, req, slug) : notFound(url.origin);
      }
      if (path === '/writers') return writersPage(env, req);
      if (path.startsWith('/writers/')) {
        const id = path.slice('/writers/'.length);
        return isSafeId(id) ? writerPage(env, req, id) : notFound(url.origin);
      }
      if (path === '/status') return statusPage(env, req);

      /* A liveness check that touches every binding, so "is it actually wired
         up?" has an answer that does not require running an agent. */
      if (path === '/health') {
        const db = await env.DB.prepare(`SELECT COUNT(*) c FROM sources`).first<any>();
        return Response.json({
          ok: true,
          environment: env.ENVIRONMENT,
          agentsEnabled: agentsEnabled(env),
          bindings: {
            d1: typeof db?.c === 'number',
            writerDurableObject: typeof env.WRITER?.idFromName === 'function',
            workersAi: typeof env.AI?.run === 'function',
            workflows: { radar: !!env.RADAR, reading: !!env.READING, article: !!env.ARTICLE },
            adminConfigured: !!env.ADMIN_TOKEN,
          },
          sources: db?.c ?? 0,
        }, { headers: { 'cache-control': 'no-store' } });
      }

      return notFound(url.origin);
    } catch (e: any) {
      console.error('request failed', path, String(e?.message ?? e));
      return new Response('Something went wrong.', { status: 500 });
    }
  },

  /* The kill switch lives here. With AGENTS_ENABLED false, every scheduled
     wake-up returns immediately: Radar does not run, no writer reads, and no
     model is called. The published pages keep serving, because nothing about
     reading the site depends on the agents being awake. */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!agentsEnabled(env)) {
      console.log(`schedule ${event.cron}: skipped, AGENTS_ENABLED=false`);
      return;
    }
    const job = SCHEDULE[event.cron];
    if (!job) {
      console.log(`schedule ${event.cron}: no job configured`);
      return;
    }

    if (job.job === 'radar') {
      ctx.waitUntil(triggerRadar(env, `cron ${event.cron}`).then(
        r => console.log(`radar started ${r.workflowId}`),
        e => console.error('radar failed to start', String(e))));
      return;
    }

    /* Writers are woken in pairs by separate crons rather than all six at once.
       They are reading, not racing. */
    ctx.waitUntil(Promise.all(job.writers.map(w =>
      runWriterReading(env, w, { trigger: `cron ${event.cron}` }).then(
        r => console.log(`reading started ${w} ${r.workflowId}`),
        e => console.error(`reading failed to start for ${w}`, String(e))),
    )));
  },
} satisfies ExportedHandler<Env>;
