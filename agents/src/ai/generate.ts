/* The only place in this codebase that talks to a model.
 *
 *   generate(env, { agentId, task, modelClass, system, messages })
 *
 * Callers name a *job*, not a model or a provider. That indirection is the
 * point: today every class resolves to Workers AI, and swapping a writer onto a
 * frontier model later is a config change rather than a rewrite.
 *
 * Three things happen around every call, without the caller asking:
 *   - the monthly budget is checked, and the call is refused if it is spent
 *   - the request is tagged for AI Gateway with agent_id / task_type / environment
 *   - the result is written to usage_events, success or failure
 */

import type { Env } from '../env';
import { BUDGET, MODELS, DEFAULT_WRITER_MODEL, type ModelClass } from '../config';
import type { Task } from '../writers/identities';
import { IDENTITIES } from '../writers/identities';
import { isWriterId } from '../config';
import { uid, nowIso, month, today } from '../util';

export class BudgetExceeded extends Error {
  constructor(
    readonly scope: 'global' | 'agent' | 'daily' | 'daily-agent',
    readonly spent: number,
    readonly ceiling: number,
    readonly unit: 'usd' | 'neurons' = 'usd',
  ) {
    super(unit === 'neurons'
      ? `budget exceeded (${scope}): ${Math.round(spent)} of ${ceiling} neurons today`
      : `budget exceeded (${scope}): $${spent.toFixed(4)} of $${ceiling.toFixed(2)}`);
  }
}

export interface GenerateOptions {
  agentId: string;                 // mara | ... | radar | editor
  task: Task | string;
  modelClass: ModelClass;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  temperature?: number;
  workflowId?: string;
  /* Try a specific model instead of the one the class resolves to. Only the
     test harness passes this; the workflows always go through the class. */
  modelOverride?: string;
  /* Ask for JSON. Adds an instruction and parses leniently; it does not rely on
     a provider-specific structured-output feature, because not every provider
     we might move to has one. */
  json?: boolean;
}

export interface GenerateResult {
  text: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costEstimated: boolean;
  durationMs: number;
}

/* Workers AI reports `neurons` in its usage block, which converts exactly to
   dollars. When a response omits it we fall back to this rough rate so a cost
   still gets recorded — every such row is marked estimated, and /status says so. */
const FALLBACK_NEURONS_PER_1K_TOKENS = 25;

/* Workers AI does not have one response shape. Depending on the model you get
 * `{response: "..."}`, `{response: {...}}` (already parsed), or no `response` at
 * all and an OpenAI-style `choices[0].message.content`. Only the last is present
 * in every case, so it is tried first. Getting this wrong is silent: the caller
 * receives "[object Object]", fails to parse it, and a working model looks like
 * a writer with nothing to say.
 *
 * `message.reasoning_content` is deliberately never read. Several of these
 * models return a reasoning trace, and this system does not store or display
 * one — the public "thinking" on a writer's page is written state, not a
 * leaked interior.
 */
function extractText(res: any): string {
  if (typeof res === 'string') return res;
  const content = res?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  const r = res?.response;
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') return JSON.stringify(r);
  return '';
}

/* Some models emit their scratch work in <think> blocks ahead of the answer. */
const stripThinking = (s: string) =>
  s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();

/* A model that is not on this account's plan will never succeed. Retrying it
   durably, every few seconds, for an hour, is worse than failing. */
export const isPermanentModelError = (msg: string) =>
  /not available on the Workers|No route for that URI|not found|unauthorized/i.test(msg);

function resolveModel(cls: ModelClass, agentId: string): string {
  if (cls !== 'writer') return MODELS[cls];
  if (isWriterId(agentId)) return IDENTITIES[agentId].model;
  return DEFAULT_WRITER_MODEL;
}

/* ------------------------------------------------------------------ budget */

/* Workers AI on the Free plan allows 10,000 neurons a calendar day, and that
   is the ceiling that actually binds: a whole day of six writers reading costs
   roughly a penny, so the monthly dollar cap will never fire. Counting dollars
   and not neurons meant the system watched the wrong wall and walked into the
   other one — one writer on a reasoning-heavy model spent half a day's
   allowance in nine calls while the dollar ceiling read 0.4% used. */
