import { z } from 'zod';

// Agent ID: lowercase alphanumeric + hyphens, must start with letter
export const AgentIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
export type AgentId = z.infer<typeof AgentIdSchema>;

// Model options
export const ModelSchema = z.enum([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);
export type Model = z.infer<typeof ModelSchema>;

// Budget constraints for an agent
export const BudgetSchema = z.object({
  max_turns: z.number().int().positive().default(300),
  max_usd: z.number().positive().default(3),
  max_minutes: z.number().int().positive().default(20),
});
export type Budget = z.infer<typeof BudgetSchema>;

// Env-var name policy: must look like a normal SHELL_VAR, AND must not start
// with any prefix associated with infrastructure secrets. Defends against a
// malicious YAML referencing AWS_SECRET_ACCESS_KEY / ANTHROPIC_API_KEY etc. and
// having the orchestrator type that value into a login form.
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const FORBIDDEN_ENV_PREFIXES = [
  'ANTHROPIC_',
  'OPENAI_',
  'OPENROUTER_',
  'COHERE_',
  'MISTRAL_',
  'AWS_',
  'GH_',
  'GITHUB_',
  'GOOGLE_',
  'GCP_',
  'AZURE_',
  'NPM_',
  'DOCKER_',
  'SLACK_',
  'LINEAR_',
  'STRIPE_',
] as const;

function validateCredentialEnvName(name: string, field: string): true | string {
  if (!ENV_VAR_NAME_RE.test(name)) {
    return `${field} '${name}' is not a valid env-var name (must match ${ENV_VAR_NAME_RE.source}).`;
  }
  for (const prefix of FORBIDDEN_ENV_PREFIXES) {
    if (name.startsWith(prefix)) {
      return `${field} '${name}' starts with the forbidden prefix '${prefix}' — refusing to forward an infrastructure secret to a login form. Use a portal-specific env var (e.g. STAGING_ADMIN_PASS).`;
    }
  }
  return true;
}

// Credentials (username/password env-var refs only; credentials never live in YAML)
export const CredentialsSchema = z
  .object({
    username_env: z.string().min(1),
    password_env: z.string().min(1),
  })
  .superRefine((c, ctx) => {
    const u = validateCredentialEnvName(c.username_env, 'credentials.username_env');
    if (u !== true) ctx.addIssue({ code: 'custom', message: u, path: ['username_env'] });
    const p = validateCredentialEnvName(c.password_env, 'credentials.password_env');
    if (p !== true) ctx.addIssue({ code: 'custom', message: p, path: ['password_env'] });
  });
export type Credentials = z.infer<typeof CredentialsSchema>;

// Per-agent configuration
export const AgentConfigSchema = z.object({
  id: AgentIdSchema,
  // Profile slug (e.g. "power-user") or path to custom .md file within cwd
  profile: z.string().min(1),
  // Required when target.auth.type === 'form'; ignored when 'none'
  credentials: CredentialsSchema.optional(),
  // Optional: override default model
  model: ModelSchema.optional(),
  // Optional: cap extended-thinking tokens. 0 = no thinking (max speed). The
  // Anthropic API requires a minimum budget of 1024 when thinking IS enabled,
  // so values in (0, 1024) are rejected. Sonnet personas typically want
  // 1500-3000 for multi-step coherence; Haiku at 1024 is a reasonable floor
  // that mitigates tunneling without much speed cost.
  max_thinking_tokens: z
    .number()
    .int()
    .min(0)
    .max(20000)
    .refine((n) => n === 0 || n >= 1024, {
      message:
        'max_thinking_tokens must be 0 (disabled) or at least 1024 (Anthropic API minimum when thinking is enabled).',
    })
    .optional(),
  // Optional: model to use for high-level planning between chunks. When set,
  // a brief "what should the agent do next" call is made at the start of each
  // chunk using this (typically smarter, slower) model; the cheap executor
  // model then follows the plan. When omitted, the agent's main model handles
  // both — single-model mode is faster per chunk but less directed.
  planner_model: ModelSchema.optional(),
  // Optional: partial budget override
  budget: BudgetSchema.partial().optional(),
  // Optional: override profile's personality text inline. The persona IS the
  // goal — there is no separate workflow/task to override.
  override_personality: z.string().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// Authentication configuration for the target portal
const DEFAULT_USERNAME_SELECTOR =
  'input[type="email"], input[name="username"], input[name="email"], input[id*="user" i], input[autocomplete="username"]';
const DEFAULT_PASSWORD_SELECTOR = 'input[type="password"]';
const DEFAULT_SUBMIT_SELECTOR =
  'button[type="submit"], input[type="submit"], button:has-text("Sign in")';

export const AuthConfigSchema = z
  .object({
    // 'form' = orchestrator pre-logs-in via Playwright before handing off to the agent.
    // 'none' = no pre-login (public site, or caller supplies a pre-built storage_state_path).
    type: z.enum(['form', 'none']).default('form'),
    // Defaults to target.url when omitted
    login_url: z.string().url().optional(),
    // CSS selectors — comma-separated lists allowed; first visible match wins
    username_selector: z.string().default(DEFAULT_USERNAME_SELECTOR),
    password_selector: z.string().default(DEFAULT_PASSWORD_SELECTOR),
    submit_selector: z.string().default(DEFAULT_SUBMIT_SELECTOR),
    // Optional regex applied to page.url() after submit to confirm success
    success_url_pattern: z.string().optional(),
    // Optional selector to wait for after submit (visible = success)
    wait_for_selector: z.string().optional(),
    // Pre-built storage state file (only used with type='none' — e.g. for SSO portals)
    storage_state_path: z.string().optional(),
  })
  .default({
    type: 'form',
    username_selector: DEFAULT_USERNAME_SELECTOR,
    password_selector: DEFAULT_PASSWORD_SELECTOR,
    submit_selector: DEFAULT_SUBMIT_SELECTOR,
  });
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

// Target portal configuration
export const TargetConfigSchema = z
  .object({
    url: z.string().url(),
    // Allowed hosts agents can navigate to (prevents drift; wired to Playwright MCP --allowed-origins)
    allowed_hosts: z.array(z.string().min(1)).min(1),
    auth: AuthConfigSchema,
  })
  .superRefine((t, ctx) => {
    // target.url's host must be in allowed_hosts.
    let urlHost: string | null = null;
    try {
      urlHost = new URL(t.url).host;
    } catch {
      ctx.addIssue({ code: 'custom', message: `target.url is not a valid URL`, path: ['url'] });
      return;
    }
    if (!t.allowed_hosts.includes(urlHost)) {
      ctx.addIssue({
        code: 'custom',
        message: `target.url host '${urlHost}' must appear in target.allowed_hosts`,
        path: ['url'],
      });
    }
    // auth.login_url's host must also be in allowed_hosts — defends against a
    // malicious YAML pointing the pre-login browser at attacker.example.
    if (t.auth.login_url) {
      let loginHost: string;
      try {
        loginHost = new URL(t.auth.login_url).host;
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: `target.auth.login_url is not a valid URL`,
          path: ['auth', 'login_url'],
        });
        return;
      }
      if (!t.allowed_hosts.includes(loginHost)) {
        ctx.addIssue({
          code: 'custom',
          message: `target.auth.login_url host '${loginHost}' must appear in target.allowed_hosts`,
          path: ['auth', 'login_url'],
        });
      }
    }
  });
export type TargetConfig = z.infer<typeof TargetConfigSchema>;

// Anthropic API configuration
export const AnthropicConfigSchema = z.object({
  // Environment variable name containing the API key. Optional: when omitted (or
  // when the referenced env var is unset), the agent SDK subprocess falls back
  // to whatever auth `claude` CLI has cached — i.e. Pro/Max subscription. That
  // makes interactive dev runs effectively free; CI runs that set the env var
  // bill against the API as before.
  api_key_env: z.string().min(1).optional(),
  // Default model for agents
  default_model: ModelSchema.default('claude-sonnet-4-6'),
  // OPT-IN. When true AND the api key is set, the agent loop uses the direct
  // Anthropic SDK path (faster: bypasses the Claude Code subprocess). When
  // false or the api key is missing, falls back to the Claude Code SDK path
  // (which supports subscription auth). Default: false.
  direct_api: z.boolean().default(false),
});
export type AnthropicConfig = z.infer<typeof AnthropicConfigSchema>;

// Run-level (global) configuration
export const RunConfigSchema = z
  .object({
    // Total budget across all agents in USD
    max_budget_usd: z.number().positive().default(20),
    // Directory where run outputs are written — MUST resolve within cwd
    output_dir: z.string().default('./runs'),
  })
  .default({ max_budget_usd: 20, output_dir: './runs' });
export type RunConfig = z.infer<typeof RunConfigSchema>;

// Supervisor (the "grown-up") configuration. A 6th concurrent agent that
// watches the explorers via the runtime registry and intervenes when they
// get stuck — re-logs the shared session, nudges agents with new prompts.
// Requires anthropic.api_key_env set (uses the direct Anthropic SDK, not
// the Claude Code subprocess path).
export const SupervisorConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    model: ModelSchema.default('claude-sonnet-4-6'),
    // Wall-clock cap. Should be ≥ the longest explorer agent's max_minutes
    // so the supervisor stays alive while explorers run.
    max_minutes: z.number().int().positive().default(10),
    max_usd: z.number().positive().default(0.5),
    max_turns: z.number().int().positive().default(60),
  })
  .default({
    enabled: true,
    model: 'claude-sonnet-4-6',
    max_minutes: 10,
    max_usd: 0.5,
    max_turns: 60,
  });
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;

// Post-run reviewer. After all explorer agents finish, a critic LLM re-reads
// the persisted findings + journey metadata and writes review.md / review.json
// into the run dir. Best-effort: never fails the run. Requires
// ANTHROPIC_API_KEY in env (uses the direct Anthropic SDK).
export const ReviewConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    model: ModelSchema.default('claude-sonnet-4-6'),
  })
  .default({ enabled: true, model: 'claude-sonnet-4-6' });
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

// Top-level configuration schema
export const ConfigSchema = z
  .object({
    target: TargetConfigSchema,
    anthropic: AnthropicConfigSchema,
    run: RunConfigSchema,
    supervisor: SupervisorConfigSchema,
    review: ReviewConfigSchema,
    agents: z
      .array(AgentConfigSchema)
      .min(1)
      .refine((arr) => new Set(arr.map((a) => a.id)).size === arr.length, {
        message: 'agent ids must be unique',
      }),
  })
  .refine(
    (cfg) =>
      cfg.target.auth.type !== 'form' || cfg.agents.every((a) => a.credentials !== undefined),
    {
      message:
        "target.auth.type is 'form' — every agent must declare credentials (username_env + password_env).",
    },
  );
export type Config = z.infer<typeof ConfigSchema>;
