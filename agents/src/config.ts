/* Everything you would want to change without reading the rest of the codebase.
 *
 * The schedule, the budget, and which model does which job all live here. The
 * cron expressions themselves are in wrangler.jsonc because Cloudflare needs
 * them at deploy time; this file decides what each one does.
 */

export const WRITER_IDS = ['mara', 'kit', 'rowan', 'vale', 'soren', 'iona'] as const;
export type WriterId = (typeof WRITER_IDS)[number];

export const isWriterId = (v: unknown): v is WriterId =>
  typeof v === 'string' && (WRITER_IDS as readonly string[]).includes(v);

/* ------------------------------------------------------------------ schedule */

/* They wake to read, not to publish. Most of these produce nothing, which is
   the intended behaviour and not a fault. Two Radar sweeps a day; each writer
   reads once a day, in staggered pairs, so six models never run at once.
   Five crons is the Workers Free plan ceiling. */
export const SCHEDULE: Record<string, { job: 'radar' } | { job: 'reading'; writers: WriterId[] }> = {
  '0 6 * * *':  { job: 'radar' },
  '0 17 * * *': { job: 'radar' },
  '20 7 * * *': { job: 'reading', writers: ['mara', 'kit'] },
  '40 9 * * *': { job: 'reading', writers: ['rowan', 'vale'] },
  '10 12 * * *':{ job: 'reading', writers: ['soren', 'iona'] },
};

/* --------------------------------------------------------------- model classes
 *
 * Four jobs, not four models. Which model backs a class is a deployment detail;
 * callers ask for a class. `writer` resolves per writer, because six writers
 * running the same weights is the single most likely way to end up with one
 * voice wearing six hats.
 */
export type ModelClass = 'cheap' | 'reasoning' | 'writer' | 'verifier';

export const MODELS: Record<Exclude<ModelClass, 'writer'>, string> = {
  /* classification, dedup, relevance scoring, neutral summarising */
  cheap: '@cf/meta/llama-3.1-8b-instruct-fp8',
  /* claim extraction, counterargument, belief revision */
  reasoning: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  /* verification and editorial checks — deliberately not the drafting model */
  verifier: '@cf/qwen/qwen3-30b-a3b-fp8',
};

/* Fallback if a writer's identity file names no model. */
export const DEFAULT_WRITER_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/* ----------------------------------------------------------------- the budget
 *
 * Two walls. The AI Gateway spend rules are the outer one and are enforced by
 * Cloudflare. This is the inner one, enforced in generate() before the call is
 * made, so the system can also refuse politely and record why.
 */
export const BUDGET = {
  /* Workers AI bills in neurons: $0.011 per 1,000. */
  neuronsToUsd: (n: number) => (n / 1000) * 0.011,
  /* Reserved out of the monthly ceiling for Radar, verification and editorial
     work, so six writers cannot spend the operating budget. */
  sharedReserveFraction: 0.28,
};

/* ------------------------------------------------------------------- reading */

export const READING = {
  /* How many items a writer is shown in one packet. Small on purpose: a reading
     session is not a scan of everything. */
  itemsOnBeat: 5,
  /* Deliberately outside their interests. Six writers who only ever read their
     own beat converge on six echo chambers. */
  itemsOffBeat: 2,
  /* How many of their own developing thoughts come along for the ride. */
  thoughtsInPacket: 4,
  beliefsInPacket: 4,
  /* Characters of sanitised source text per item. Untrusted content gets a
     hard budget as well as a hard boundary. */
  excerptChars: 1200,
  /* Generous, because several of these models are reasoning models that spend
     output tokens thinking before they answer — Gemma routinely spends 1,300
     before writing its first character. A cap is not a charge: a model that
     replies in 90 tokens still costs 90. Setting this too low does not save
     money, it silently truncates the reply and turns a working writer into one
     that appears to have nothing to say. */
  maxTokens: 3500,
};

/* ------------------------------------------------------------------- radar */

export const RADAR = {
  maxItemsPerSource: 6,
  maxNewItemsPerSweep: 24,
  fetchTimeoutMs: 8000,
  userAgent: 'WeIndie-Radar/0.1 (+https://weindie.com/writers)',
};

/* ------------------------------------------------------------------ articles */

export const ARTICLE = {
  /* Same reasoning as READING.maxTokens above. */
  tokens: { outline: 2000, draft: 4000, claims: 3000, counter: 1600, revise: 4000 },
  /* V0.1 publishes nothing by itself. This is the terminal state of the
     article workflow, and only a human moves an article out of it. */
  terminalStatus: 'awaiting_human_approval' as const,
  minSourcesToDraft: 1,
};
