/* A reading session.
 *
 * Nobody is asked to write anything here. A writer is handed a small packet —
 * some things on its beat, one or two deliberately off it, whatever the other
 * five have published lately, and its own live thoughts and beliefs — and asked
 * one question: did any of this change anything for you?
 *
 * The expected answer is no. That is not a degraded outcome to be minimised; it
 * is the behaviour the whole system exists to make possible. A session that
 * retains nothing is recorded as a success, and so is a session whose only
 * result is abandoning an idea the writer has been carrying for weeks.
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../env';
import { agentsEnabled } from '../env';
import { READING, type WriterId, isWriterId } from '../config';
import { identity, systemPrompt } from '../writers/identities';
import { asSourceBlock } from '../radar/sanitise';
import { generate, parseJson, BudgetExceeded, isPermanentModelError } from '../ai/generate';
import type { ReadingOutcome } from '../writers/WriterAgent';
import { nowIso, uid } from '../util';

export interface ReadingParams {
  writer: WriterId;
  trigger?: string;
  /* Testing mode: hand all six writers the same topic and see what differs. */
  seedTopic?: string;
  /* Auto-start an article when a thought reaches ready_to_write. Off unless the
     system is running autonomously, so a manual test session cannot quietly
     kick off a seven-call article pipeline. */
  autoArticle?: boolean;
}

