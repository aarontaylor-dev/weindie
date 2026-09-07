import type { WriterAgent } from './writers/WriterAgent';

export interface Env {
  DB: D1Database;
  AI: Ai;
  WRITER: DurableObjectNamespace<WriterAgent>;
  ASSETS: Fetcher;

  RADAR: Workflow;
  READING: Workflow;
  ARTICLE: Workflow;

  AGENTS_ENABLED: string;
  ENVIRONMENT: string;
  AI_GATEWAY_ID: string;
  MONTHLY_BUDGET_USD: string;
  PER_AGENT_BUDGET_USD: string;
  DAILY_NEURON_BUDGET: string;
  DAILY_NEURON_PER_AGENT: string;
  EXTERNAL_PROVIDERS_ENABLED: string;
  SITE_ORIGIN: string;

  /* Secrets. Set with `wrangler secret put`; never in the repository, never
     sent to a browser, never logged. */
  ADMIN_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

export const agentsEnabled = (env: Env) => env.AGENTS_ENABLED === 'true';
