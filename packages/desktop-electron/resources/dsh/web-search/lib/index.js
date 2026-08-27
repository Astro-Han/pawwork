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

/** The names a credential reference may take; anything else cannot be resolved. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Read a configured credential reference, falling back when it names nothing
 * this deployment could resolve.
 *
 * A settings file is hand-editable, and `credentialRef` answers a name outside
 * its grammar with a bare `TypeError` — not a config error the seam can report
 * but an unhandled throw, taking down even the Exa path that needs no key at
 * all. A name nobody can resolve is a name nobody set, so it reads as the
 * default: blank, padded, `my-key`, `1KEY` alike. The card resolves the same
 * field the same way; the two disagreeing would have it call a key configured
 * that no search would ever find.
 * @param declared - the reference named in the section, if any.
 * @param fallback - the reference to use when none is usable.
 * @returns the reference to resolve.
 */
function resolveRef(declared, fallback) {
  const named = declared?.trim() ?? '';
  return CREDENTIAL_REF.test(named) ? named : fallback;
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
  // Trimmed because a held value decides which path runs at all: a trailing
  // newline from an editor or a shell export would otherwise count as a key and
  // send the search to a vendor endpoint that rejects it, instead of to the
  // keyless allowance that would have answered.
  return held?.value?.trim() ?? '';
}

/**
 * Search through Exa.
 *
 * With a key the call goes to Exa's official `/search`, which returns
 * structured results the upstream class maps into attributed sources. Without
 * one it falls back to Exa's hosted MCP and its shared allowance — the same
 * vendor, a different endpoint, and the only keyless search that exists. That
 * endpoint answers in prose rather than structure, so the keyless result
 * carries the report as content and no sources; see `exa-mcp.js`.
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
  // deployment policy and forwards the resulting signal, and the profile sets it
  // to 60s. A second deadline here was half that, so it silently overrode the
  // deployment for the one path it covered.
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
    // No fallback: `Config` resolves `backend` as a defaulted union, so the
    // section can only name an engine this table has.
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