/* See the note on RETRY in article.ts — same reasoning. */
const RETRY = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export class ReadingWorkflow extends WorkflowEntrypoint<Env, ReadingParams> {
  async run(event: WorkflowEvent<ReadingParams>, step: WorkflowStep) {
    const env = this.env;
    const workflowId = event.instanceId;
    const writerId = event.payload.writer;
    if (!isWriterId(writerId)) throw new Error('unknown writer');

    const me = identity(writerId);
    const stub = env.WRITER.get(env.WRITER.idFromName(writerId));

    const readingId = await step.do('open reading log', RETRY, async () => {
      const id = uid('rd');
      await env.DB.prepare(
        `INSERT INTO writer_reading_log (id, writer, started_at, workflow_id, trigger)
         VALUES (?,?,?,?,?)`,
      ).bind(id, writerId, nowIso(), workflowId, event.payload.trigger ?? 'manual').run();
      return id;
    });

    /* ------------------------------------------------------------- packet */

    const packet = await step.do('build reading packet', RETRY, async () => {
      const mine = await stub.packetContext(READING.thoughtsInPacket, READING.beliefsInPacket);

      if (event.payload.seedTopic) {
        /* Testing mode: one supplied topic, no feed material, everything else
           the same. Six writers, one input — the point is the difference. */
        return {
          onBeat: [{
            n: 1, id: null as string | null, title: 'Supplied for consideration',
            url: 'weindie:test', text: event.payload.seedTopic.slice(0, 2000),
            summary: '', publisher: 'WeIndie test harness',
          }],
          offBeat: [], recent: [], mine,
        };
      }

      /* On-beat: recent items whose Radar topics overlap this writer's declared
         interests. Off-beat: recent items that overlap nothing they care about.
         Six writers reading only their own beat would converge on six echo
         chambers, so the off-beat items are not optional. */
      const { results } = await env.DB.prepare(
        `SELECT si.id, si.url, si.title, si.summary, si.topics, si.relevance, si.excerpt,
                si.published_at, s.publisher
           FROM source_items si JOIN sources s ON s.id = si.source_id
          WHERE si.id NOT IN (SELECT COALESCE(source_item_id,'') FROM observations WHERE writer = ?)
          ORDER BY si.retrieved_at DESC LIMIT 60`,
      ).bind(writerId).all<any>();

      const items = (results ?? []).map((r: any) => {
        let topics: string[] = [];
        try { topics = JSON.parse(r.topics); } catch { /* stored malformed; treat as untagged */ }
        const overlap = topics.filter(t => me.topics.includes(t)).length;
        return { ...r, topics, overlap };
      });

      const on = items.filter(i => i.overlap > 0)
        .sort((a, b) => (b.overlap - a.overlap) || (b.relevance - a.relevance))
        .slice(0, READING.itemsOnBeat);
      const onIds = new Set(on.map(i => i.id));
      const off = items.filter(i => i.overlap === 0 && !onIds.has(i.id))
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, READING.itemsOffBeat);

      const shape = (r: any, n: number) => ({
        n, id: r.id, title: r.title, url: r.url, publisher: r.publisher,
        summary: r.summary ?? '', text: (r.excerpt ?? r.summary ?? '').slice(0, READING.excerptChars),
      });

      const { results: recent } = await env.DB.prepare(
        `SELECT writer, title, standfirst FROM articles
          WHERE status = 'published' ORDER BY published_at DESC LIMIT 5`).all<any>();

      return {
        onBeat: on.map((r, i) => shape(r, i + 1)),
        offBeat: off.map((r, i) => shape(r, on.length + i + 1)),
        recent: recent ?? [],
        mine,
      };
    });

    const offered = packet.onBeat.length + packet.offBeat.length;
    if (offered === 0) {
      await step.do('close: nothing to read', RETRY, async () => {
        await env.DB.prepare(
          `UPDATE writer_reading_log SET finished_at=?, items_offered=0, items_outside=0,
             outcome='nothing_retained', note='no unread material' WHERE id=?`,
        ).bind(nowIso(), readingId).run();
      });
      return { writer: writerId, outcome: 'nothing_retained', note: 'no unread material' };
    }

    /* ------------------------------------------------------------ reflect */

    const outcome = await step.do('reflect', RETRY, async () => {
      const mine = packet.mine;
      const sources = asSourceBlock([...packet.onBeat, ...packet.offBeat]);

      const context = [
        mine.thoughts.length
          ? `Thoughts you are currently carrying:\n${mine.thoughts.map(t =>
              `- [${t.id}] (${t.status}) ${t.workingIdea}${t.tensions.length ? `\n    tension: ${t.tensions.join('; ')}` : ''}`).join('\n')}`
          : 'You are not currently carrying any developing thoughts.',
        mine.beliefs.length
          ? `Positions you hold:\n${mine.beliefs.map(b =>
              `- ${b.statement} (confidence ${b.confidence.toFixed(2)})`).join('\n')}`
          : 'You have not yet recorded any positions.',
        mine.questions.length ? `Questions you are carrying:\n${mine.questions.map(q => `- ${q}`).join('\n')}` : '',
        packet.recent.length
          ? `Recently published at WeIndie by the others:\n${packet.recent.map((a: any) =>
              `- ${a.writer}: ${a.title}${a.standfirst ? ` — ${a.standfirst}` : ''}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n\n');

      const prompt =
`${context}

Here is what has come in. Items ${packet.onBeat.length + 1}–${offered} are deliberately outside
what you usually follow.

${sources}

Did anything here materially challenge, reinforce, complicate or connect with something
you are already thinking about?

Most of the time the honest answer is no, and "nothing_retained" is the correct verdict.
Do not retain something because it is on your subject. Retain it only if it changed
something for you. Do not manufacture a thought to justify having read.

If a thought you are carrying now looks wrong, thin, or like something you no longer
believe is going anywhere, abandon it. Abandoning is a result, not a failure.

Use "ready_to_write" only if several observations have genuinely connected, or a
position of yours has been challenged, and you have something to say that is not a
summary of the material and not the obvious reaction. A launch, an announcement or a
trending subject is not a reason to write.

Return JSON:
{
  "verdict": "nothing_retained" | "retained" | "ready_to_write",
  "summary": "one sentence, in your own voice, on what happened in this session",
  "observations": [{"kind":"challenged|reinforced|complicated|connected","note":"...","sourceUrl":"..."}],
  "newThought": {"workingIdea":"...","tension":"..."},
  "advanceThought": {"id":"th_...","status":"developing|researching|ready_to_write","observation":"...","tension":"..."},
  "abandonThought": {"id":"th_...","reason":"..."},
  "beliefUpdate": {"statement":"...","confidence":0.0,"evidence":"...","side":"supporting|challenging"},
  "changedMind": {"previousPosition":"...","newPosition":"...","reason":"...","sources":["url"]},
  "newQuestion": "...",
  "newUncertainty": "...",
  "themes": ["short tag"]
}

Include only the keys that apply. For "nothing_retained", send verdict and summary alone.`;

      try {
        const res = await generate(env, {
          agentId: writerId, task: 'reading', modelClass: 'writer',
          system: systemPrompt(me, 'reading'),
          messages: [{ role: 'user', content: prompt }],
          json: true, maxTokens: READING.maxTokens, temperature: 0.75, workflowId,
        });
        const parsed = parseJson<ReadingOutcome>(res.text);
        if (!parsed) {
          /* Not "nothing worth retaining". The writer may well have decided
             something; we could not read the reply. Recording it as a genuine
             null result would quietly inflate the one statistic this project
             exists to measure honestly. */
          return { verdict: 'nothing_retained', summary: 'The model reply could not be read.',
                   failed: 'unreadable' } as any;
        }
        return parsed;
      } catch (e: any) {
        if (e instanceof BudgetExceeded) {
          return { verdict: 'nothing_retained', summary: `Session skipped: ${e.message}`,
                   failed: 'budget' } as any;
        }
        const msg = String(e?.message ?? e);
        if (isPermanentModelError(msg)) {
          /* A model this account cannot call will never become callable by
             being retried. Fail the session, not the workflow. */
          return { verdict: 'nothing_retained', summary: msg.slice(0, 300),
                   failed: 'model_unavailable' } as any;
        }
        throw e;
      }
    });

    /* ------------------------------------------------------------- persist */

    const applied = await step.do('write to notebook', RETRY, async () => {
      const r = await stub.applyReading(outcome as ReadingOutcome);

      const at = nowIso();
      const urlToId = new Map<string, string>(
        [...packet.onBeat, ...packet.offBeat].map(i => [i.url, i.id as string]));
      const obs = Array.isArray((outcome as any).observations) ? (outcome as any).observations : [];
      const rows = obs.slice(0, 4).filter((o: any) => typeof o?.note === 'string');

      if (rows.length) {
        const stmt = env.DB.prepare(
          `INSERT INTO observations (id, writer, reading_id, source_item_id, kind, note, created_at)
           VALUES (?,?,?,?,?,?,?)`);
        await env.DB.batch(rows.map((o: any) => stmt.bind(
          uid('obs'), writerId, readingId,
          urlToId.get(String(o.sourceUrl ?? '')) ?? null,
          ['challenged', 'reinforced', 'complicated', 'connected'].includes(o.kind) ? o.kind : 'connected',
          String(o.note).slice(0, 600), at)));
      }

      /* A session that failed is an error, never a decision — only a writer gets
         to say "nothing worth retaining". But a session declined because the
         day's inference allowance is spent is neither: the system did the right
         thing, and logging it as a fault would make a correctly-behaving day
         look broken. */
      const failed = (outcome as any).failed;
      const outcomeCode =
        failed === 'budget' ? 'skipped_budget'
        : failed ? 'error'
        : r.abandoned ? 'thought_abandoned'
        : r.verdict === 'ready_to_write' ? 'ready_to_write'
        : r.verdict === 'retained' ? 'retained'
        : 'nothing_retained';

      await env.DB.prepare(
        `UPDATE writer_reading_log
            SET finished_at=?, items_offered=?, items_outside=?, outcome=?, note=?
          WHERE id=?`,
      ).bind(
        at, offered, packet.offBeat.length, outcomeCode,
        String((outcome as any).summary ?? '').slice(0, 600), readingId,
      ).run();

      return { ...r, outcomeCode };
    });

    /* A thought that is ready becomes an article — which still ends at
       awaiting_human_approval and publishes nothing on its own. */
    let articleStarted: string | null = null;
    if (applied.readyThoughtId && (event.payload.autoArticle ?? agentsEnabled(env))) {
      articleStarted = await step.do('start article', RETRY, async () => {
        const inst = await env.ARTICLE.create({
          params: { writer: writerId, thoughtId: applied.readyThoughtId },
        });
        return inst.id;
      });
    }

    return {
      writer: writerId,
      outcome: applied.outcomeCode,
      summary: String((outcome as any).summary ?? '').slice(0, 400),
      retained: applied.retained,
      abandoned: applied.abandoned,
      changedMind: applied.changedMind,
      itemsOffered: offered,
      articleStarted,
    };
  }
}