export async function neuronsToday(env: Env, agentId?: string) {
  const d = today();
  const row = agentId
    ? await env.DB.prepare(
        `SELECT COALESCE(SUM(neurons),0) AS n FROM usage_events WHERE day = ? AND agent_id = ?`,
      ).bind(d, agentId).first<{ n: number }>()
    : await env.DB.prepare(
        `SELECT COALESCE(SUM(neurons),0) AS n FROM usage_events WHERE day = ?`,
      ).bind(d).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function spendThisMonth(env: Env, agentId?: string) {
  const m = month();
  const row = agentId
    ? await env.DB.prepare(
        `SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage_events WHERE month = ? AND agent_id = ?`,
      ).bind(m, agentId).first<{ s: number }>()
    : await env.DB.prepare(
        `SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage_events WHERE month = ?`,
      ).bind(m).first<{ s: number }>();
  return row?.s ?? 0;
}

async function assertWithinBudget(env: Env, agentId: string) {
  /* Daily neurons first: on the current plan this is the wall you actually hit,
     and checking it first means the error a caller sees names the real cause. */
  const dailyCeiling = Number(env.DAILY_NEURON_BUDGET || '9000');
  const dailyAgentCeiling = Number(env.DAILY_NEURON_PER_AGENT || '2500');

  const dayTotal = await neuronsToday(env);
  if (dayTotal >= dailyCeiling) throw new BudgetExceeded('daily', dayTotal, dailyCeiling, 'neurons');

  const dayMine = await neuronsToday(env, agentId);
  if (dayMine >= dailyAgentCeiling) {
    throw new BudgetExceeded('daily-agent', dayMine, dailyAgentCeiling, 'neurons');
  }

  const globalCeiling = Number(env.MONTHLY_BUDGET_USD || '30');
  const agentCeiling = Number(env.PER_AGENT_BUDGET_USD || '4');

  const total = await spendThisMonth(env);
  if (total >= globalCeiling) throw new BudgetExceeded('global', total, globalCeiling);

  const mine = await spendThisMonth(env, agentId);
  if (mine >= agentCeiling) throw new BudgetExceeded('agent', mine, agentCeiling);
}

/* ----------------------------------------------------------------- the call */

export async function generate(env: Env, o: GenerateOptions): Promise<GenerateResult> {
  const model = o.modelOverride || resolveModel(o.modelClass, o.agentId);
  const provider = 'workers-ai';
  const started = Date.now();

  await assertWithinBudget(env, o.agentId);

  const system = o.json
    ? `${o.system}\n\nRespond with one JSON object and nothing else. No prose before or after it, no code fence.`
    : o.system;

  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let neurons = 0;
  let ok = true;
  let error: string | null = null;

  try {
    const res: any = await env.AI.run(
      model as any,
      {
        messages: [{ role: 'system', content: system }, ...o.messages],
        max_tokens: o.maxTokens ?? 900,
        temperature: o.temperature ?? 0.7,
      } as any,
      {
        /* Metadata is what makes the AI Gateway per-agent spend rule work, and
           what makes the logs readable six months from now. */
        gateway: {
          id: env.AI_GATEWAY_ID,
          metadata: {
            agent_id: o.agentId,
            task_type: String(o.task),
            environment: env.ENVIRONMENT,
          },
        },
      } as any,
    );

    text = extractText(res);
    const u = res?.usage ?? {};
    inputTokens = Number(u.prompt_tokens ?? 0);
    outputTokens = Number(u.completion_tokens ?? 0);
    neurons = Number(u.neurons ?? 0);
  } catch (e: any) {
    ok = false;
    error = String(e?.message ?? e).slice(0, 500);
  }

  const costEstimated = neurons === 0;
  if (costEstimated) {
    neurons = ((inputTokens + outputTokens) / 1000) * FALLBACK_NEURONS_PER_1K_TOKENS;
  }
  const costUsd = BUDGET.neuronsToUsd(neurons);
  const durationMs = Date.now() - started;

  /* Recorded whether or not the call worked. A failed call still cost time, and
     a run of failures is the thing you most want to see on /status. */
  await env.DB.prepare(
    `INSERT INTO usage_events
       (id, created_at, day, month, agent_id, task_type, model_class, provider, model,
        input_tokens, output_tokens, neurons, cost_usd, duration_ms, ok, retried, error, workflow_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
  ).bind(
    uid('use'), nowIso(), today(), month(), o.agentId, String(o.task), o.modelClass, provider, model,
    inputTokens, outputTokens, neurons, costUsd, durationMs, ok ? 1 : 0, error, o.workflowId ?? null,
  ).run();

  if (!ok) throw new Error(`generate failed (${model}): ${error}`);

  return { text: stripThinking(text), model, provider, inputTokens, outputTokens, costUsd, costEstimated, durationMs };
}

/* For long prose, ask for delimited plain text rather than JSON.
 *
 * A 400-word essay inside a JSON string field has to survive the model escaping
 * every newline and quotation mark in it, and at that length they frequently do
 * not. Three of six writers failed this way on the first run of the drafting
 * test — not because they had nothing to say, but because the envelope broke.
 * Short structured replies stay JSON; anything carrying an essay uses this.
 */
export function parseFields(text: string, fields: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  let rest = text.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  for (const f of fields) {
    const re = new RegExp('^\\s*' + f + '\\s*:\\s*(.*)$', 'im');
    const m = re.exec(rest);
    if (m) {
      out[f.toLowerCase()] = m[1].trim();
      rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length);
    }
  }
  const body = rest.replace(/^\s*-{3,}\s*$/m, '').trim();
  if (!body) return null;
  out.body = body;
  return out;
}

/* Models emit JSON with apologies, fences and trailing commentary. Rather than
   trusting a provider flag, find the object and parse it.

   A caller that gets null must not treat it as "the writer had nothing to say".
   Those are different events, and conflating them would corrupt the one number
   this project actually cares about — how often a writer genuinely decides that
   nothing is worth retaining. An unreadable reply is recorded as an error. */
export function parseJson<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  if (start === -1) return null;

  const end = candidate.lastIndexOf('}');
  if (end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)) as T; } catch { /* fall through */ }
  }

  /* Reasoning models spend tokens thinking and sometimes run out mid-object.
     A truncated reply usually still contains the fields that matter, so close
     the open brackets and try once more rather than discarding it. */
  const body = candidate.slice(start);
  const stack: string[] = [];
  let inString = false, escaped = false, lastSafe = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') { inString = false; lastSafe = i; }
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') { stack.pop(); lastSafe = i; }
    else if (c === ',' || /\s/.test(c)) lastSafe = Math.max(lastSafe, i - 1);
  }
  if (lastSafe < 0 || !stack.length) return null;
  const repaired = body.slice(0, lastSafe + 1).replace(/,\s*$/, '') +
    stack.reverse().join('');
  try { return JSON.parse(repaired) as T; } catch { return null; }
}
