import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { WebError } from '@deepseek-ai/dsh-web';
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek';
import { ExaSearchProvider } from '@deepseek-ai/dsh-web-search-exa';
import { searchViaMcp } from './exa-mcp.js';

// One search provider whose engine the user picks, and which works before they
// pick anything.
//
// Every provider dsh-base mounts needs a vendor key, and PawWork ships OpenCode
// Free as its default model, so a first-run user holds none and their first
// `web_search` fails. Exa's hosted MCP answers unauthenticated requests against
// a shared allowance, which is the floor this plugin guarantees.
//
// A floor is not enough on its own: a shared allowance runs out, and the user
// then needs a way onto their own quota. `ctx.web` cannot offer that — it takes
// one provider id from static entry config, with no settings namespace behind
// it — so the choice has to live inside a single registered provider. This one.
//
// What it deliberately does NOT do is restate vendor request shapes. Both keyed
// backends are upstream provider classes, constructed per search from resolved
// options: `ExaSearchProvider` for Exa's official `/search`, and
// `DeepSeekSearchProvider` for DeepSeek's server-side native search. Only the
// anonymous path is ours, because no upstream package implements it.
//
// The upstream `web-search-deepseek` row is disabled in the product patch. Its
// card edits a provider this seam will never select, and two cards titled "web
// search" that disagree is worse than one that decides.

export const name = 'pawwork-web-search';
export const inject = ['web'];

/** Registry id this plugin registers under; `web.searchProvider` names it. */
export const PAWWORK_SEARCH_PROVIDER_ID = 'pawwork';

/** Settings namespace carrying the engine choice and each engine's credential reference. */
export const PAWWORK_WEB_SEARCH_SETTINGS_NAMESPACE = settingsNamespace('pawwork-web-search');

const DEFAULT_EXA_API_KEY_ENV = 'EXA_API_KEY';
const DEFAULT_DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY';

/**
 * How long one anonymous search may take before it is abandoned.
 *
 * A resource backstop for the one transport this plugin owns:
 * `dsh-tool-call-timeout-policy` owns the model-facing budget, and the upstream
 * provider classes carry their own.
 */
const ANONYMOUS_TIMEOUT_MS = 30_000;

/**
 * What to tell a user whom the shared allowance will no longer serve.
 *
 * Exa's own prose describes a quota the user has no relationship with and
 * cannot raise. The action that resolves it is entering their own key, so that
 * is what reaches the model — and through it, the user.
 */
const EXHAUSTED_MESSAGE =
  "PawWork's shared free search allowance is not serving this request. " +
  'Open Settings → Plugins → Web search and enter your own Exa API key, or ' +
  'switch the engine to DeepSeek and enter a DeepSeek key.';

export const Config = z.object({
  backend: z.union(['exa', 'deepseek']).default('exa'),
  exaApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_EXA_API_KEY_ENV),
  deepseekApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_DEEPSEEK_API_KEY_ENV),
});

/**
 * Resolve one credential reference through the authoritative plane.
 *
 * The credentials service is where the card writes and where the Models page
 * rotates, and it is resolved per search rather than held, so a key entered now
 * reaches the next search without a restart.
 * @param ctx - the plugin context supplying the credentials service.
 * @param ref - the reference the section names.
 * @returns the key, or an empty string when none is held.
 */
async function resolveKey(ctx, ref) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined) return '';
  const held = await credentials.resolve(credentialRef(ref));
  return held?.value !== undefined && held.value.length > 0 ? held.value : '';
}

/**
 * Search through Exa.
 *
 * With a key the call goes to Exa's official `/search`, which returns
 * structured results the upstream class maps. Without one it falls back to
 * Exa's hosted MCP and its shared allowance — the same vendor, a different
 * endpoint, and the only keyless search that exists.
 * @param ctx - the plugin context.
 * @param config - the authoritative section for this search.
 * @param request - the seam's search request.
 * @param signal - the caller's abort signal.
 * @returns the normalized search result.
 */
async function searchExa(ctx, config, request, signal) {
  const apiKey = await resolveKey(ctx, config.exaApiKeyEnv ?? DEFAULT_EXA_API_KEY_ENV);
  if (apiKey.length > 0) {
    return new ExaSearchProvider({
      apiKey,
      baseURL: 'https://api.exa.ai',
      searchType: 'auto',
      highlightsPerResult: 1,
    }).search(request, signal);
  }
  try {
    return await searchViaMcp({
      query: request.query,
      maxResults: request.maxResults,
      signal,
      timeoutMs: ANONYMOUS_TIMEOUT_MS,
    });
  } catch (error) {
    if (error?.code !== 'WEB_PROVIDER_CREDENTIAL_MISSING') throw error;
    throw new WebError(EXHAUSTED_MESSAGE, error.code, { cause: error });
  }
}

/**
 * Search through DeepSeek's server-side native search.
 *
 * The upstream class takes a thunk it calls per search, so the reference is
 * handed over rather than the resolved value — a key rotated in the card or the
 * Models page reaches the next search without re-registering anything.
 * @param ctx - the plugin context.
 * @param config - the authoritative section for this search.
 * @param request - the seam's search request.
 * @param signal - the caller's abort signal.
 * @returns the normalized search result.
 */
async function searchDeepSeek(ctx, config, request, signal) {
  const ref = config.deepseekApiKeyEnv ?? DEFAULT_DEEPSEEK_API_KEY_ENV;
  return new DeepSeekSearchProvider(() => ({
    resolveApiKey: async () => {
      const key = await resolveKey(ctx, ref);
      return key.length > 0 ? key : undefined;
    },
    apiKeyEnv: credentialRef(ref),
    baseURL: 'https://api.deepseek.com/anthropic/v1',
    model: 'deepseek-v4-flash',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
    recordRequest: (entry) => {
      ctx.get('agents')?.currentInitiator()?.session.append('web/deepseek-search-llm-request', entry);
    },
  })).search(request, signal);
}

/** The engine dispatch table; the section's `backend` selects one per search. */
const BACKENDS = {
  exa: searchExa,
  deepseek: searchDeepSeek,
};

/** A search provider that projects the current section onto one engine. */
export class PawWorkSearchProvider {
  id = PAWWORK_SEARCH_PROVIDER_ID;

  /**
   * @param ctx - the plugin context supplying the credentials and agent planes.
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
   * that makes no network call, and whether a key is held is neither — the
   * credentials seam answers asynchronously. The Exa engine needs no key at
   * all, so a default install is genuinely usable; a missing DeepSeek key
   * surfaces at search time as `WEB_PROVIDER_CREDENTIAL_MISSING`, which names
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
