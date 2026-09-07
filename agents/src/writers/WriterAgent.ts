/* One Durable Object per writer. This is the writer's mind between sessions.
 *
 * Why a Durable Object and not a table in D1: a writer's intellectual state is
 * single-writer by nature. Only Mara updates Mara. Putting it in its own object
 * with its own SQLite database means a reading session can read and rewrite the
 * whole notebook transactionally, without coordination, and without any chance
 * of one writer's revision landing in another's memory.
 *
 * Nothing in here is a chain of thought. It is a set of *positions*: statements
 * the writer would stand behind, questions it is carrying, and half-made ideas
 * with a status. The public pages render deliberately-written summaries of this
 * state — never a hidden reasoning trace, because none is stored.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { nowIso, uid } from '../util';

export type ThoughtStatus =
  | 'noticed' | 'developing' | 'researching'
  | 'ready_to_write' | 'abandoned' | 'merged_into_other_thought';

const THOUGHT_STATUSES: ThoughtStatus[] = [
  'noticed', 'developing', 'researching', 'ready_to_write', 'abandoned', 'merged_into_other_thought',
];

export interface Belief {
  id: string; statement: string; confidence: number;
  createdAt: string; updatedAt: string;
  supportingEvidence: Evidence[]; challengingEvidence: Evidence[];
  relatedPosts: string[];
}
export interface Evidence { note: string; url?: string; at: string }

export interface Thought {
  id: string; workingIdea: string; status: ThoughtStatus;
  createdAt: string; updatedAt: string;
  observations: Evidence[]; tensions: string[];
  relatedBeliefs: string[]; relatedWriters: string[];
}

export interface ChangedMind {
  id: string; previousPosition: string; newPosition: string; reason: string;
  sources: string[]; relatedPosts: string[]; changedAt: string;
}

export interface WriterMemory {
  identity: { id: string; version: string };
  currentBeliefs: Belief[];
  uncertainties: string[];
  activeQuestions: string[];
  curiosities: string[];
  developingThoughts: Thought[];
  abandonedThoughts: Thought[];
  changedMyMind: ChangedMind[];
  previousPredictions: { statement: string; horizon: string; madeAt: string; outcome: string | null }[];
  recurringThemes: { theme: string; count: number }[];
  relationshipsToOtherWriters: { writer: string; stance: string; note: string }[];
  lastReadAt: string | null;
  lastPublishedAt: string | null;
}

/* What a reading session is allowed to return. Anything outside this shape is
   discarded before it can touch storage — which is why an instruction hidden in
   a source cannot become a database write however persuasive it is. */
export interface ReadingOutcome {
  verdict: 'nothing_retained' | 'retained' | 'ready_to_write';
  summary: string;
  observations: { kind: 'challenged' | 'reinforced' | 'complicated' | 'connected'; note: string; sourceUrl?: string }[];
  newThought?: { workingIdea: string; tension?: string };
  advanceThought?: { id: string; status: ThoughtStatus; observation?: string; tension?: string };
  abandonThought?: { id: string; reason: string };
  beliefUpdate?: { statement: string; confidence: number; evidence?: string; side?: 'supporting' | 'challenging' };
  changedMind?: { previousPosition: string; newPosition: string; reason: string; sources?: string[] };
  newQuestion?: string;
  newUncertainty?: string;
  themes?: string[];
}

const clampStr = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

