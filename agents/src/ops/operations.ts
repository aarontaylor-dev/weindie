/* The internal operations. Explicit verbs, not one generic agent endpoint.
 *
 * Every one of these is either read-only or a deliberate act by a human with
 * the admin token. None of them is reachable from a public route, and none of
 * them can be invoked by anything a writer read.
 */

import type { Env } from '../env';
import { agentsEnabled } from '../env';
import { WRITER_IDS, type WriterId, isWriterId } from '../config';
import { allIdentities, identity } from '../writers/identities';
import { spendThisMonth } from '../ai/generate';
import { nowIso, uid, isSafeId } from '../util';
import sourceList from '../../sources/sources.json';

/* ------------------------------------------------------------------- seeding */

export async function seedWriters(env: Env) {
  const out: Record<string, unknown> = {};
  for (const w of allIdentities()) {
    const stub = env.WRITER.get(env.WRITER.idFromName(w.id));
    out[w.id] = await stub.seed(w.id, w.version, w.openQuestions, w.interests);
    await stub.setIdentityVersion(w.version);
  }
  return out;
}

export async function seedSources(env: Env) {
  const at = nowIso();
  const stmt = env.DB.prepare(
    `INSERT INTO sources (id, name, url, feed_url, kind, publisher, topics, first_party, enabled, added_at)
     VALUES (?,?,?,?,?,?,?,?,1,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, url=excluded.url, feed_url=excluded.feed_url,
       kind=excluded.kind, publisher=excluded.publisher, topics=excluded.topics,
       first_party=excluded.first_party`);
  await env.DB.batch((sourceList as any).sources.map((s: any) => stmt.bind(
    s.id, s.name, s.url, s.feed_url, s.kind, s.publisher,
    JSON.stringify(s.topics ?? []), s.first_party ? 1 : 0, at)));
  return { sources: (sourceList as any).sources.length };
}

/* ------------------------------------------------------------------ triggers */

export async function triggerRadar(env: Env, trigger = 'manual') {
  const inst = await env.RADAR.create({ params: { trigger } });
  return { workflowId: inst.id };
}

export async function runWriterReading(
  env: Env, writer: WriterId,
  opts: { trigger?: string; seedTopic?: string; autoArticle?: boolean } = {},
) {
  if (!isWriterId(writer)) throw new Error('unknown writer');
  const inst = await env.READING.create({
    params: {
      writer,
      trigger: opts.trigger ?? 'manual',
      seedTopic: opts.seedTopic,
      autoArticle: opts.autoArticle ?? agentsEnabled(env),
    },
  });
  return { writer, workflowId: inst.id };
}

/* The quality test: one topic, six writers, six independent reactions. The
   expected result is not six articles. It is six different shapes of nothing,
   noticing and interest. */
export async function runSeedTopic(env: Env, topic: string) {
  const started = [];
  for (const w of WRITER_IDS) {
    started.push(await runWriterReading(env, w, { trigger: 'seed_topic', seedTopic: topic, autoArticle: false }));
  }
  return { topic: topic.slice(0, 300), started };
}

export async function inspectNotebook(env: Env, writer: WriterId) {
  if (!isWriterId(writer)) throw new Error('unknown writer');
  return env.WRITER.get(env.WRITER.idFromName(writer)).notebook();
}

export async function developThought(env: Env, writer: WriterId, thoughtId: string, status?: string) {
  if (!isWriterId(writer) || !isSafeId(thoughtId)) throw new Error('bad arguments');
  const stub = env.WRITER.get(env.WRITER.idFromName(writer));
  if (status) {
    const ok = await stub.setThoughtStatus(thoughtId, status as any);
    if (!ok) throw new Error('unknown thought or status');
  }
  return stub.thought(thoughtId);
}

export async function startArticle(env: Env, writer: WriterId, thoughtId: string) {
  if (!isWriterId(writer) || !isSafeId(thoughtId)) throw new Error('bad arguments');
  const inst = await env.ARTICLE.create({ params: { writer, thoughtId } });
  return { writer, thoughtId, workflowId: inst.id };
}

/* ---------------------------------------------------------- human decisions */

async function intervene(env: Env, articleId: string, kind: string, note?: string) {
  await env.DB.prepare(
    `INSERT INTO human_interventions (id, article_id, kind, note, created_at) VALUES (?,?,?,?,?)`,
  ).bind(uid('hi'), articleId, kind, note ?? null, nowIso()).run();
}

async function requireArticle(env: Env, articleId: string) {
  if (!isSafeId(articleId)) throw new Error('bad article id');
  const a = await env.DB.prepare(`SELECT * FROM articles WHERE id = ?`).bind(articleId).first<any>();
  if (!a) throw new Error('article not found');
  return a;
}

