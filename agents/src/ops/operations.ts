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
import { generate, parseJson, parseFields, spendThisMonth } from '../ai/generate';
import { systemPrompt } from '../writers/identities';
import { nowIso, uid, isSafeId } from '../util';
import { voiceCheck } from '../editorial/voice';
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

/* The quality gate from the brief: strip the names off six outputs and see
 * whether you can still tell who wrote each one.
 *
 * It deliberately writes nothing but usage rows. The alternative — giving each
 * writer a thought so it could run the real article pipeline — would mean
 * inventing memories five of them never formed, which is the one thing the
 * seeding rules forbid. So this is a voice test, not a memory event: real
 * identity, real model, no notebook, no article, no trace in anyone's history.
 *
 * No sources are supplied, so the writers are told plainly to make no factual
 * claims. A test that invited invented citations would be testing the wrong
 * thing and poisoning the thing it tested.
 */
export async function draftTest(
  env: Env, topic: string, words = 400,
  /* Optional per-writer model override: {"iona": "@cf/..."} tries a candidate
     against the real identity without editing the file. Choosing a writer's
     model by argument rather than by measurement is how two of them ended up
     on models that cannot produce an essay at all. */
  models: Record<string, string> = {},
  only?: string[],
) {
  const one = async (me: any, attempt = 1): Promise<any> => {
    try {
      const res = await generate(env, {
        agentId: me.id, task: 'draft', modelClass: 'writer',
        modelOverride: models[me.id],
        /* Room for a reasoning model to think and then still write. Gemma and
           Qwen spend 1,300-1,500 tokens before their first character, so 2,200
           produced essays that stopped mid-sentence and read as failures. */
        maxTokens: 4000, temperature: 0.8,
        system: systemPrompt(me, 'draft'),
        messages: [{ role: 'user', content:
`Someone has put this to you:

  ${topic}

Write roughly ${words} words in response, in your own voice, following your voice
rules exactly. Not a summary of the statement — the thing only you would say about it.

You have no sources for this one. So make no factual claims, cite nothing, invent no
statistic, study, company or quotation. Argue from reasoning and from what you already
think. Where you would normally want evidence, say that you would want evidence.

Format your reply exactly like this. No JSON, no code fence:

TITLE: your title on one line
---
your essay, plain paragraphs separated by blank lines` }],
      });
      const d = parseFields(res.text, ['TITLE']);
      if (!d?.body) throw new Error('no body in reply');
      return {
        writer: me.id, name: me.name, role: me.role, model: res.model,
        version: me.versioned,
        title: (d.title || '(untitled)').slice(0, 160),
        body: d.body.slice(0, 12000),
        words: d.body.trim().split(/\s+/).filter(Boolean).length,
        voice: await voiceCheck(env, me, d.body),
        ok: true,
      };
    } catch (e: any) {
      /* One retry. The first-run failures were transport timeouts under
         contention and broken JSON envelopes, not writers with nothing to say. */
      if (attempt === 1) return one(me, 2);
      return { writer: me.id, name: me.name, role: me.role, ok: false,
               error: String(e?.message ?? e).slice(0, 200) };
    }
  };

  /* In threes rather than all six at once: six heavy models called in parallel
     timed each other out. */
  const all = allIdentities().filter(m => !only?.length || only.includes(m.id));
  const results: any[] = [];
  for (let i = 0; i < all.length; i += 3) {
    results.push(...await Promise.all(all.slice(i, i + 3).map(m => one(m))));
  }
  return { topic, words, results };
}

/* Run the voice check over an article that already exists, changing nothing.
   Useful for asking the question retrospectively — including of pieces written
   before the check existed. */
export async function voiceCheckArticle(
  env: Env, articleId?: string, writer?: WriterId, body?: string,
) {
  /* Either check a stored article, or check arbitrary text against a writer's
     rules. The second form is how you tune an identity file — and how you
     confirm the check still fires, which a check that only ever returns "no
     findings" cannot demonstrate about itself. */
  if (body && isWriterId(writer)) {
    return {
      articleId: null, writer, title: null, status: 'ad-hoc',
      identityVersionNow: identity(writer).versioned,
      ...(await voiceCheck(env, identity(writer), body.slice(0, 20000))),
    };
  }
  if (!isSafeId(articleId)) throw new Error('pass articleId, or writer and body');
  const a = await env.DB.prepare(
    `SELECT id, writer, title, body, status FROM articles WHERE id = ?`).bind(articleId).first<any>();
  if (!a) throw new Error('article not found');
  if (!isWriterId(a.writer)) throw new Error('unknown writer on article');
  const v = await voiceCheck(env, identity(a.writer), a.body ?? '');
  return {
    articleId: a.id, writer: a.writer, title: a.title, status: a.status,
    identityVersionNow: identity(a.writer).versioned,
    ...v,
  };
}

/* --------------------------------------------------------------- the queue */

/* What is waiting for a person, and what each one needs from them.
 *
 * Previewing a draft needs its id, and until this existed the only way to get
 * one was a raw SQL query — which made the review flow the least usable part of
 * a system whose whole safety story is that a human reviews things.
 *
 * The editorial numbers are surfaced here rather than left inside the draft so
 * the queue can be triaged without opening every piece: a draft with unsupported
 * claims or a duplication flag is the one to read first. */
export async function listQueue(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, writer, writer_version, title, standfirst, status, confidence,
            belief_effect, sources_considered, sources_cited, human_edited,
            editorial_findings, created_at, updated_at
       FROM articles
      WHERE status IN ('awaiting_human_approval', 'revising', 'drafting')
      ORDER BY CASE status WHEN 'awaiting_human_approval' THEN 0
                           WHEN 'revising' THEN 1 ELSE 2 END,
               created_at DESC`).all<any>();

  const items = (results ?? []).map((a: any) => {
    let f: any = {};
    try { f = JSON.parse(a.editorial_findings ?? '{}'); } catch { /* older or partial row */ }
    return {
      id: a.id,
      writer: a.writer,
      writerVersion: a.writer_version,
      title: a.title,
      standfirst: a.standfirst || null,
      status: a.status,
      confidence: a.confidence,
      beliefEffect: a.belief_effect,
      sources: { considered: a.sources_considered, cited: a.sources_cited },
      humanEdited: !!a.human_edited,
      /* The three things worth knowing before deciding whether to read it. */
      needsAttention: {
        unsupportedClaims: (f.unsupported ?? []).length,
        uncertainClaims: (f.uncertain ?? []).length,
        /* Departures still present in the final text, not the ones the writer
           already fixed. A number here means the writer chose to leave it. */
        voiceDepartures: (f.voice?.afterRevision ?? []).length,
        duplicationFlagged: !!f.duplication?.flagged,
      },
      unsupported: f.unsupported ?? [],
      writerChangeNote: f.changeNote ?? null,
      voice: f.voice ? {
        found: (f.voice.beforeRevision ?? []).length,
        remaining: (f.voice.afterRevision ?? []).length,
        resolved: f.voice.resolved ?? 0,
        writerResponse: f.voice.writerResponse ?? null,
        stillDeparting: (f.voice.afterRevision ?? []).map((x: any) => x.rule),
      } : null,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    };
  });

  return {
    awaitingApproval: items.filter(i => i.status === 'awaiting_human_approval').length,
    returnedForRevision: items.filter(i => i.status === 'revising').length,
    stillDrafting: items.filter(i => i.status === 'drafting').length,
    items,
    /* Nothing waiting is the normal state, and it is not an empty result to be
       apologised for. */
    note: items.length ? undefined : 'Nothing is waiting for you. That is the usual state.',
  };
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
