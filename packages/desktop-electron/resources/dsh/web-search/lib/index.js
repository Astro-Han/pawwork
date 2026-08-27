import { createRequire } from 'node:module';
import { WebError } from '@deepseek-ai/dsh-web';

const require = createRequire(import.meta.url);
const { ExaMcpError, searchViaMcp } = require('./exa-mcp.cjs');

// Search that works before anyone configures a key.
//
// Every provider dsh-base mounts needs a vendor key, and PawWork ships OpenCode
// Free as its default model, so a first-run user holds none of them and their
// first `web_search` fails. This registers one more provider — Exa's hosted MCP
// on its anonymous allowance — and the product overlay points `searchProvider`
// at it. The keyed providers stay mounted and unchanged behind their own
// settings cards; choosing between them is a separate concern this plugin does
// not take on.

export const name = 'pawwork-web-search';
export const inject = ['web'];

/** Registry id this plugin registers under; `web.searchProvider` names it. */
export const PAWWORK_SEARCH_PROVIDER_ID = 'pawwork';

/**
 * How long one search may take before it is abandoned.
 *
 * A resource backstop only: `dsh-tool-call-timeout-policy` owns the
 * model-facing budget.
 */
const SEARCH_TIMEOUT_MS = 30_000;

/** A search provider backed by Exa's anonymous hosted MCP. */
export class PawWorkSearchProvider {
  id = PAWWORK_SEARCH_PROVIDER_ID;

  /**
   * Whether this provider can be selected.
   *
   * Always true: `available()` must be a cheap local check that makes no
   * network call, and this backend needs no credential to consult.
   * @returns true.
   */
  available() {
    return true;
  }

  /**
   * @param request - the seam's search request.
   * @param signal - the caller's abort signal.
   * @returns the normalized search result.
   * @throws {WebError} the seam-coded equivalent of any transport failure.
   */
  async search(request, signal) {
    try {
      return await searchViaMcp({
        query: request.query,
        maxResults: request.maxResults,
        signal,
        timeoutMs: SEARCH_TIMEOUT_MS,
      });
    } catch (error) {
      // The module throws plain `ExaMcpError`s so it stays testable without the
      // ESM seam; the seam's own error type is what carries a code downstream.
      if (error instanceof ExaMcpError) throw new WebError(error.message, error.code, { cause: error });
      throw error;
    }
  }
}

/**
 * Register the PawWork search provider with `ctx.web`.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.web.registerSearchProvider(new PawWorkSearchProvider());
}
