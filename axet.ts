/**
 * Axet provider for pi.
 *
 * Pure client of the local `axet-proxy.v0.1` (or `axet start`) on
 * http://localhost:54314. The proxy handles Okta auth, the axet
 * fingerprinting WAF, and the /v3/ gateway path. The extension
 * registers a 3-model fallback catalog synchronously (so `pi -p`
 * doesn't race the async fetch), then refreshes the full catalog
 * from the proxy on session_start. All streaming / formatting is
 * delegated to pi's built-in `openai-completions` streamer.
 *
 * Requirements:
 *   - `axet start` (CLI) or `npm start` (axet-proxy.v0.1) running on :54314
 *   - User already logged in (`axet login` once; token persists in
 *     ~/.config/axet/state.json and is re-used by the proxy).
 *
 * No Okta calls, no axet headers, no project management — the proxy
 * owns all of that. Any `apiKey` sent by pi is ignored by the proxy.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Two routes into the axet proxy:
//
//   /openai/v1/*  — pure pass-through (same as OpenCode --sync). No body reshape.
//                   Used for OpenAI models. Predictable, no chat->responses bridge bugs.
//                   Cannot handle Claude: forwards as-is to the axet gateway, which
//                   returns "The specified model does not exist" for non-OpenAI models.
//
//   /v1/*         — provider-dispatched: completionsRoute.js picks ClaudeProvider
//                   for aws_anthropic models, which translates OpenAI chat format
//                   ↔ Anthropic Bedrock InvokeModel. This is what makes Claude work
//                   without us reimplementing the translation in TypeScript.
//                   The /bedrock/* route also exists but is Bedrock-native format
//                   (messages.content as [{text}], inferenceConfig, etc.) — only
//                   OpenCode uses it (via @ai-sdk/amazon-bedrock with dummy SigV4).
//                   We don't use it because pi would need a custom provider+streamer
//                   to translate, which ClaudeProvider already does for free.
const PROXY_BASE_OPENAI = "http://localhost:54314/openai/v1";
const PROXY_BASE_DISPATCH = "http://localhost:54314/v1";
// The proxy accepts any Authorization header; the value doesn't matter.
const DUMMY_KEY = "axet-via-local-proxy";

/** Fallback model list — only models that virtually any NTT wallet
 *  has access to (low-tier, default-enabled). Used to register the
 *  provider immediately at startup so `pi -p` doesn't fail with
 *  "provider not found" while the async catalog fetch is in flight.
 *  The real catalog is fetched from the proxy and replaces this list
 *  on session_start. If your wallet doesn't have even these models,
 *  the catalog refresh will narrow the list accordingly. */
const FALLBACK_MODELS = [
	"gpt-4o-mini",
	"gpt-4.1-mini",
	"eu.anthropic.claude-haiku-4-5-20251001-v1:0",
] as const;

function isClaude(id: string): boolean {
	return id.toLowerCase().includes("claude");
}
function supportsImage(id: string): boolean {
	const x = id.toLowerCase();
	return x.includes("vision") || x.includes("claude-3") || x.includes("claude-4")
		|| x.includes("gpt-4o") || x.includes("gpt-4-turbo") || x.includes("gpt-5");
}
function supportsReasoning(id: string): boolean {
	// The axet gateway rejects tool+reasoning_effort on /chat/completions
	// for gpt-5.4 family ("Please use /v1/responses instead"). Since pi
	// always sends tools, we must NOT mark models as reasoning-capable or
	// pi will inject `reasoning_effort` and the gateway returns 400. We
	// only flag Claude (which has no tool path working through this proxy
	// anyway) so the field stays a no-op for the working GPT models.
	const x = id.toLowerCase();
	return x.includes("claude") || x.includes("thinking") || x.includes("reasoning");
}

