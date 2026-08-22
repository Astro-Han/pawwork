export const name = 'pawwork-identity';

// The deployment-wide PawWork identity. dsh-system-prompt's fixed opener only
// says "powered by DeepSeek Harness", and each shipped preset mounts its own
// persona row that shadows the deployment persona — so neither the identity
// toggle nor the persona config can carry the product name into a preset
// agent. A NEW section name in the global layer can: scope shadowing is
// per-name, so standard/code/minimal all inherit this section. Order -99 sits
// in the identity band, right after the harness identity (-100) and before
// the persona (0). The harness opener stays: PawWork IS built on DSH, and the
// attribution should say so.
export const PAWWORK_IDENTITY_SECTION = Object.freeze({
	name: 'pawwork:identity',
	order: -99,
	text: 'You are PawWork (爪印), a desktop AI agent product built on DeepSeek Harness (DSH). When the user asks who you are or what product they are using, answer that you are PawWork (爪印), based on DeepSeek Harness.',
});

// Only the system-prompt service is needed; activation waits for it alone, so
// no other product concern can keep the identity from registering.
export const inject = ['systemPrompt'];

export function apply(ctx) {
	// One registration on the global layer for the process; the registry
	// disposes it with this plugin's fiber.
	ctx.systemPrompt.section(PAWWORK_IDENTITY_SECTION);
}
