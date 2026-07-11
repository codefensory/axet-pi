/**
 * axet-pi: pi extension that registers models from NTT Data's axet AI
 * gateway as a provider.
 *
 * Pure client of a local proxy on http://localhost:54314 (start it
 * with `axet start`). OpenAI models go through the proxy's OpenAI
 * pass-through; Claude models use Pi's Bedrock Converse streamer
 * against the proxy's `/bedrock/*` endpoint when the current Pi build
 * exposes it, otherwise they fall back to the proxy's legacy `/v1`
 * OpenAI-compatible translation path.
 *
 * Install:  pi install https://github.com/codefensory/axet-pi.git
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROXY_BASE_OPENAI = "http://localhost:54314/openai/v1";
const PROXY_BASE_DISPATCH = "http://localhost:54314/v1";
const PROXY_BASE_BEDROCK = "http://localhost:54314/bedrock";
const DUMMY_KEY = "axet-via-local-proxy";
const CLAUDE_BEDROCK_API = "axet-claude-bedrock";

const FALLBACK_MODELS = [
	"gpt-4o-mini",
	"gpt-4.1-mini",
	"gpt-5.4-2026-03-05",
	"eu.anthropic.claude-haiku-4-5-20251001-v1:0",
] as const;

type ProxyModel = {
	id: string;
	attachment?: boolean;
	cost?: { input: number; output: number };
	limit?: { context: number; output: number };
};
type ProxyList = { data: ProxyModel[] };
type RefreshResult = { ok: true; count: number } | { ok: false; count: number; error: string };
type PiAiModel = {
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
};
type PiAiSupport = {
	bedrockApi?: {
		streamSimple: (model: any, context: any, options?: any) => any;
	};
	getBuiltinModel?: (provider: string, modelId: string) => PiAiModel | undefined;
};

function isClaude(id: string): boolean {
	return id.toLowerCase().includes("claude");
}

function supportsImage(id: string): boolean {
	const x = id.toLowerCase();
	return x.includes("claude")
		|| x.includes("vision")
		|| x.includes("gpt-4o")
		|| x.includes("gpt-4-turbo")
		|| x.includes("gpt-5");
}

function supportsReasoning(id: string): boolean {
	const x = id.toLowerCase();
	return x.includes("claude")
		|| x.includes("thinking")
		|| x.includes("reasoning")
		|| x.includes("gpt-5");
}

function defaultThinkingLevelMap(id: string) {
	const x = id.toLowerCase();
	if (x.includes("gpt-5")) return { off: null, xhigh: "high" };
	if (x.includes("fable-5")) return { off: null, xhigh: "xhigh", max: "max" };
	if (x.includes("sonnet-5") || x.includes("opus-4-7") || x.includes("opus-4-8")) {
		return { xhigh: "xhigh", max: "max" };
	}
	if (x.includes("sonnet-4-6") || x.includes("opus-4-6")) return { max: "max" };
	return undefined;
}

function getBuiltinBedrockModel(support: PiAiSupport, id: string): PiAiModel | undefined {
	try {
		return support.getBuiltinModel?.("amazon-bedrock", id);
	} catch {
		return undefined;
	}
}

function modelDef(id: string, support: PiAiSupport, proxy?: ProxyModel) {
	const claude = isClaude(id);
	const responses = id.toLowerCase().includes("gpt-5");
	const builtinBedrock = claude ? getBuiltinBedrockModel(support, id) : undefined;
	const useClaudeBedrock = claude && !!support.bedrockApi;
	const reasoning = builtinBedrock?.reasoning ?? supportsReasoning(id);
	return {
		id,
		name: id,
		api: (useClaudeBedrock
			? CLAUDE_BEDROCK_API
			: responses
				? "openai-responses"
				: "openai-completions") as const,
		baseUrl: useClaudeBedrock
			? PROXY_BASE_BEDROCK
			: claude
				? PROXY_BASE_DISPATCH
				: PROXY_BASE_OPENAI,
		apiKey: DUMMY_KEY,
		headers: {},
		reasoning,
		thinkingLevelMap: builtinBedrock?.thinkingLevelMap ?? defaultThinkingLevelMap(id),
		...(reasoning && !claude && !responses
			? { compat: { supportsReasoningEffort: true, maxTokensField: "max_completion_tokens" } }
			: {}),
		input: ((builtinBedrock?.input?.length
			? builtinBedrock.input
			: proxy?.attachment || supportsImage(id)
				? ["text", "image"]
				: ["text"]) as ("text" | "image")[]),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: builtinBedrock?.contextWindow ?? 200000,
		maxTokens: builtinBedrock?.maxTokens ?? 200000,
	};
}

function claudeBedrockStreamSimple(support: PiAiSupport) {
	return (model: any, context: any, options?: any) => support.bedrockApi!.streamSimple(model, context, {
		...options,
		env: {
			...(options?.env ?? {}),
			AWS_BEARER_TOKEN_BEDROCK: DUMMY_KEY,
			AWS_BEDROCK_FORCE_HTTP1: "1",
		},
	});
}

function providerConfig(models: ReturnType<typeof modelDef>[], support: PiAiSupport) {
	return {
		api: (support.bedrockApi ? CLAUDE_BEDROCK_API : "openai-completions") as const,
		baseUrl: PROXY_BASE_OPENAI,
		apiKey: DUMMY_KEY,
		...(support.bedrockApi ? { streamSimple: claudeBedrockStreamSimple(support) } : {}),
		models: models as any,
	};
}

function registerAxetProvider(pi: ExtensionAPI, support: PiAiSupport, models: ReturnType<typeof modelDef>[]) {
	pi.registerProvider("axet", providerConfig(models, support) as any);
}

async function loadPiAiSupport(): Promise<PiAiSupport> {
	try {
		const piAi = await import("@earendil-works/pi-ai");
		return {
			bedrockApi: typeof (piAi as any).bedrockConverseStreamApi === "function"
				? (piAi as any).bedrockConverseStreamApi()
				: undefined,
			getBuiltinModel: typeof (piAi as any).getModel === "function"
				? (piAi as any).getModel
				: undefined,
		};
	} catch {
		return {};
	}
}

async function refreshFromProxy(pi: ExtensionAPI, support: PiAiSupport): Promise<RefreshResult> {
	let res: Response;
	try {
		res = await fetch(`${PROXY_BASE_DISPATCH}/models`, { signal: AbortSignal.timeout(3000) });
	} catch {
		return { ok: false, count: 0, error: `proxy unreachable at ${PROXY_BASE_DISPATCH} — run 'axet start'` };
	}
	if (!res.ok) return { ok: false, count: 0, error: `proxy returned HTTP ${res.status}` };
	let j: ProxyList;
	try {
		j = (await res.json()) as ProxyList;
	} catch (e) {
		return { ok: false, count: 0, error: `proxy returned invalid JSON: ${(e as Error).message}` };
	}
	const models = (j.data ?? []).map((m) => {
		const def = modelDef(m.id, support, m);
		return {
			...def,
			cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.limit?.context ?? def.contextWindow,
			maxTokens: m.limit?.output ?? def.maxTokens,
		};
	});
	if (!models.length) return { ok: false, count: 0, error: "proxy returned empty catalog" };
	try {
		registerAxetProvider(pi, support, models);
	} catch (e) {
		return { ok: false, count: 0, error: `failed to register provider: ${(e as Error).message}` };
	}
	return { ok: true, count: models.length };
}

export default async function (pi: ExtensionAPI) {
	const support = await loadPiAiSupport();
	registerAxetProvider(pi, support, FALLBACK_MODELS.map((id) => modelDef(id, support)));

	let lastRefresh = 0;
	const maybeRefresh = async () => {
		if (Date.now() - lastRefresh < 5 * 60_000) return { ok: false, count: 0, error: "throttled" } as RefreshResult;
		lastRefresh = Date.now();
		return await refreshFromProxy(pi, support);
	};

	pi.on("session_start", async (_event, ctx) => {
		const result = await maybeRefresh();
		if (!result.ok && result.error !== "throttled") {
			ctx.ui.notify(
				`Axet: ${result.error}. Provider registered with fallback models only — run /axet-refresh after starting the proxy.`,
				"warning",
			);
		}
	});

	pi.registerCommand("axet-refresh", {
		description: "Refresh axet model list from the local proxy (http://localhost:54314)",
		handler: async (_args, ctx) => {
			lastRefresh = 0;
			const result = await refreshFromProxy(pi, support);
			ctx.ui.notify(
				result.ok ? `Axet: ${result.count} models reloaded from proxy` : `Axet: ${result.error}`,
				result.ok ? "info" : "warning",
			);
		},
	});
}
