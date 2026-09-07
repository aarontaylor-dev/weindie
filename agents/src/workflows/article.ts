/* The article pipeline.
 *
 * The important design decision is in stages 6 to 11. An editorial system that
 * rewrites is a house style with extra steps: six writers in, one voice out.
 * This one only ever *reports*. It extracts what the draft asserts, checks the
 * factual assertions against the sources that were actually gathered, and hands
 * the findings back to the writer who wrote it. The writer decides what to
 * change. It is allowed to disagree with the counterargument, and it is allowed
 * to keep a claim by marking it as uncertain rather than removing it.
 *
 * The pipeline ends at awaiting_human_approval. There is no branch that
 * publishes.
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../env';
import { ARTICLE, type WriterId, isWriterId } from '../config';
import { identity, systemPrompt, EDITOR_PROMPT } from '../writers/identities';
import { asSourceBlock } from '../radar/sanitise';
import { generate, parseJson } from '../ai/generate';
import { voiceCheck, asBrief, type VoiceFinding } from '../editorial/voice';
import { nowIso, uid, slugify } from '../util';

export interface ArticleParams { writer: WriterId; thoughtId: string }

type ClaimKind = 'fact' | 'interpretation' | 'prediction' | 'speculation' | 'opinion';
const CLAIM_KINDS: ClaimKind[] = ['fact', 'interpretation', 'prediction', 'speculation', 'opinion'];

/* Two attempts, not five. A step here fails either because a model was briefly
   unavailable — which one retry covers — or because of something a retry will
   never fix. Backing off exponentially for an hour on the second kind hides the
   fault and holds a workflow slot. */
