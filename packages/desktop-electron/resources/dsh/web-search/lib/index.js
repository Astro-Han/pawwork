import { createRequire } from 'node:module';
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { WebError } from '@deepseek-ai/dsh-web';
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek';
import { ExaSearchProvider } from '@deepseek-ai/dsh-web-search-exa';
import { PerplexitySearchProvider } from '@deepseek-ai/dsh-web-search-perplexity';

const require = createRequire(import.meta.url);
const { ExaMcpError, searchViaMcp } = require('./exa-mcp.cjs');

// One search provider whose backend the user picks, rather than one mounted
// provider per vendor.
//
// `ctx.web` resolves `searchProvider` once at construction and exposes no
// settings namespace of its own, so a mounted-per-vendor arrangement can only be
// re-pointed by editing the profile and restarting. Registering a single id and
// switching inside it moves that choice into settings, where it takes effect on
// the next search — and keeps the seam unambiguous, since exactly one provider
// is ever registered.
//
// Vendor request shapes are not reimplemented here: each upstream provider class
// is constructed per search from resolved options. What this plugin owns is the
// choice between them, credential resolution across the credentials seam (which
// the Exa and Perplexity packages do not consult), and the anonymous Exa path
// that has no upstream implementation.

export const name = 'pawwork-web-search';
export const inject = ['web'];

/** Registry id this plugin registers under; `web.searchProvider` names it. */
export const PAWWORK_SEARCH_PROVIDER_ID = 'pawwork';

/** Settings namespace carrying the backend choice and each vendor's endpoint. */
export const PAWWORK_WEB_SEARCH_SETTINGS_NAMESPACE = settingsNamespace('pawwork-web-search');

const DEFAULT_EXA_API_KEY_ENV = 'EXA_API_KEY';
const DEFAULT_PERPLEXITY_API_KEY_ENV = 'PERPLEXITY_API_KEY';
const DEFAULT_DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY';

/**
 * How long one anonymous Exa call may take before it is abandoned.
 *
 * A resource backstop only: `dsh-tool-call-timeout-policy` owns the model-facing
 * budget, and the upstream vendor classes carry their own.
 */
const DEFAULT_EXA_MCP_TIMEOUT_MS = 30_000;

export const Config = z.object({
  backend: z.union(['exa', 'deepseek', 'perplexity']).default('exa'),
  exaApiKey: z.string().role('secret'),
  exaApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_EXA_API_KEY_ENV),
  exaBaseURL: z.string(),
  exaTimeoutMs: z.number().step(1).min(1).default(DEFAULT_EXA_MCP_TIMEOUT_MS),
  perplexityApiKey: z.string().role('secret'),
  perplexityApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_PERPLEXITY_API_KEY_ENV),
  perplexityBaseURL: z.string(),
  perplexityModel: z.string(),
  deepseekApiKey: z.string().role('secret'),
  deepseekApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_DEEPSEEK_API_KEY_ENV),
  deepseekBaseURL: z.string(),
  deepseekModel: z.string(),
});

/**
 * Resolve one credential reference through the authoritative plane.
 *
 * The credentials service wins when mounted, because that is where the settings
 * card and the Models page both store keys; the launch environment is the
 * fallback for deployments without it, matching what every upstream provider
 * does on its own.
 * @param ctx - the plugin context supplying both planes.
 * @param ref - the reference the section names.
 * @returns the key, or an empty string when none is held.
 */
async function resolveKey(ctx, ref) {
  const reference = credentialRef(ref);
  const credentials = ctx.get('credentials');
  if (credentials !== undefined) {
    const held = await credentials.resolve(reference);
    if (held?.value !== undefined && held.value.length > 0) return held.value;
    return '';
  }
  return launchEnvironmentOf(ctx).get(reference)?.value ?? '';
}

/**
 * Translate this module's transport failures into the seam's vocabulary.
 * @param error - the failure raised while searching.
 * @returns never; always throws.
 * @throws {WebError} the seam-coded equivalent, or the original error.
 */
function rethrowAsWebError(error) {
  if (error instanceof ExaMcpError) throw new WebError(error.message, error.code, { cause: error });
  throw error;
}

/**
 * Search through Exa.
 *
 * A saved or ambient key routes to Exa's official `/search`; without one the
 * call falls back to Exa's hosted MCP, whose free allowance is what lets a
 * first-run user search before configuring anything. The fallback is silent by
 * design — the user asked for "Exa", not for a particular endpoint — and the
 * settings card is where the distinction is explained.
 * @param ctx - the plugin context.
 * @param config - the authoritative section for this search.
 * @param request - the seam's search request.
 * @param signal - the caller's abort signal.
 * @returns the normalized search result.
 */
