/* Radar. Finds material. Does not decide anything.
 *
 * The temptation with a system like this is to let the thing that gathers also
 * do the judging — score for "story potential", surface what would make a good
 * post. That would quietly turn six writers into one editor with six styles.
 * Radar's output is deliberately flat: what it is, what it claims, what it is
 * about, and a relevance score against a fixed topic list. Nothing about
 * whether anyone should care.
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../env';
import { RADAR } from '../config';
import { fetchFeed } from '../radar/feeds';
import { asSourceBlock } from '../radar/sanitise';
import { generate, parseJson } from '../ai/generate';
import { RADAR_PROMPT } from '../writers/identities';
import { nowIso, uid, sha256 } from '../util';

export interface RadarParams { trigger?: string }

const TOPICS = [
  'AI agents', 'autonomous software', 'human/AI collaboration', 'vibe coding',
  'personal software', 'independent technology', 'developer tools',
  'small-team leverage', 'AI failures', 'open source', 'new interaction models',
  'AI research', 'platform changes',
];

/* See the note on RETRY in article.ts — same reasoning. Radar gets a longer
   timeout because it fetches seventeen feeds in one step. */
const RETRY = {
  retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export class RadarWorkflow extends WorkflowEntrypoint<Env, RadarParams> {
  async run(event: WorkflowEvent<RadarParams>, step: WorkflowStep) {
    const env = this.env;
    const workflowId = event.instanceId;

    const sources = await step.do('load sources', RETRY, async () => {
      const { results } = await env.DB.prepare(
        `SELECT id, name, feed_url, publisher, topics, first_party FROM sources
          WHERE enabled = 1 AND feed_url IS NOT NULL`).all<any>();
      return results ?? [];
    });

    if (!sources.length) return { sources: 0, fetched: 0, stored: 0, note: 'no sources configured' };

    /* One step for all the fetching. Feeds are I/O, and a step per source would
       make a routine sweep seventeen durable checkpoints deep for no benefit. */
    const fetched = await step.do('fetch feeds', RETRY, async () => {
      const out: any[] = [];
      const statuses: Record<string, string> = {};
      await Promise.all(sources.map(async (s: any) => {
        const { items, status } = await fetchFeed(s.feed_url);
        statuses[s.id] = status;
        for (const it of items) {
          out.push({ ...it, sourceId: s.id, sourceName: s.name, publisher: s.publisher, kind: 'feed' });
        }
      }));
      return { items: out, statuses };
    });

    await step.do('record fetch status', RETRY, async () => {
      const at = nowIso();
      const stmt = env.DB.prepare(`UPDATE sources SET last_fetch_at = ?, last_status = ? WHERE id = ?`);
      await env.DB.batch(Object.entries(fetched.statuses).map(([id, st]) => stmt.bind(at, st, id)));
      return Object.keys(fetched.statuses).length;
    });

    /* Deduplicate by URL before spending a single token on anything. */
    const fresh = await step.do('deduplicate', RETRY, async () => {
      const urls = fetched.items.map((i: any) => i.url);
      if (!urls.length) return [];
      const seen = new Set<string>();
      const chunk = 80;
      for (let i = 0; i < urls.length; i += chunk) {
        const part = urls.slice(i, i + chunk);
        const { results } = await env.DB.prepare(
          `SELECT url FROM source_items WHERE url IN (${part.map(() => '?').join(',')})`)
          .bind(...part).all<{ url: string }>();
        for (const r of results ?? []) seen.add(r.url);
      }
      /* Round-robin across sources before the per-sweep cap bites. Taking the
         first N in fetch order would let four fast feeds fill the whole sweep
         and the other thirteen would never be read — which would quietly narrow
         what every writer sees. Breadth first, then depth. */
      const bySource = new Map<string, any[]>();
      const local = new Set<string>();
      for (const it of fetched.items) {
        if (seen.has(it.url) || local.has(it.url)) continue;
        local.add(it.url);
        const list = bySource.get(it.sourceId) ?? [];
        list.push(it);
        bySource.set(it.sourceId, list);
      }
      const out: any[] = [];
      for (let round = 0; out.length < RADAR.maxNewItemsPerSweep; round++) {
        let placed = false;
        for (const list of bySource.values()) {
          if (round >= list.length) continue;
          out.push(list[round]);
          placed = true;
          if (out.length >= RADAR.maxNewItemsPerSweep) break;
        }
        if (!placed) break;
      }
      return out;
    });

    if (!fresh.length) {
      return { sources: sources.length, fetched: fetched.items.length, stored: 0, note: 'nothing new' };
    }

    /* Summarise and tag in batches. A cheap model is the right tool: this is
       classification, not judgement. */
    const described = await step.do('describe and score', RETRY, async () => {
      const out: any[] = [];
      const batchSize = 4;
      for (let i = 0; i < fresh.length; i += batchSize) {
        const batch = fresh.slice(i, i + batchSize);
        const block = asSourceBlock(batch.map((it: any, n: number) => ({
          n: n + 1, title: it.title, url: it.url, text: it.excerpt || '(no summary in feed)',
        })));

        let parsed: any = null;
        try {
          const res = await generate(env, {
            agentId: 'radar', task: 'summarise', modelClass: 'cheap',
            system: RADAR_PROMPT, workflowId, json: true, maxTokens: 700, temperature: 0.2,
            messages: [{
              role: 'user',
              content:
`Describe each source below.

${block}

Topics you may use: ${TOPICS.join(', ')}.

Return JSON:
{"items":[{"id":1,"summary":"one neutral sentence saying what this is and what it claims","topics":["..."],"relevance":0.0}]}

relevance is 0 to 1: how likely this is to matter to writers thinking about AI agents,
autonomous software, human/AI collaboration, independent technology and small-team
leverage. A routine product update scores low. Do not describe anything as important
or exciting.`,
            }],
          });
          parsed = parseJson<{ items: any[] }>(res.text);
        } catch { /* a failed batch is stored undescribed rather than dropped */ }

        batch.forEach((it: any, n: number) => {
          const d = parsed?.items?.find((x: any) => Number(x.id) === n + 1);
          const topics = Array.isArray(d?.topics)
            ? d.topics.filter((t: any) => TOPICS.includes(t)).slice(0, 4) : [];
          out.push({
            ...it,
            summary: typeof d?.summary === 'string' ? d.summary.slice(0, 400) : it.title,
            topics,
            relevance: Math.max(0, Math.min(1, Number(d?.relevance) || 0.3)),
          });
        });
      }
      return out;
    });

    const stored = await step.do('store', RETRY, async () => {
      const at = nowIso();
      const rows = await Promise.all(described.map(async (it: any) => ({
        it, hash: await sha256(it.url + '|' + it.title),
      })));
      const stmt = env.DB.prepare(
        `INSERT OR IGNORE INTO source_items
           (id, source_id, url, title, author, published_at, retrieved_at, source_type,
            summary, topics, relevance, excerpt, content_hash, injection_flag, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      await env.DB.batch(rows.map(({ it, hash }) => stmt.bind(
        uid('itm'), it.sourceId, it.url, it.title, it.author ?? null, it.publishedAt ?? null,
        at, it.kind, it.summary, JSON.stringify(it.topics), it.relevance,
        it.excerpt ?? null, hash, it.flagged ? 1 : 0, at)));
      return rows.length;
    });

    return {
      sources: sources.length,
      fetched: fetched.items.length,
      stored,
      flagged: described.filter((d: any) => d.flagged).length,
    };
  }
}