function modelDef(id: string) {
	const reasoning = supportsReasoning(id);
	const claude = isClaude(id);
	return {
		id,
		name: id,
		api: "openai-completions" as const,
		// Claude needs the /v1/* dispatch route (translates to Anthropic Bedrock).
		// OpenAI uses the clean /openai/* pass-through.
		baseUrl: claude ? PROXY_BASE_DISPATCH : PROXY_BASE_OPENAI,
		apiKey: DUMMY_KEY,
		headers: {},
		reasoning,
		// OpenAI reasoning models support reasoning_effort
		...(reasoning && !claude ? { compat: { supportsReasoningEffort: true } } : {}),
		input: (supportsImage(id) ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: claude ? 200000 : 128000,
		maxTokens: claude ? 8192 : 4096,
	};
}

type ProxyModel = { id: string; cost?: { input: number; output: number }; limit?: { context: number; output: number } };
type ProxyList = { data: ProxyModel[] };

type RefreshResult = { ok: true; count: number } | { ok: false; count: number; error: string };

async function refreshFromProxy(pi: ExtensionAPI): Promise<RefreshResult> {
	let res: Response;
	try {
		res = await fetch(`${PROXY_BASE_DISPATCH}/models`, { signal: AbortSignal.timeout(3000) });
	} catch (e) {
		return {
			ok: false,
			count: 0,
			error: `proxy unreachable at ${PROXY_BASE_DISPATCH} \u2014 run 'axet start' (or 'npm start' in axet-proxy.v0.1)`,
		};
	}
	if (!res.ok) {
		return { ok: false, count: 0, error: `proxy returned HTTP ${res.status}` };
	}
	let j: ProxyList;
	try {
		j = (await res.json()) as ProxyList;
	} catch (e) {
		return { ok: false, count: 0, error: `proxy returned invalid JSON: ${(e as Error).message}` };
	}
	const models = (j.data ?? []).map((m) => {
		const def = modelDef(m.id);
		return {
			...def,
			cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.limit?.context ?? def.contextWindow,
			maxTokens: m.limit?.output ?? def.maxTokens,
		};
	});
	if (!models.length) {
		return { ok: false, count: 0, error: "proxy returned empty catalog" };
	}
	try {
		pi.unregisterProvider("axet");
	} catch {
		// Provider wasn't registered yet (e.g. proxy was reachable before
		// the synchronous FALLBACK_MODELS register finished). Safe to ignore.
	}
	try {
		pi.registerProvider("axet", {
			api: "openai-completions",
			baseUrl: PROXY_BASE_OPENAI,
			apiKey: DUMMY_KEY,
			models: models as any,
		});
	} catch (e) {
		return { ok: false, count: 0, error: `failed to register provider: ${(e as Error).message}` };
	}
	return { ok: true, count: models.length };
}

export default function (pi: ExtensionAPI) {
	// Register immediately with the fallback list so pi -p sees the provider
	// without waiting for the async fetch. The real catalog from the proxy
	// replaces this list on session_start.
	pi.registerProvider("axet", {
		api: "openai-completions",
		baseUrl: PROXY_BASE_OPENAI,
		apiKey: DUMMY_KEY,
		models: FALLBACK_MODELS.map(modelDef) as any,
	});

	// Background refresh: fetch the live catalog from the proxy and re-register
	// with real pricing/limits. Throttled to once per 5 minutes.
	let lastRefresh = 0;
	const maybeRefresh = async () => {
		if (Date.now() - lastRefresh < 5 * 60_000) return { ok: false, count: 0, error: "throttled" } as RefreshResult;
		lastRefresh = Date.now();
		return await refreshFromProxy(pi);
	};

	pi.on("session_start", async (_event, ctx) => {
		const result = await maybeRefresh();
		if (!result.ok && result.error !== "throttled") {
			ctx.ui.notify(
				`Axet: ${result.error}. Provider registered with fallback models only \u2014 run /axet-refresh after starting the proxy.`,
				"warn",
			);
		}
	});

	pi.registerCommand("axet-refresh", {
		description: "Refresh axet model list from the local proxy (http://localhost:54314)",
		handler: async (_args, ctx) => {
			lastRefresh = 0;
			const result = await refreshFromProxy(pi);
			if (result.ok) {
				ctx.ui.notify(`Axet: ${result.count} models reloaded from proxy`, "info");
			} else {
				ctx.ui.notify(`Axet: ${result.error}`, "warn");
			}
		},
	});
}