/* `actor` decides what the article's page is allowed to claim. Only a person
   approving sets human_approved, because that field is the site's whole claim
   about how this works — a build script setting it to demonstrate the UI would
   be exactly the quiet dishonesty the rest of this system is built to avoid.
   Anything published by another actor renders with a notice saying so. */
export async function approveArticle(
  env: Env, articleId: string, note?: string, edited = false, actor = 'human',
) {
  const a = await requireArticle(env, articleId);
  const at = nowIso();
  const byHuman = actor === 'human';
  await env.DB.prepare(
    `UPDATE articles SET status='published', published_at=?, human_approved=?, human_edited=?, updated_at=?
      WHERE id=?`,
  ).bind(at, byHuman ? 1 : 0, edited ? 1 : a.human_edited, at, articleId).run();
  await env.DB.prepare(
    `INSERT INTO publication_events (id, article_id, event, actor, note, created_at)
     VALUES (?,?, 'published', ?, ?, ?)`)
    .bind(uid('pe'), articleId, actor, note ?? null, at).run();
  if (byHuman) {
    await intervene(env, articleId, edited ? 'human_edited' : 'approved_without_changes', note);
  }
  await env.WRITER.get(env.WRITER.idFromName(a.writer)).recordPublished(at);
  return { articleId, status: 'published', humanApproved: byHuman, slug: a.slug };
}

export async function rejectArticle(env: Env, articleId: string, note?: string) {
  await requireArticle(env, articleId);
  const at = nowIso();
  await env.DB.prepare(`UPDATE articles SET status='rejected', updated_at=? WHERE id=?`)
    .bind(at, articleId).run();
  await env.DB.prepare(
    `INSERT INTO publication_events (id, article_id, event, actor, note, created_at)
     VALUES (?,?, 'rejected', 'human', ?, ?)`).bind(uid('pe'), articleId, note ?? null, at).run();
  await intervene(env, articleId, 'rejected', note);
  return { articleId, status: 'rejected' };
}

export async function returnForRevision(env: Env, articleId: string, note: string, factual = false) {
  await requireArticle(env, articleId);
  await env.DB.prepare(`UPDATE articles SET status='revising', updated_at=? WHERE id=?`)
    .bind(nowIso(), articleId).run();
  await intervene(env, articleId, factual ? 'factual_correction_requested' : 'asked_to_reconsider', note);
  return { articleId, status: 'revising' };
}

/* If a human edits the prose, the article says so on its own page. Passing off
   human writing as autonomous writing would make every other claim on the site
   worthless. */
export async function recordHumanEdit(env: Env, articleId: string, body: string, note?: string) {
  const a = await requireArticle(env, articleId);
  const at = nowIso();
  await env.DB.prepare(
    `INSERT INTO article_revisions (id, article_id, stage, body, notes, author, created_at)
     VALUES (?,?,'human_edit',?,?, 'human', ?)`)
    .bind(uid('rev'), articleId, body, note ?? null, at).run();
  await env.DB.prepare(`UPDATE articles SET body=?, human_edited=1, updated_at=? WHERE id=?`)
    .bind(body, at, articleId).run();
  await intervene(env, articleId, 'human_edited', note);
  return { articleId, humanEdited: true, slug: a.slug };
}

/* ------------------------------------------------------------------- status */

export async function systemStatus(env: Env) {
  const spent = await spendThisMonth(env);
  const counts = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) c FROM source_items`),
    env.DB.prepare(`SELECT COUNT(*) c FROM articles WHERE status='awaiting_human_approval'`),
    env.DB.prepare(`SELECT COUNT(*) c FROM articles WHERE status='published'`),
    env.DB.prepare(`SELECT COUNT(*) c FROM sources WHERE enabled=1`),
  ]);
  return {
    environment: env.ENVIRONMENT,
    agentsEnabled: agentsEnabled(env),
    externalProviders: env.EXTERNAL_PROVIDERS_ENABLED === 'true',
    gateway: env.AI_GATEWAY_ID,
    budget: {
      monthlyCeilingUsd: Number(env.MONTHLY_BUDGET_USD),
      perAgentCeilingUsd: Number(env.PER_AGENT_BUDGET_USD),
      spentThisMonthUsd: Number(spent.toFixed(4)),
    },
    sourceItems: (counts[0].results as any[])[0].c,
    awaitingApproval: (counts[1].results as any[])[0].c,
    published: (counts[2].results as any[])[0].c,
    sources: (counts[3].results as any[])[0].c,
    writers: WRITER_IDS.map(id => ({ id, version: identity(id).versioned })),
  };
}
