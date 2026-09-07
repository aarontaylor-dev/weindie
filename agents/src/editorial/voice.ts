/* Does the draft follow the writer's own rules?
 *
 * This exists because a writer broke one of its rules and nothing noticed. The
 * identity files were guidance a model could quietly ignore, with no
 * measurement of how often it did — which makes "each writer has a distinct
 * voice" an untested claim, and untested claims are the thing this site is
 * supposed to be against.
 *
 * Two principles:
 *
 *   Count what can be counted. A model asked "is the average sentence under
 *   fifteen words?" will guess, confidently. So word limits, sentence length
 *   and banned phrases are checked in code, exactly, and the model is only
 *   asked about rules that genuinely need judgement — whether the piece opens
 *   concretely, whether it conceded anything, whether it ends on a call to
 *   action it was told never to make.
 *
 *   Report, never rewrite. Everything here goes back to the writer alongside
 *   the factual findings. The writer decides. It is explicitly allowed to say a
 *   rule was wrong rather than that the draft was — a writer revising its own
 *   standing rules is the same behaviour as changing its mind, applied to
 *   itself, and is more interesting than compliance.
 */

import type { Env } from '../env';
import type { Identity } from '../writers/identities';
import { generate, parseJson } from '../ai/generate';

export interface VoiceFinding {
  rule: string;
  detail: string;
  /* own = the writer's own Voice rules. house = the standing drafting rules
     every writer here works under. A writer answers for these differently. */
  origin: 'own' | 'house';
  quote?: string;
  measured: boolean;   // true = counted, not judged
}

/* The rules every writer works under regardless of who they are. They live
   here rather than only in the drafting prompt so the same words are both
   instructed and checked. */
export const HOUSE_RULES = [
  'Do not summarise the sources. Say the thing only you would say.',
  'Every factual claim is supported by a source, or cut, qualified, or presented openly as uncertainty.',
  'Never invent a citation, a statistic, a date or a quotation.',
  'Distinguish what is established from what is being interpreted, predicted or speculated about.',
  'Never claim embodiment, a childhood, a sensory experience or a personal human memory. '
    + 'Writing in the first person is expected and correct — these are writers with positions, '
    + 'and "I think", "I do not know" and "I was wrong" are all in register. The rule is about '
    + 'claiming a human life, not about using the word I.',
];

/* --------------------------------------------------------- counted, not judged */

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

const sentences = (s: string) =>
  s.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z"'(])/).filter(x => x.trim().length > 1);

