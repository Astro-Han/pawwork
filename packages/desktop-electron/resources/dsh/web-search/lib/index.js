import z from '@deepseek-ai/schemastery';
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { WebError } from '@deepseek-ai/dsh-web';
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek';
import { ExaSearchProvider } from '@deepseek-ai/dsh-web-search-exa';
import { searchViaMcp } from './exa-mcp.js';

// One search provider whose engine the user picks, and which works before they
// pick anything.
//
// Both engines have to live inside one registered provider: `ctx.web` selects a
// single provider id from static entry config, with no settings namespace behind
// it, so a user-visible choice cannot be expressed as two entries. The upstream
// `web-search-deepseek` row is disabled in the product patch for the same
// reason — its card would edit a provider this seam never selects.

export const name = 'pawwork-web-search';
export const inject = ['web'];

/** Registry id this plugin registers under; `web.searchProvider` names it. */
export const PAWWORK_SEARCH_PROVIDER_ID = 'pawwork';

/** Settings namespace carrying the engine choice and each engine's credential reference. */
export const PAWWORK_WEB_SEARCH_SETTINGS_NAMESPACE = settingsNamespace('pawwork-web-search');

const DEFAULT_EXA_API_KEY_ENV = 'EXA_API_KEY';
const DEFAULT_DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY';

/**
 * Read a configured credential reference, falling back when it names nothing
 * this deployment could resolve.
 *
 * The settings file is hand-editable and `credentialRef` answers a name outside
 * its grammar with a bare `TypeError`, which would take down even the keyless
 * path. The card applies the same predicate.
 * @param declared - the reference named in the section, if any.
 * @param fallback - the reference to use when none is usable.
 * @returns the reference to resolve.
 */
function resolveRef(declared, fallback) {
  const named = declared?.trim() ?? '';
  return isCredentialRefName(named) ? named : fallback;
}

/**
 * What to tell a user who selected DeepSeek and holds no DeepSeek key.
 *
 * The upstream class names its own entry's `apiKey` config as the remedy, and
 * this product disables that entry — so its advice sends the user to a row that
 * is not mounted. The card is where the key actually goes.
 */
const DEEPSEEK_KEY_MESSAGE =
  'The DeepSeek search engine needs a DeepSeek API key. ' +
  'Open Settings → Plugins → Web search to enter one, ' +
  'or switch the engine to Exa, which searches without a key.';

export const Config = z.object({
  backend: z.union(['exa', 'deepseek']).default('exa'),
  exaApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_EXA_API_KEY_ENV),
  deepseekApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_DEEPSEEK_API_KEY_ENV),
});

/**
 * Resolve one credential reference through the authoritative plane.
 *
 * Resolved per search rather than held, so a key entered in the card or rotated
 * on the Models page reaches the next search without a restart.
 * @param ctx - the plugin context supplying the credentials service.
 * @param ref - the reference the section names.
 * @returns the key, or an empty string when none is held.
 */
async function resolveKey(ctx, ref) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined) return '';
  let held;
  try {
    held = await credentials.resolve(credentialRef(ref));
  } catch (cause) {
    // A locked keychain is a failure the seam can report; letting it escape as
    // whatever the credentials plane threw would leave the tool with an error
    // it has no vocabulary for.
    throw new WebError(`could not resolve the search credential "${ref}"`, 'WEB_PROVIDER_ERROR', { cause });
  }
  // Trimmed because a held value decides which path runs at all: a trailing
  // newline from an editor or a shell export would otherwise count as a key and
  // send the search to a vendor endpoint that rejects it, instead of to the
  // keyless allowance that would have answered.
  return held?.value?.trim() ?? '';
}

/**
 * Search through Exa.
 *
 * With a key the call goes to Exa's official `/search`, which returns structured
 * results. Without one it falls back to Exa's hosted MCP, which answers in
 * prose, so the keyless result carries the report as content and no sources.
 * @param ctx - the plugin context.
 * @param config - the authoritative section for this search.
 * @param request - the seam's search request.
 * @param signal - the caller's abort signal.
 * @returns the normalized search result.
 */
async function searchExa(ctx, config, request, signal) {
  const apiKey = await resolveKey(ctx, resolveRef(config.exaApiKeyEnv, DEFAULT_EXA_API_KEY_ENV));
  if (apiKey.length > 0) {
    return new ExaSearchProvider({
      apiKey,
      baseURL: 'https://api.exa.ai',
      searchType: 'auto',
      highlightsPerResult: 1,
    }).search(request, signal);
  }
  // No deadline of this plugin's own: `dsh-tool-web` owns the search budget as
  // deployment policy and forwards the resulting signal.
  return searchViaMcp({ query: request.query, maxResults: request.maxResults, signal });
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
  const ref = resolveRef(config.deepseekApiKeyEnv, DEFAULT_DEEPSEEK_API_KEY_ENV);
  const provider = new DeepSeekSearchProvider(() => ({
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
  }));
  try {
    return await provider.search(request, signal);
  } catch (error) {
    if (error?.code !== 'WEB_PROVIDER_CREDENTIAL_MISSING') throw error;
    throw new WebError(DEEPSEEK_KEY_MESSAGE, error.code, { cause: error });
  }
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
   * `available()` must be a cheap local check that makes no network call, and
   * whether a key is held is neither — the credentials seam answers
   * asynchronously. So it cannot consult one.
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
    return BACKENDS[config.backend](this.ctx, config, request, signal);
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