const RETRY = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export class ArticleWorkflow extends WorkflowEntrypoint<Env, ArticleParams> {
  async run(event: WorkflowEvent<ArticleParams>, step: WorkflowStep) {
    const env = this.env;
    const workflowId = event.instanceId;
    const { writer, thoughtId } = event.payload;
    if (!isWriterId(writer)) throw new Error('unknown writer');

    const me = identity(writer);
    const stub = env.WRITER.get(env.WRITER.idFromName(writer));

    /* 1 — gather the thought and the relevant memory ----------------------- */
    const ctx = await step.do('gather thought and memory', RETRY, async () => {
      const t = await stub.thought(thoughtId);
      if (!t) throw new Error(`thought ${thoughtId} not found for ${writer}`);
      const mem = await stub.packetContext(6, 6);
      return { thought: t, mem };
    });

    /* 2/3 — research, and build a source packet ---------------------------- *
     * Retrieval is plain SQL over what Radar already collected: the terms of
     * the thought against titles, summaries and tags. No vector store, because
     * nothing here has yet failed for want of one. */
    const sources = await step.do('research and build source packet', RETRY, async () => {
      const words = ctx.thought.workingIdea.toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
        .filter(w => w.length > 4).slice(0, 8);

      const seen = new Map<string, any>();
      const add = (rows: any[]) => { for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r); };

      if (words.length) {
        /* Qualify every column: `topics` exists on both tables in this join. */
        const where = words.map(() =>
          `(lower(si.title) LIKE ? OR lower(si.summary) LIKE ? OR lower(si.topics) LIKE ?)`).join(' OR ');
        const binds = words.flatMap(w => [`%${w}%`, `%${w}%`, `%${w}%`]);
        const { results } = await env.DB.prepare(
          `SELECT si.*, s.publisher FROM source_items si JOIN sources s ON s.id = si.source_id
            WHERE ${where} ORDER BY si.relevance DESC, si.retrieved_at DESC LIMIT 8`)
          .bind(...binds).all<any>();
        add(results ?? []);
      }

      /* Anything the writer explicitly noted while forming this thought. */
      const { results: noted } = await env.DB.prepare(
        `SELECT si.*, s.publisher FROM observations o
           JOIN source_items si ON si.id = o.source_item_id
           JOIN sources s ON s.id = si.source_id
          WHERE o.writer = ? ORDER BY o.created_at DESC LIMIT 6`).bind(writer).all<any>();
      add(noted ?? []);

      return [...seen.values()].slice(0, 10).map((r: any, i: number) => ({
        n: i + 1, id: r.id, url: r.url, title: r.title, publisher: r.publisher,
        publishedAt: r.published_at, summary: r.summary ?? '',
        text: (r.excerpt ?? r.summary ?? '').slice(0, 900),
      }));
    });

    const sourceBlock = sources.length ? asSourceBlock(sources) : '(no stored sources matched this thought)';

    /* 4 — outline ---------------------------------------------------------- */
    const outline = await step.do('outline', RETRY, async () => {
      const res = await generate(env, {
        agentId: writer, task: 'outline', modelClass: 'writer', workflowId,
        system: systemPrompt(me, 'outline'), maxTokens: ARTICLE.tokens.outline, temperature: 0.7,
        messages: [{ role: 'user', content:
`You have decided this is worth writing:

  ${ctx.thought.workingIdea}

Observations you gathered while forming it:
${ctx.thought.observations.map(o => `- ${o.note}`).join('\n') || '- (none recorded)'}
Tensions you noticed:
${ctx.thought.tensions.map(t => `- ${t}`).join('\n') || '- (none recorded)'}

Material available:

${sourceBlock}

Sketch the piece. What is the actual claim — the one a reader could disagree with?
What does the piece contribute beyond summarising the material? Where does the
argument admit its own weakness?

Six to ten lines. Not prose yet.` }],
      });
      return res.text.slice(0, 2500);
    });

    /* 5 — draft ------------------------------------------------------------ */
    const draft = await step.do('draft', RETRY, async () => {
      const res = await generate(env, {
        agentId: writer, task: 'draft', modelClass: 'writer', workflowId,
        system: systemPrompt(me, 'draft'), maxTokens: ARTICLE.tokens.draft, temperature: 0.8,
        messages: [{ role: 'user', content:
`Write the essay, in your own voice, following your voice rules exactly.

Your outline:
${outline}

Material:

${sourceBlock}

Rules that override everything else:
- Every factual claim must be supported by one of the sources above. If you cannot
  support it, do not assert it: cut it, qualify it, or present it openly as something
  you are uncertain about.
- Never invent a citation, a statistic, a date or a quotation.
- Distinguish what is established from what you are interpreting, predicting or
  speculating about. Your reader should always be able to tell which one they are
  reading.
- You are an AI. Do not write as though you have a body or a human past.
- Do not summarise the sources. Say the thing only you would say.

Return JSON:
{"title":"...","standfirst":"one sentence under the title","body":"the essay, plain paragraphs separated by blank lines","topic":"two or three words","confidence":"low|medium|high","beliefEffect":"reinforced|changed|new|unresolved"}` }],
        json: true,
      });
      const d = parseJson<any>(res.text);
      if (!d?.body) throw new Error('draft produced no body');
      return {
        title: String(d.title ?? ctx.thought.workingIdea).slice(0, 160),
        standfirst: String(d.standfirst ?? '').slice(0, 300),
        body: String(d.body).slice(0, 20000),
        topic: String(d.topic ?? '').slice(0, 60),
        confidence: ['low', 'medium', 'high'].includes(d.confidence) ? d.confidence : 'medium',
        beliefEffect: ['reinforced', 'changed', 'new', 'unresolved'].includes(d.beliefEffect)
          ? d.beliefEffect : 'new',
        model: res.model, provider: res.provider,
      };
    });

    /* Persist early: a draft that exists in the database survives a failure in
       the stages after it, and a half-finished article is inspectable. */
    const articleId = await step.do('create article record', RETRY, async () => {
      const id = uid('art');
      const at = nowIso();
      await env.DB.prepare(
        `INSERT INTO articles
          (id, slug, writer, writer_version, thought_id, title, standfirst, body, topic,
           confidence, belief_effect, status, model, provider, first_thought_at, drafted_at,
           sources_considered, workflow_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'drafting',?,?,?,?,?,?,?,?)`,
      ).bind(
        id, slugify(draft.title, id.slice(-6)), writer, me.versioned, thoughtId,
        draft.title, draft.standfirst, draft.body, draft.topic, draft.confidence,
        draft.beliefEffect, draft.model, draft.provider,
        ctx.thought.createdAt, at, sources.length, workflowId, at, at,
      ).run();

      if (sources.length) {
        const stmt = env.DB.prepare(
          `INSERT INTO article_sources (id, article_id, source_item_id, url, title, publisher, published_at, cited, created_at)
           VALUES (?,?,?,?,?,?,?,0,?)`);
        await env.DB.batch(sources.map(s => stmt.bind(
          uid('as'), id, s.id, s.url, s.title, s.publisher ?? null, s.publishedAt ?? null, at)));
      }
      await env.DB.prepare(
        `INSERT INTO article_revisions (id, article_id, stage, body, notes, author, created_at)
         VALUES (?,?,'outline',NULL,?,?,?)`).bind(uid('rev'), id, outline, writer, at).run();
      await env.DB.prepare(
        `INSERT INTO article_revisions (id, article_id, stage, body, notes, author, created_at)
         VALUES (?,?,'draft',?,NULL,?,?)`).bind(uid('rev'), id, draft.body, writer, at).run();
      return id;
    });

    /* 6/7/8 — extract claims, verify them, name the unsupported ------------ */
    const claims = await step.do('extract and verify claims', RETRY, async () => {
      const res = await generate(env, {
        agentId: 'editor', task: 'claims', modelClass: 'verifier', workflowId,
        system: EDITOR_PROMPT, maxTokens: ARTICLE.tokens.claims, temperature: 0.1, json: true,
        messages: [{ role: 'user', content:
`Draft:

${draft.body}

Sources available to the writer:

${sourceBlock}

List every assertion in the draft. For each: classify it, and if it is a factual claim,
check it against the sources.

- fact: a checkable statement about the world
- interpretation: a reading of something, not itself checkable
- prediction: about the future
- speculation: explicitly hypothetical
- opinion: a value judgement

verdict applies to facts only: "supported" if a source above states it, "unsupported" if
no source does, "uncertain" if a source partially bears on it. Unsupported means not
shown here — never assert that a claim is false. Never invent a source.

{"claims":[{"claim":"...","kind":"fact","verdict":"supported","sourceUrl":"..."}]}` }],
      });
      const parsed = parseJson<{ claims: any[] }>(res.text);
      const list = (parsed?.claims ?? []).slice(0, 40).filter((c: any) => typeof c?.claim === 'string');

      const at = nowIso();
      const rows = list.map((c: any) => ({
        claim: String(c.claim).slice(0, 500),
        kind: (CLAIM_KINDS.includes(c.kind) ? c.kind : 'interpretation') as ClaimKind,
        verdict: ['supported', 'unsupported', 'uncertain'].includes(c.verdict) ? c.verdict : null,
        sourceUrl: typeof c.sourceUrl === 'string' ? c.sourceUrl.slice(0, 500) : null,
      }));

      if (rows.length) {
        const stmt = env.DB.prepare(
          `INSERT INTO article_claims (id, article_id, claim, kind, verdict, source_url, created_at)
           VALUES (?,?,?,?,?,?,?)`);
        await env.DB.batch(rows.map(r => stmt.bind(
          uid('clm'), articleId, r.claim, r.kind,
          r.kind === 'fact' ? r.verdict : 'not_applicable', r.sourceUrl, at)));
      }

      const cited = new Set(rows.map(r => r.sourceUrl).filter(Boolean) as string[]);
      if (cited.size) {
        const stmt = env.DB.prepare(
          `UPDATE article_sources SET cited = 1 WHERE article_id = ? AND url = ?`);
        await env.DB.batch([...cited].map(u => stmt.bind(articleId, u)));
      }

      return {
        all: rows,
        unsupported: rows.filter(r => r.kind === 'fact' && r.verdict === 'unsupported'),
        uncertain: rows.filter(r => r.kind === 'fact' && r.verdict === 'uncertain'),
        citedCount: cited.size,
      };
    });

    /* 9 — the strongest plausible counterargument -------------------------- */
    const counter = await step.do('counterargument', RETRY, async () => {
      const res = await generate(env, {
        agentId: 'editor', task: 'counterargument', modelClass: 'reasoning', workflowId,
        system: `You construct the strongest honest objection to an argument. Not the easiest
one to knock down — the one that would most worry the person who wrote it. Two paragraphs.
State it as a case, not as advice, and do not suggest how to answer it.`,
        maxTokens: ARTICLE.tokens.counter, temperature: 0.5,
        messages: [{ role: 'user', content: draft.body.slice(0, 8000) }],
      });
      return res.text.slice(0, 2000);
    });

    /* 9b — does the draft follow the writer's own rules? ------------------- *
     * Counted where it can be counted, judged only where judgement is needed,
     * and reported rather than corrected — like every other editorial stage. */
    const voice = await step.do('voice check', RETRY, async () =>
      voiceCheck(env, me, draft.body, workflowId));

    /* 10/11 — findings go back to the writer; the writer revises ----------- */
    const revised = await step.do('writer revises', RETRY, async () => {
      const findings = [
        claims.unsupported.length
          ? `Factual claims not supported by your sources:\n${claims.unsupported.map(c => `- ${c.claim}`).join('\n')}`
          : 'No unsupported factual claims found.',
        claims.uncertain.length
          ? `Only partly supported:\n${claims.uncertain.map(c => `- ${c.claim}`).join('\n')}`
          : '',
        asBrief(voice),
        `The strongest objection to your argument:\n${counter}`,
      ].filter(Boolean).join('\n\n');

      const res = await generate(env, {
        agentId: writer, task: 'revise', modelClass: 'writer', workflowId,
        system: systemPrompt(me, 'revise'), maxTokens: ARTICLE.tokens.revise, temperature: 0.7, json: true,
        messages: [{ role: 'user', content:
`Your draft:

${draft.body}

Editorial findings. These are checks, not edits. Nobody is rewriting you, and nobody is
asking you to sound different:

${findings}

Deal with the unsupported claims: cut each one, qualify it, or state plainly that it is
something you believe but cannot show. Do not add a citation you do not have.

Then answer the objection — in the piece, in your voice. You may concede it, you may
show why it does not hold, or you may say it is the strongest reason you might be
wrong and leave it standing. You are not required to win.

Then the voice findings, if there are any. You wrote those rules. Fix the places the
draft departs from them — or say the rule was wrong, and why. Deciding a rule of yours
no longer serves you is a real answer and a more interesting one than compliance; what
is not acceptable is breaking it without noticing. The standing rules are not yours to
overturn, but you may explain why a passage does not really breach one.

Keep your own argument. This is your piece.

{"body":"the revised essay","changeNote":"one sentence on what you changed and why","voiceResponse":"what you did about the voice findings, or why you disagree with them — omit if there were none","confidence":"low|medium|high"}` }],
      });
      const r = parseJson<any>(res.text);
      return {
        body: String(r?.body ?? draft.body).slice(0, 20000),
        changeNote: String(r?.changeNote ?? '').slice(0, 400),
        voiceResponse: r?.voiceResponse ? String(r.voiceResponse).slice(0, 600) : null,
        confidence: ['low', 'medium', 'high'].includes(r?.confidence) ? r.confidence : draft.confidence,
      };
    });

    /* 11b — did the revision actually fix it? Counted again on the final text,
       because "the writer said it addressed the findings" and "the findings are
       gone" are different claims, and only one of them is checkable. */
    const voiceAfter = await step.do('voice recheck', RETRY, async () =>
      voiceCheck(env, me, revised.body, workflowId));

    /* 12 — duplication check against what this site has already published --- */
    const duplication = await step.do('duplication check', RETRY, async () => {
      const { results } = await env.DB.prepare(
        `SELECT id, title, body FROM articles WHERE id != ? AND status IN ('published','awaiting_human_approval')
          ORDER BY created_at DESC LIMIT 40`).bind(articleId).all<any>();

      /* Shingle overlap. Crude, local, and enough to catch a writer re-running
         its own argument — which is the failure this is actually guarding
         against, not plagiarism of the wider web. */
      const shingles = (s: string) => {
        const w = s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
        const out = new Set<string>();
        for (let i = 0; i + 5 <= w.length; i++) out.add(w.slice(i, i + 5).join(' '));
        return out;
      };
      const mine = shingles(revised.body);
      let worst = { id: '', title: '', overlap: 0 };
      for (const a of results ?? []) {
        const theirs = shingles(a.body ?? '');
        if (!theirs.size || !mine.size) continue;
        let hits = 0;
        for (const s of mine) if (theirs.has(s)) hits++;
        const overlap = hits / mine.size;
        if (overlap > worst.overlap) worst = { id: a.id, title: a.title, overlap };
      }
      return { ...worst, flagged: worst.overlap > 0.18 };
    });

    /* 13/14/15 — final draft, provenance, and a stop ----------------------- */
    const result = await step.do('finalise and hold for a human', RETRY, async () => {
      const at = nowIso();
      await env.DB.prepare(
        `INSERT INTO article_revisions (id, article_id, stage, body, notes, author, created_at)
         VALUES (?,?,'revision',?,?,?,?)`)
        .bind(uid('rev'), articleId, revised.body, revised.changeNote, writer, at).run();

      await env.DB.prepare(
        `UPDATE articles
            SET body=?, confidence=?, status=?, counterargument=?, editorial_findings=?,
                sources_cited=?, updated_at=?
          WHERE id=?`,
      ).bind(
        revised.body, revised.confidence, ARTICLE.terminalStatus, counter,
        JSON.stringify({
          claimsExtracted: claims.all.length,
          unsupported: claims.unsupported.map(c => c.claim),
          uncertain: claims.uncertain.map(c => c.claim),
          changeNote: revised.changeNote,
          voice: {
            beforeRevision: voice.findings,
            afterRevision: voiceAfter.findings,
            resolved: voice.findings.length - voiceAfter.findings.length,
            writerResponse: revised.voiceResponse,
          },
          duplication,
        }),
        claims.citedCount, at, articleId,
      ).run();

      await env.DB.prepare(
        `INSERT INTO publication_events (id, article_id, event, actor, note, created_at)
         VALUES (?,?, 'submitted', ?, 'awaiting human approval', ?)`)
        .bind(uid('pe'), articleId, writer, at).run();

      await stub.linkThoughtToArticle(thoughtId, articleId);
      await stub.setThoughtStatus(thoughtId, 'merged_into_other_thought', 'became an article');
      return { articleId, status: ARTICLE.terminalStatus };
    });

    return {
      ...result,
      writer,
      title: draft.title,
      sourcesConsidered: sources.length,
      sourcesCited: claims.citedCount,
      claims: claims.all.length,
      unsupported: claims.unsupported.length,
      voiceDepartures: { before: voice.findings.length, after: voiceAfter.findings.length },
      duplicationFlagged: duplication.flagged,
    };
  }
}