async function searchExa(ctx, config, request, signal) {
  const apiKey = config.exaApiKey !== undefined && config.exaApiKey.length > 0
    ? config.exaApiKey
    : await resolveKey(ctx, config.exaApiKeyEnv ?? DEFAULT_EXA_API_KEY_ENV);
  if (apiKey.length === 0) {
    return searchViaMcp({
      query: request.query,
      maxResults: request.maxResults,
      signal,
      timeoutMs: config.exaTimeoutMs ?? DEFAULT_EXA_MCP_TIMEOUT_MS,
    }).catch(rethrowAsWebError);
  }
  return new ExaSearchProvider({
    apiKey,
    baseURL: config.exaBaseURL ?? 'https://api.exa.ai',
    searchType: 'auto',
    highlightsPerResult: 1,
  }).search(request, signal);
}

/**
 * Search through Perplexity.
 * @param ctx - the plugin context.
 * @param config - the authoritative section for this search.
 * @param request - the seam's search request.
 * @param signal - the caller's abort signal.
 * @returns the normalized search result.
 * @throws {WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when no key is held.
 */
async function searchPerplexity(ctx, config, request, signal) {
  const apiKey = config.perplexityApiKey !== undefined && config.perplexityApiKey.length > 0
    ? config.perplexityApiKey
    : await resolveKey(ctx, config.perplexityApiKeyEnv ?? DEFAULT_PERPLEXITY_API_KEY_ENV);
  if (apiKey.length === 0) {
    throw new WebError(
      'Perplexity search needs an API key; none is configured',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    );
  }
  return new PerplexitySearchProvider({
    apiKey,
    baseURL: config.perplexityBaseURL ?? 'https://api.perplexity.ai',
    model: config.perplexityModel ?? 'sonar',
    maxTokens: 1024,
  }).search(request, signal);
}

/**
 * Search through DeepSeek.
 *
 * The upstream class resolves its key through a thunk it calls per search, so
 * the reference is handed over rather than the literal — a key rotated in the
 * Models page reaches the next search without a restart.
 * @param ctx - the plugin context.
 * @param config - the authoritative section for this search.
 * @param request - the seam's search request.
 * @param signal - the caller's abort signal.
 * @returns the normalized search result.
 */
async function searchDeepSeek(ctx, config, request, signal) {
  const ref = config.deepseekApiKeyEnv ?? DEFAULT_DEEPSEEK_API_KEY_ENV;
  const literal = config.deepseekApiKey !== undefined && config.deepseekApiKey.length > 0
    ? config.deepseekApiKey
    : undefined;
  return new DeepSeekSearchProvider(() => ({
    ...(literal === undefined ? {} : { apiKey: literal }),
    resolveApiKey: async () => {
      const key = await resolveKey(ctx, ref);
      return key.length > 0 ? key : undefined;
    },
    apiKeyEnv: credentialRef(ref),
    baseURL: config.deepseekBaseURL ?? 'https://api.deepseek.com/anthropic/v1',
    model: config.deepseekModel ?? 'deepseek-v4-flash',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
    recordRequest: (entry) => {
      ctx.get('agents')?.currentInitiator()?.session.append('web/deepseek-search-llm-request', entry);
    },
  })).search(request, signal);
}

/** The backend dispatch table; the section's `backend` selects one per search. */
const BACKENDS = {
  exa: searchExa,
  deepseek: searchDeepSeek,
  perplexity: searchPerplexity,
};

/** A search provider that projects the current section onto a vendor backend. */
export class PawWorkSearchProvider {
  id = PAWWORK_SEARCH_PROVIDER_ID;

  /**
   * @param ctx - the plugin context supplying the credential and agent planes.
   * @param current - reads the authoritative section; called per search so a
   *   settings change reaches the next call without re-registering.
   */
  constructor(ctx, current) {
    this.ctx = ctx;
    this.current = current;
  }

  /**
   * Whether this provider can be selected.
   *
   * Always true, and deliberately so: `available()` must be a cheap local check
   * that makes no network call, and whether a vendor key is held is neither —
   * the credentials seam answers asynchronously. Exa needs no key at all, so a
   * default install is genuinely usable; a missing key for the other two
   * surfaces as `WEB_PROVIDER_CREDENTIAL_MISSING` at search time, which names
   * the real problem rather than reporting the provider as absent.
   * @returns true.
   */
  available() {
    return true;
  }

  /**
   * @param request - the seam's search request.
   * @param signal - the caller's abort signal.
   * @returns the normalized search result.
   */
  async search(request, signal) {
    const config = this.current();
    const backend = BACKENDS[config.backend ?? 'exa'] ?? searchExa;
    return backend(this.ctx, config, request, signal);
  }
}

/**
 * Register the PawWork search provider with `ctx.web`.
 * @param ctx - the plugin context.
 * @param config - the composed entry configuration.
 */
export function apply(ctx, config) {
  let current = () => config;
  installSettingsSection(ctx, PAWWORK_WEB_SEARCH_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
  });
  ctx.web.registerSearchProvider(new PawWorkSearchProvider(ctx, () => current()));
}
