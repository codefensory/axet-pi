/**
 * axet-pi: pi extension that registers models from NTT Data's axet AI
 * gateway as a provider.
 *
 * Pure client of a local proxy on http://localhost:54314 (start it
 * with `axet start`). The proxy handles Okta auth, the axet WAF, and
 * provider dispatch (OpenAI pass-through vs. Claude/Bedrock via
 * ClaudeProvider). The extension registers a 3-model fallback
 * synchronously, then refreshes the live catalog from the proxy on
 * session_start. All streaming is delegated to pi's built-in
 * `openai-completions` streamer.
 *
 * Install:  pi install https://github.com/codefensory/axet-pi.git
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROXY_BASE_OPENAI = "http://localhost:54314/openai/v1";
const PROXY_BASE_DISPATCH = "http://localhost:54314/v1";
const DUMMY_KEY = "axet-via-local-proxy";

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
	return id.toLowerCase().includes("claude")
		|| id.toLowerCase().includes("thinking")
		|| id.toLowerCase().includes("reasoning");
}

function modelDef(id: string) {
	const reasoning = supportsReasoning(id);
	const claude = isClaude(id);
	return {
		id,
		name: id,
		api: "openai-completions" as const,
		baseUrl: claude ? PROXY_BASE_DISPATCH : PROXY_BASE_OPENAI,
		apiKey: DUMMY_KEY,
		headers: {},
		reasoning,
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
	} catch {
		return { ok: false, count: 0, error: `proxy unreachable at ${PROXY_BASE_DISPATCH} \u2014 run 'axet start'` };
	}
	if (!res.ok) return { ok: false, count: 0, error: `proxy returned HTTP ${res.status}` };
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
	if (!models.length) return { ok: false, count: 0, error: "proxy returned empty catalog" };
	try {
		pi.unregisterProvider("axet");
	} catch {}
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
	pi.registerProvider("axet", {
		api: "openai-completions",
		baseUrl: PROXY_BASE_OPENAI,
		apiKey: DUMMY_KEY,
		models: FALLBACK_MODELS.map(modelDef) as any,
	});

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
			ctx.ui.notify(
				result.ok ? `Axet: ${result.count} models reloaded from proxy` : `Axet: ${result.error}`,
				result.ok ? "info" : "warn",
			);
		},
	});
}