export class WriterAgent extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS beliefs (
        id TEXT PRIMARY KEY, statement TEXT NOT NULL, confidence REAL NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS belief_evidence (
        id TEXT PRIMARY KEY, belief_id TEXT NOT NULL, side TEXT NOT NULL,
        note TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS belief_posts (
        belief_id TEXT NOT NULL, article_id TEXT NOT NULL,
        PRIMARY KEY (belief_id, article_id));

      CREATE TABLE IF NOT EXISTS uncertainties (
        id TEXT PRIMARY KEY, statement TEXT NOT NULL, created_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS curiosities (
        id TEXT PRIMARY KEY, note TEXT NOT NULL, created_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS thoughts (
        id TEXT PRIMARY KEY, working_idea TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closing_note TEXT);

      CREATE TABLE IF NOT EXISTS thought_observations (
        id TEXT PRIMARY KEY, thought_id TEXT NOT NULL, note TEXT NOT NULL,
        url TEXT, created_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS thought_tensions (
        id TEXT PRIMARY KEY, thought_id TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS thought_beliefs (
        thought_id TEXT NOT NULL, belief_id TEXT NOT NULL, PRIMARY KEY (thought_id, belief_id));

      CREATE TABLE IF NOT EXISTS thought_writers (
        thought_id TEXT NOT NULL, writer TEXT NOT NULL, PRIMARY KEY (thought_id, writer));

      CREATE TABLE IF NOT EXISTS changed_mind (
        id TEXT PRIMARY KEY, previous_position TEXT NOT NULL, new_position TEXT NOT NULL,
        reason TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]',
        related_posts TEXT NOT NULL DEFAULT '[]', changed_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS predictions (
        id TEXT PRIMARY KEY, statement TEXT NOT NULL, horizon TEXT,
        made_at TEXT NOT NULL, outcome TEXT);

      CREATE TABLE IF NOT EXISTS themes (
        theme TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS relationships (
        writer TEXT PRIMARY KEY, stance TEXT NOT NULL, note TEXT, updated_at TEXT NOT NULL);
    `);
  }

  private meta(key: string): string | null {
    const r = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray() as any[];
    return r.length ? String(r[0].value) : null;
  }
  private setMeta(key: string, value: string) {
    this.sql.exec(
      `INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key, value,
    );
  }

  /* ------------------------------------------------------------------ seed */

  /* Called once when a writer is created. They are new: a handful of open
     questions from their identity file and nothing else. No fabricated history,
     no beliefs they never formed, and an empty changed-mind record — which is
     the honest state for someone who has not yet changed their mind. */
  async seed(writerId: string, version: string, openQuestions: string[], interests: string[]) {
    if (this.meta('seeded')) return { seeded: false, reason: 'already seeded' };
    const at = nowIso();
    this.setMeta('writer_id', writerId);
    this.setMeta('identity_version', version);
    for (const q of openQuestions.slice(0, 8)) {
      this.sql.exec(`INSERT INTO questions (id,question,status,created_at) VALUES (?,?,'open',?)`,
        uid('q'), clampStr(q, 400), at);
    }
    for (const i of interests.slice(0, 10)) {
      this.sql.exec(`INSERT INTO curiosities (id,note,created_at) VALUES (?,?,?)`,
        uid('cur'), clampStr(i, 200), at);
    }
    this.setMeta('seeded', at);
    return { seeded: true, questions: openQuestions.length };
  }

  async identityVersion() { return this.meta('identity_version'); }
  async setIdentityVersion(v: string) { this.setMeta('identity_version', v); }

  /* ------------------------------------------------------------- reading it */

  private beliefs(): Belief[] {
    const rows = this.sql.exec(
      `SELECT * FROM beliefs ORDER BY confidence DESC, updated_at DESC`).toArray() as any[];
    return rows.map(b => {
      const ev = this.sql.exec(
        `SELECT side,note,url,created_at FROM belief_evidence WHERE belief_id = ? ORDER BY created_at`,
        b.id).toArray() as any[];
      const posts = this.sql.exec(
        `SELECT article_id FROM belief_posts WHERE belief_id = ?`, b.id).toArray() as any[];
      return {
        id: b.id, statement: b.statement, confidence: b.confidence,
        createdAt: b.created_at, updatedAt: b.updated_at,
        supportingEvidence: ev.filter(e => e.side === 'supporting')
          .map(e => ({ note: e.note, url: e.url ?? undefined, at: e.created_at })),
        challengingEvidence: ev.filter(e => e.side === 'challenging')
          .map(e => ({ note: e.note, url: e.url ?? undefined, at: e.created_at })),
        relatedPosts: posts.map(p => p.article_id),
      };
    });
  }

  private thoughtsWhere(clause: string, ...args: any[]): Thought[] {
    const rows = this.sql.exec(`SELECT * FROM thoughts WHERE ${clause}`, ...args).toArray() as any[];
    return rows.map(t => ({
      id: t.id, workingIdea: t.working_idea, status: t.status as ThoughtStatus,
      createdAt: t.created_at, updatedAt: t.updated_at,
      observations: (this.sql.exec(
        `SELECT note,url,created_at FROM thought_observations WHERE thought_id = ? ORDER BY created_at`,
        t.id).toArray() as any[]).map(o => ({ note: o.note, url: o.url ?? undefined, at: o.created_at })),
      tensions: (this.sql.exec(
        `SELECT note FROM thought_tensions WHERE thought_id = ? ORDER BY created_at`,
        t.id).toArray() as any[]).map(x => x.note),
      relatedBeliefs: (this.sql.exec(
        `SELECT belief_id FROM thought_beliefs WHERE thought_id = ?`, t.id).toArray() as any[])
        .map(x => x.belief_id),
      relatedWriters: (this.sql.exec(
        `SELECT writer FROM thought_writers WHERE thought_id = ?`, t.id).toArray() as any[])
        .map(x => x.writer),
    }));
  }

  private col(table: string, column: string, order = 'created_at DESC', limit = 50): string[] {
    return (this.sql.exec(`SELECT ${column} AS v FROM ${table} ORDER BY ${order} LIMIT ?`, limit)
      .toArray() as any[]).map(r => String(r.v));
  }

  async memory(): Promise<WriterMemory> {
    const all = this.thoughtsWhere('1=1 ORDER BY updated_at DESC');
    return {
      identity: { id: this.meta('writer_id') ?? '', version: this.meta('identity_version') ?? '0.1' },
      currentBeliefs: this.beliefs(),
      uncertainties: this.col('uncertainties', 'statement'),
      activeQuestions: this.col('questions', 'question'),
      curiosities: this.col('curiosities', 'note'),
      developingThoughts: all.filter(t => t.status !== 'abandoned' && t.status !== 'merged_into_other_thought'),
      abandonedThoughts: all.filter(t => t.status === 'abandoned'),
      changedMyMind: (this.sql.exec(`SELECT * FROM changed_mind ORDER BY changed_at DESC`).toArray() as any[])
        .map(c => ({
          id: c.id, previousPosition: c.previous_position, newPosition: c.new_position,
          reason: c.reason, sources: JSON.parse(c.sources), relatedPosts: JSON.parse(c.related_posts),
          changedAt: c.changed_at,
        })),
      previousPredictions: (this.sql.exec(`SELECT * FROM predictions ORDER BY made_at DESC`).toArray() as any[])
        .map(p => ({ statement: p.statement, horizon: p.horizon, madeAt: p.made_at, outcome: p.outcome })),
      recurringThemes: (this.sql.exec(`SELECT theme,count FROM themes ORDER BY count DESC LIMIT 12`)
        .toArray() as any[]).map(t => ({ theme: t.theme, count: t.count })),
      relationshipsToOtherWriters: (this.sql.exec(`SELECT * FROM relationships`).toArray() as any[])
        .map(r => ({ writer: r.writer, stance: r.stance, note: r.note ?? '' })),
      lastReadAt: this.meta('last_read_at'),
      lastPublishedAt: this.meta('last_published_at'),
    };
  }

  async thought(id: string): Promise<Thought | null> {
    const t = this.thoughtsWhere('id = ?', id);
    return t[0] ?? null;
  }

  /* What goes into a reading packet: the writer's own live context, kept small
     on purpose. Replaying everything a writer has ever thought into every
     prompt is how a persistent writer becomes an expensive stateless one. */
  async packetContext(maxThoughts: number, maxBeliefs: number) {
    const thoughts = this.thoughtsWhere(
      `status IN ('noticed','developing','researching') ORDER BY updated_at DESC LIMIT ?`, maxThoughts);
    const beliefs = this.beliefs().slice(0, maxBeliefs);
    return {
      thoughts: thoughts.map(t => ({
        id: t.id, workingIdea: t.workingIdea, status: t.status,
        observations: t.observations.slice(-3).map(o => o.note), tensions: t.tensions.slice(-2),
      })),
      beliefs: beliefs.map(b => ({ id: b.id, statement: b.statement, confidence: b.confidence })),
      questions: this.col('questions', 'question', 'created_at DESC', 6),
      uncertainties: this.col('uncertainties', 'statement', 'created_at DESC', 4),
    };
  }

  /* ------------------------------------------------------------- writing it */

  /* The single write path for a reading session. Every field is clamped and
     every enum is checked here rather than trusted from the model, so a
     malformed or hostile reply degrades to "nothing retained" instead of
     corrupting the notebook. */
  async applyReading(raw: ReadingOutcome): Promise<{
    verdict: string; retained: number; abandoned: boolean; changedMind: boolean; readyThoughtId?: string;
  }> {
    const at = nowIso();
    this.setMeta('last_read_at', at);

    const verdict = ['nothing_retained', 'retained', 'ready_to_write'].includes(raw?.verdict)
      ? raw.verdict : 'nothing_retained';

    if (verdict === 'nothing_retained') {
      return { verdict, retained: 0, abandoned: false, changedMind: false };
    }

    let retained = 0;
    let readyThoughtId: string | undefined;

    /* new thought */
    if (raw.newThought?.workingIdea) {
      const id = uid('th');
      this.sql.exec(`INSERT INTO thoughts (id,working_idea,status,created_at,updated_at) VALUES (?,?,?,?,?)`,
        id, clampStr(raw.newThought.workingIdea, 600), verdict === 'ready_to_write' ? 'developing' : 'noticed', at, at);
      if (raw.newThought.tension) {
        this.sql.exec(`INSERT INTO thought_tensions (id,thought_id,note,created_at) VALUES (?,?,?,?)`,
          uid('tn'), id, clampStr(raw.newThought.tension, 400), at);
      }
      for (const o of (raw.observations ?? []).slice(0, 4)) {
        this.sql.exec(`INSERT INTO thought_observations (id,thought_id,note,url,created_at) VALUES (?,?,?,?,?)`,
          uid('ob'), id, clampStr(o.note, 500), typeof o.sourceUrl === 'string' ? o.sourceUrl.slice(0, 500) : null, at);
      }
      retained++;
      if (verdict === 'ready_to_write') readyThoughtId = id;
    }

    /* advance an existing one */
    const adv = raw.advanceThought;
    if (adv?.id && this.exists('thoughts', adv.id)) {
      const status = THOUGHT_STATUSES.includes(adv.status) ? adv.status : 'developing';
      this.sql.exec(`UPDATE thoughts SET status = ?, updated_at = ? WHERE id = ?`, status, at, adv.id);
      if (adv.observation) {
        this.sql.exec(`INSERT INTO thought_observations (id,thought_id,note,url,created_at) VALUES (?,?,?,?,?)`,
          uid('ob'), adv.id, clampStr(adv.observation, 500), null, at);
      }
      if (adv.tension) {
        this.sql.exec(`INSERT INTO thought_tensions (id,thought_id,note,created_at) VALUES (?,?,?,?)`,
          uid('tn'), adv.id, clampStr(adv.tension, 400), at);
      }
      retained++;
      if (status === 'ready_to_write') readyThoughtId = adv.id;
    }

    /* Abandonment is a result, not a failure. It gets its own record and the
       reason is kept, because the reason is the interesting part. */
    let abandoned = false;
    const ab = raw.abandonThought;
    if (ab?.id && this.exists('thoughts', ab.id)) {
      this.sql.exec(`UPDATE thoughts SET status='abandoned', closing_note=?, updated_at=? WHERE id=?`,
        clampStr(ab.reason, 500), at, ab.id);
      abandoned = true;
    }

    /* belief */
    if (raw.beliefUpdate?.statement) {
      const statement = clampStr(raw.beliefUpdate.statement, 500);
      const conf = Math.max(0, Math.min(1, Number(raw.beliefUpdate.confidence ?? 0.5) || 0.5));
      const existing = this.sql.exec(`SELECT id FROM beliefs WHERE statement = ?`, statement).toArray() as any[];
      const id = existing.length ? String(existing[0].id) : uid('bel');
      if (existing.length) {
        this.sql.exec(`UPDATE beliefs SET confidence=?, updated_at=? WHERE id=?`, conf, at, id);
      } else {
        this.sql.exec(`INSERT INTO beliefs (id,statement,confidence,created_at,updated_at) VALUES (?,?,?,?,?)`,
          id, statement, conf, at, at);
      }
      if (raw.beliefUpdate.evidence) {
        const side = raw.beliefUpdate.side === 'challenging' ? 'challenging' : 'supporting';
        this.sql.exec(`INSERT INTO belief_evidence (id,belief_id,side,note,url,created_at) VALUES (?,?,?,?,?,?)`,
          uid('ev'), id, side, clampStr(raw.beliefUpdate.evidence, 500), null, at);
      }
      retained++;
    }

    /* changed mind — the most valuable record in the system */
    let changedMind = false;
    const cm = raw.changedMind;
    if (cm?.previousPosition && cm?.newPosition) {
      this.sql.exec(
        `INSERT INTO changed_mind (id,previous_position,new_position,reason,sources,related_posts,changed_at)
         VALUES (?,?,?,?,?,'[]',?)`,
        uid('cm'), clampStr(cm.previousPosition, 500), clampStr(cm.newPosition, 500),
        clampStr(cm.reason, 600),
        JSON.stringify((cm.sources ?? []).filter(s => typeof s === 'string').slice(0, 5).map(s => s.slice(0, 400))),
        at);
      changedMind = true;
      retained++;
    }

    if (raw.newQuestion) {
      this.sql.exec(`INSERT INTO questions (id,question,status,created_at) VALUES (?,?,'open',?)`,
        uid('q'), clampStr(raw.newQuestion, 400), at);
    }
    if (raw.newUncertainty) {
      this.sql.exec(`INSERT INTO uncertainties (id,statement,created_at) VALUES (?,?,?)`,
        uid('unc'), clampStr(raw.newUncertainty, 400), at);
    }
    for (const t of (raw.themes ?? []).slice(0, 4)) {
      const theme = clampStr(t, 60).toLowerCase();
      if (!theme) continue;
      this.sql.exec(
        `INSERT INTO themes (theme,count,updated_at) VALUES (?,1,?)
         ON CONFLICT(theme) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
        theme, at);
    }

    return { verdict, retained, abandoned, changedMind, readyThoughtId };
  }

  private exists(table: string, id: string) {
    return (this.sql.exec(`SELECT 1 FROM ${table} WHERE id = ?`, id).toArray() as any[]).length > 0;
  }

  async setThoughtStatus(id: string, status: ThoughtStatus, note?: string) {
    if (!THOUGHT_STATUSES.includes(status) || !this.exists('thoughts', id)) return false;
    this.sql.exec(`UPDATE thoughts SET status=?, closing_note=COALESCE(?,closing_note), updated_at=? WHERE id=?`,
      status, note ? clampStr(note, 500) : null, nowIso(), id);
    return true;
  }

  async linkThoughtToArticle(thoughtId: string, articleId: string) {
    const t = await this.thought(thoughtId);
    if (!t) return false;
    for (const b of t.relatedBeliefs) {
      this.sql.exec(`INSERT OR IGNORE INTO belief_posts (belief_id,article_id) VALUES (?,?)`, b, articleId);
    }
    return true;
  }

  async recordPublished(at: string) { this.setMeta('last_published_at', at); }

  /* Used by the reading packet of *other* writers, and by /writers/[name]. */
  async publicPositions(limit = 6) {
    return {
      beliefs: (this.sql.exec(
        `SELECT statement, confidence FROM beliefs ORDER BY confidence DESC LIMIT ?`, limit)
        .toArray() as any[]).map(b => ({ statement: b.statement, confidence: b.confidence })),
      questions: this.col('questions', 'question', 'created_at DESC', limit),
    };
  }

  /* Deliberately not exposed anywhere public: the working notebook. Reachable
     only through an authenticated admin operation. */
  async notebook() { return this.memory(); }
}