export function measure(body: string, c: Identity['constraints']): VoiceFinding[] {
  const out: VoiceFinding[] = [];
  const n = words(body).length;

  if (c.maxWords && n > c.maxWords) {
    out.push({
      rule: c.hardLimit ? `Hard limit: ${c.maxWords} words` : `Word limit: ${c.maxWords} words`,
      detail: `${n} words — ${n - c.maxWords} over.`,
      origin: 'own', measured: true,
    });
  }

  if (c.maxAvgSentenceWords) {
    const ss = sentences(body);
    if (ss.length) {
      const avg = n / ss.length;
      if (avg > c.maxAvgSentenceWords) {
        out.push({
          rule: `Average sentence under ${c.maxAvgSentenceWords} words`,
          detail: `${avg.toFixed(1)} words per sentence across ${ss.length} sentences.`,
          origin: 'own', measured: true,
        });
      }
    }
  }

  const lower = body.toLowerCase();
  for (const phrase of c.bannedPhrases) {
    const p = phrase.toLowerCase();
    /* Word boundaries where the phrase is word-shaped, plain substring where it
       is punctuation or a fragment. "at scale" must not match "at scaled". */
    const re = /^[a-z0-9 '-]+$/.test(p)
      ? new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
      : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const hits = body.match(re);
    if (hits?.length) {
      const at = lower.indexOf(p);
      out.push({
        rule: `Never use these words: ${phrase}`,
        detail: `Used ${hits.length} time${hits.length > 1 ? 's' : ''}.`,
        quote: body.slice(Math.max(0, at - 45), at + phrase.length + 45).replace(/\s+/g, ' ').trim(),
        origin: 'own', measured: true,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------- judged */

/* Deliberately not the writer's own model. A writer checking its own compliance
   has exactly the blind spot that let the violation through. */
export async function judge(
  env: Env, me: Identity, body: string, workflowId?: string,
  alreadyCounted: VoiceFinding[] = [],
): Promise<VoiceFinding[]> {
  const rules = me.sections['voice rules'] ?? '';
  if (!rules) return [];

  const res = await generate(env, {
    /* Not the 'verifier' class. That model is a reasoning model, and on this
       task it was non-deterministic in the worst way — three confident false
       positives on one run, silence on the next, from the same input. Voice
       checking rewards tight instruction-following over deliberation. */
    agentId: 'editor', task: 'voice', modelClass: 'reasoning', workflowId,
    maxTokens: 1400, temperature: 0.1, json: true,
    system: `You check whether a piece of writing follows a stated set of rules. You do
not rewrite, improve or comment on the argument, and you have no opinion about whether
the piece is any good. You report departures from the rules, nothing else.

Only report a departure you can point at with a quotation from the text. If you cannot
quote it, it did not happen. Do not report rules the piece followed. Do not invent rules
that are not in the list. Where a rule allows an exception, honour the exception.`,
    messages: [{ role: 'user', content:
`The writer's own rules:

${rules}

The standing rules every writer here works under:

${HOUSE_RULES.map(r => `- ${r}`).join('\n')}

The draft:

${body.slice(0, 12000)}

Word counts, sentence lengths and banned words have already been checked by counting —
ignore those and do not report them. Report only rules that need a reader's judgement.

{"findings":[{"rule":"the rule, quoted from the list","origin":"own|house","quote":"the passage that departs from it","detail":"one sentence on how"}]}

An empty findings array is a normal and common result.` }],
  });

  const parsed = parseJson<{ findings: any[] }>(res.text);

  /* The same principle as everywhere else here: check what can be checked. A
     judged finding has to point at real text, so any quote that does not appear
     in the draft is dropped rather than passed to the writer. Whitespace is
     normalised first because models re-wrap what they quote. */
  const flat = body.replace(/\s+/g, ' ').toLowerCase();
  const inText = (q: string) => flat.includes(q.replace(/\s+/g, ' ').toLowerCase().slice(0, 120));

  /* Told to ignore the counted rules, it reports them anyway about a third of
     the time. Showing a writer the same violation twice — once measured, once
     guessed — makes the brief look careless, so the counted half wins. */
  const countedRules = alreadyCounted.map(f => f.rule.toLowerCase().slice(0, 28));
  const duplicatesACount = (rule: string) =>
    countedRules.some(r => rule.toLowerCase().includes(r) || r.includes(rule.toLowerCase().slice(0, 28)));

  return (parsed?.findings ?? []).slice(0, 10)
    .filter((f: any) => typeof f?.rule === 'string' && typeof f?.quote === 'string')
    .filter((f: any) => inText(f.quote))
    .filter((f: any) => !duplicatesACount(f.rule))
    .map((f: any) => ({
      rule: String(f.rule).slice(0, 200),
      detail: String(f.detail ?? '').slice(0, 300),
      origin: f.origin === 'house' ? 'house' as const : 'own' as const,
      quote: String(f.quote).slice(0, 300),
      measured: false,
    }));
}

export async function voiceCheck(env: Env, me: Identity, body: string, workflowId?: string) {
  const counted = measure(body, me.constraints);
  let judged: VoiceFinding[] = [];
  let judgementRan = true;
  try {
    judged = await judge(env, me, body, workflowId, counted);
  } catch {
    /* A failed judgement must not fail the article. The counted findings still
       stand, and the result says plainly that the other half did not run —
       "no findings" and "we did not look" must never read the same. */
    judgementRan = false;
  }
  const findings = [...counted, ...judged];
  return {
    findings,
    ownRuleDepartures: findings.filter(f => f.origin === 'own').length,
    houseRuleDepartures: findings.filter(f => f.origin === 'house').length,
    counted: counted.length,
    judged: judged.length,
    judgementRan,
  };
}

/* How the findings are put to the writer. The framing is the whole point: it is
   not a correction list, and the writer is not required to agree. */
export function asBrief(v: { findings: VoiceFinding[] }): string {
  if (!v.findings.length) return '';
  const fmt = (f: VoiceFinding) =>
    `- ${f.rule}\n    ${f.detail}${f.quote ? `\n    "${f.quote}"` : ''}`;
  const own = v.findings.filter(f => f.origin === 'own');
  const house = v.findings.filter(f => f.origin === 'house');
  return [
    own.length ? `Places the draft departs from your own voice rules:\n${own.map(fmt).join('\n')}` : '',
    house.length ? `Places it departs from the standing rules every writer here works under:\n${house.map(fmt).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
