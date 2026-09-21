import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import endpoints, {
	type CatalogEntry,
	type Endpoint,
	envVarFor,
	mergeStatus,
	parseCatalog,
	readEndpoints,
	runEndpointsCommand,
	thinkingLevelMapFor,
	toModel,
	withThinkingGate,
} from "../extensions/endpoints.ts";

const chutes = JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8")).data as CatalogEntry[];
const openrouter = JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog.json", import.meta.url), "utf8"))
	.data as CatalogEntry[];

const realFetch = globalThis.fetch;
let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "endpoints-test-"));
	process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_OFFLINE;
	delete process.env.LOCAL_API_KEY;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(agentDir, { recursive: true, force: true });
});

const endpoint = (overrides: Partial<Endpoint> = {}): Endpoint => ({
	id: "local",
	name: "Local",
	baseUrl: "http://127.0.0.1:9/v1",
	enabled: true,
	...overrides,
});

const saveEndpoints = (list: Endpoint[]) => writeFileSync(join(agentDir, "endpoints.json"), JSON.stringify({ endpoints: list }));
const saveCache = (id: string, refreshedAt: number, data: CatalogEntry[]) => {
	mkdirSync(join(agentDir, "endpoints"), { recursive: true });
	writeFileSync(join(agentDir, "endpoints", `${id}.models.json`), JSON.stringify({ refreshedAt, data }));
};

type FetchCall = { url: string; authorization?: string };
function stubFetch(respond: (call: FetchCall) => Response): FetchCall[] {
	const calls: FetchCall[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const call = { url: String(input), authorization: headers.Authorization };
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const vllmList = (...ids: string[]) => ({ object: "list", data: ids.map((id) => ({ id, object: "model", max_model_len: 32768 })) });

type Answer = string | boolean | undefined;

/**
 * A stand-in for the parts of Prime Agent the extension uses: registrations change the
 * model list, keys live in a map, and the UI answers from `answers`, which a test can
 * append to between runs.
 */
function fakeAgent(answers: Answer[] = []) {
	const models: { provider: string; id: string }[] = [{ provider: "openai", id: "gpt-5.6" }];
	const registrations: { id: string; config: ProviderConfig }[] = [];
	const unregistered: string[] = [];
	const keys = new Map<string, string>();
	const notices: { message: string; type?: string }[] = [];
	const prompts: string[] = [];
	const offered = new Map<string, string[]>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let editorText = "";

	const next = (title: string) => {
		prompts.push(title);
		assert.ok(answers.length > 0, `no scripted answer for "${title}"`);
		return answers.shift();
	};
	const pi = {
		registerProvider: (id: string, config: ProviderConfig) => {
			registrations.push({ id, config });
			for (let i = models.length - 1; i >= 0; i--) if (models[i].provider === id) models.splice(i, 1);
			for (const model of config.models ?? []) models.push({ provider: id, id: model.id });
		},
		unregisterProvider: (id: string) => {
			unregistered.push(id);
			for (let i = models.length - 1; i >= 0; i--) if (models[i].provider === id) models.splice(i, 1);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
		registerCommand: (_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			command = options.handler;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		model: undefined,
		modelRegistry: {
			getAll: () => models,
			authStorage: {
				getApiKey: async (id: string) => keys.get(id),
				set: (id: string, credential: { key: string }) => keys.set(id, credential.key),
				remove: (id: string) => keys.delete(id),
			},
		},
		ui: {
			input: async (title: string) => next(title),
			select: async (title: string, options: string[]) => {
				offered.set(title, options);
				const answer = next(title) as string | undefined;
				if (answer !== undefined) assert.ok(options.includes(answer), `"${answer}" is not among ${JSON.stringify(options)}`);
				return answer;
			},
			confirm: async (title: string) => next(title),
			notify: (message: string, type?: string) => notices.push({ message, type }),
			setEditorText: (text: string) => {
				editorText = text;
			},
		},
	};
	return {
		pi,
		ctx,
		models,
		registrations,
		unregistered,
		keys,
		notices,
		prompts,
		offered,
		handlers,
		run: (args = "") => runEndpointsCommand(pi, ctx as never, args),
		get command() {
			return command;
		},
		get editorText() {
			return editorText;
		},
	};
}

describe("models from an endpoint's list", () => {
	test("reads Chutes' context size, output limit, image input and capabilities", () => {
		const kimi = chutes.find((entry) => entry.id === "moonshotai/Kimi-K3-TEE") as CatalogEntry;
		assert.deepEqual(toModel(kimi, endpoint()), {
			id: "moonshotai/Kimi-K3-TEE",
			name: "moonshotai/Kimi-K3-TEE",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
			compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
		});
		const noTools = chutes.find((entry) => entry.id === "unsloth/Mistral-Nemo-Instruct-2407-TEE") as CatalogEntry;
		assert.ok(toModel(noTools, endpoint()), "a model with no reported capabilities is kept");
	});

	test("reads OpenRouter's format and drops models it lists without tools", () => {
		const [rich, withoutTools] = openrouter;
		const model = toModel(rich, endpoint());
		assert.equal(model?.name, rich.name);
		assert.equal(model?.contextWindow, rich.context_length);
		assert.equal(model?.maxTokens, (rich.top_provider as { max_completion_tokens: number }).max_completion_tokens);
		assert.deepEqual(model?.input, ["text", "image"]);
		assert.equal(model?.reasoning, true);
		assert.equal(toModel(withoutTools, endpoint()), undefined);
	});

	test("reads vLLM's max_model_len and never exceeds it for output", () => {
		assert.deepEqual(
			[toModel({ id: "a", max_model_len: 32768 }, endpoint()), toModel({ id: "b", max_model_len: 8192 }, endpoint())].map(
				(model) => [model?.contextWindow, model?.maxTokens],
			),
			[
				[32768, 16384],
				[8192, 8192],
			],
		);
	});

	test("falls back to the endpoint's limits, then Prime Agent's defaults", () => {
		const plain: CatalogEntry = { id: "llama3.1:8b", object: "model", owned_by: "library" };
		const defaults = toModel(plain, endpoint());
		assert.deepEqual([defaults?.contextWindow, defaults?.maxTokens, defaults?.reasoning, defaults?.input], [128000, 16384, false, ["text"]]);
		const tuned = toModel(plain, endpoint({ contextWindow: 32000, maxTokens: 4096 }));
		assert.deepEqual([tuned?.contextWindow, tuned?.maxTokens], [32000, 4096]);
	});

	test("rejects responses that are not a model list", () => {
		assert.throws(() => parseCatalog([{ id: "a" }]), /not an OpenAI-compatible model list/);
		assert.deepEqual(parseCatalog({ data: [{ id: "a" }, { name: "no id" }] }), [{ id: "a" }]);
	});
});

describe("endpoints.json", () => {
	test("a missing file means no endpoints", () => {
		assert.deepEqual(readEndpoints(), []);
	});

	test("names the file and the problem when it is malformed", () => {
		writeFileSync(join(agentDir, "endpoints.json"), "{ not json");
		assert.throws(() => readEndpoints(), /endpoints\.json: /);
		saveEndpoints([endpoint({ baseUrl: "ftp://example.com" })]);
		assert.throws(() => readEndpoints(), /endpoints\[0\]: "baseUrl" must be an http or https URL/);
		saveEndpoints([endpoint({ id: "Has Spaces" })]);
		assert.throws(() => readEndpoints(), /"id" must be lowercase/);
		saveEndpoints([endpoint(), endpoint()]);
		assert.throws(() => readEndpoints(), /used twice/);
	});

	test("derives the environment variable from the id", () => {
		assert.equal(envVarFor("my-vllm"), "MY_VLLM_API_KEY");
	});
});

describe("loading", () => {
	test("registers enabled endpoints from their cached models, without the network", () => {
		saveEndpoints([endpoint(), endpoint({ id: "off", name: "Off", enabled: false })]);
		saveCache("local", Date.now(), [{ id: "m1" }]);
		saveCache("off", Date.now(), [{ id: "m2" }]);
		const calls = stubFetch(() => {
			throw new Error("unexpected fetch");
		});
		const agent = fakeAgent();
		endpoints(agent.pi);

		assert.equal(calls.length, 0);
		assert.deepEqual(
			agent.registrations.map(({ id, config }) => [id, config.baseUrl, config.apiKey, config.models?.map((m) => m.id)]),
			[["local", "http://127.0.0.1:9/v1", "LOCAL_API_KEY", ["m1"]]],
		);
		assert.ok(agent.command, "/endpoints is registered");
	});

	test("a session start refreshes stale lists with the saved key", async () => {
		saveEndpoints([endpoint(), endpoint({ id: "fresh", name: "Fresh", baseUrl: "http://127.0.0.1:8/v1" })]);
		saveCache("local", 0, [{ id: "old" }]);
		saveCache("fresh", Date.now(), [{ id: "kept" }]);
		const calls = stubFetch(() => json(vllmList("new-1", "new-2")));
		const agent = fakeAgent();
		agent.keys.set("local", "sk-saved");
		endpoints(agent.pi);
		assert.deepEqual(agent.registrations.map(({ id, config }) => [id, config.models?.map((m) => m.id)]), [
			["local", ["old"]],
			["fresh", ["kept"]],
		]);
		agent.handlers.get("session_start")?.({}, agent.ctx);

		for (let i = 0; i < 100 && agent.registrations.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(calls, [
			{ url: "http://127.0.0.1:9/v1/models", authorization: "Bearer sk-saved" },
			{ url: "http://127.0.0.1:9/v1/status", authorization: "Bearer sk-saved" },
		]);
		assert.deepEqual(agent.models.filter((m) => m.provider === "local").map((m) => m.id), ["new-1", "new-2"]);
		assert.deepEqual(
			JSON.parse(readFileSync(join(agentDir, "endpoints", "local.models.json"), "utf8")).data.map((e: CatalogEntry) => e.id),
			["new-1", "new-2"],
		);
	});

	test("uses the environment variable when no key is saved, and stays offline when asked", async () => {
		saveEndpoints([endpoint()]);
		process.env.LOCAL_API_KEY = "sk-from-env";
		const calls = stubFetch(() => json(vllmList("m")));
		const agent = fakeAgent();
		endpoints(agent.pi);
		agent.handlers.get("session_start")?.({}, agent.ctx);
		for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(calls[0]?.authorization, "Bearer sk-from-env");
		await new Promise((resolve) => setTimeout(resolve, 20));
		const before = calls.length;

		process.env.PI_OFFLINE = "1";
		const offline = fakeAgent();
		endpoints(offline.pi);
		offline.handlers.get("session_start")?.({}, offline.ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(calls.length, before);
	});
});

describe("/endpoints", () => {
	test("adds an endpoint, saves its key and leaves the model picker ready for it", async () => {
		const calls = stubFetch(() => json(vllmList("qwen", "llama")));
		const agent = fakeAgent(["https://gpu.example.com/v1/", "sk-new", "My GPU"]);
		await agent.run("add");

		assert.deepEqual(calls, [
			{ url: "https://gpu.example.com/v1/models", authorization: "Bearer sk-new" },
			{ url: "https://gpu.example.com/v1/status", authorization: "Bearer sk-new" },
		]);
		assert.deepEqual(readEndpoints(), [{ id: "my-gpu", name: "My GPU", baseUrl: "https://gpu.example.com/v1", enabled: true }]);
		assert.equal(agent.keys.get("my-gpu"), "sk-new");
		assert.deepEqual(agent.models.filter((m) => m.provider === "my-gpu").map((m) => m.id), ["qwen", "llama"]);
		assert.ok(existsSync(join(agentDir, "endpoints", "my-gpu.models.json")));
		assert.equal(agent.editorText, "/model my-gpu");
		assert.deepEqual(agent.notices.at(-1), { message: "Added My GPU with 2 models. Press Enter to choose one.", type: "info" });
	});

	test("an endpoint without a key is added without saving one", async () => {
		const calls = stubFetch(() => json(vllmList("m")));
		const agent = fakeAgent(["http://127.0.0.1:11434/v1", "", ""]);
		await agent.run("add");
		assert.equal(calls[0].authorization, undefined);
		assert.deepEqual(readEndpoints().map((saved) => [saved.id, saved.name]), [["127-0-0-1-11434", "127.0.0.1:11434"]]);
		assert.equal(agent.keys.size, 0);
	});

	test("asks again for a bad URL and adds nothing when the key is refused", async () => {
		stubFetch(() => json({ error: "bad key" }, 401));
		const agent = fakeAgent(["not a url", "https://api.example.com/v1", "sk-wrong"]);
		await agent.run("add");
		assert.match(agent.notices[0].message, /not an http or https URL/);
		assert.match(agent.notices[1].message, /^Not added: .*refused the API key \(HTTP 401\)/);
		assert.deepEqual(readEndpoints(), []);
		assert.equal(agent.keys.size, 0);
	});

	test("refuses a name that is already a provider", async () => {
		stubFetch(() => json(vllmList("m")));
		const agent = fakeAgent(["https://api.example.com/v1", "sk", "OpenAI", "Example"]);
		await agent.run("add");
		assert.match(agent.notices[0].message, /"openai" is already a provider/);
		assert.deepEqual(readEndpoints().map((saved) => saved.id), ["example"]);
	});

	test("disables and re-enables an endpoint from the menu", async () => {
		saveEndpoints([endpoint()]);
		saveCache("local", Date.now(), [{ id: "m1" }]);
		stubFetch(() => json(vllmList("m1", "m2")));
		const answers: Answer[] = ["Local [local] · 127.0.0.1:9 · 1 models", "Disable"];
		const agent = fakeAgent(answers);
		endpoints(agent.pi);

		await agent.run();
		assert.equal(readEndpoints()[0].enabled, false);
		assert.deepEqual(agent.unregistered, ["local"]);
		assert.equal(agent.models.filter((m) => m.provider === "local").length, 0);

		answers.push("Local [local] · 127.0.0.1:9 · disabled", "Enable");
		await agent.run();
		assert.ok(!agent.offered.get("Local [local] · 127.0.0.1:9 · disabled")?.includes("Choose one of its models"));
		assert.equal(readEndpoints()[0].enabled, true);
		assert.deepEqual(agent.models.filter((m) => m.provider === "local").map((m) => m.id), ["m1", "m2"]);
		assert.ok(agent.notices.some((notice) => notice.message === "Local enabled with 2 models."));
	});

	test("hands model choice to Prime Agent's picker and explains mistakes", async () => {
		saveEndpoints([endpoint()]);
		saveCache("local", Date.now(), [{ id: "m1" }, { id: "m2" }]);
		const agent = fakeAgent(["Local [local] · 127.0.0.1:9 · 2 models", "Choose one of its models"]);
		endpoints(agent.pi);
		await agent.run();
		assert.equal(agent.editorText, "/model local");
		assert.equal(agent.notices.at(-1)?.message, "Press Enter to choose one of Local's models.");

		await agent.run("enable nope");
		assert.match(agent.notices.at(-1)?.message ?? "", /No endpoint "nope"\. Endpoints: local\./);
		for (const args of ["use local", "frobnicate local"]) {
			await agent.run(args);
			assert.match(agent.notices.at(-1)?.message ?? "", /^Usage: \/endpoints/);
		}
	});

	test("changes the key, and deletes it when left empty", async () => {
		saveEndpoints([endpoint()]);
		const calls = stubFetch(() => json(vllmList("m")));
		const answers: Answer[] = ["Local [local] · 127.0.0.1:9 · 0 models", "Change API key", "sk-rotated"];
		const agent = fakeAgent(answers);
		endpoints(agent.pi);
		await agent.run();
		assert.equal(agent.keys.get("local"), "sk-rotated");
		assert.equal(calls.at(-1)?.authorization, "Bearer sk-rotated");

		answers.push("Local [local] · 127.0.0.1:9 · 1 models", "Change API key", "");
		await agent.run();
		assert.equal(agent.keys.has("local"), false);
	});

	test("keeps the old URL when the new one does not answer", async () => {
		saveEndpoints([endpoint()]);
		stubFetch(() => json({}, 404));
		const agent = fakeAgent(["Local [local] · 127.0.0.1:9 · 0 models", "Change URL", "https://moved.example.com/v1"]);
		endpoints(agent.pi);
		await agent.run();
		assert.equal(readEndpoints()[0].baseUrl, "http://127.0.0.1:9/v1");
		assert.match(agent.notices.at(-1)?.message ?? "", /^URL not changed: .*HTTP 404/);
	});

	test("removes an endpoint with its key and cached models", async () => {
		saveEndpoints([endpoint()]);
		saveCache("local", Date.now(), [{ id: "m1" }]);
		const agent = fakeAgent([true]);
		agent.keys.set("local", "sk");
		endpoints(agent.pi);
		await agent.run("remove local");
		assert.deepEqual(readEndpoints(), []);
		assert.equal(agent.keys.has("local"), false);
		assert.deepEqual(agent.unregistered, ["local"]);
		assert.equal(existsSync(join(agentDir, "endpoints", "local.models.json")), false);
	});
});

describe("reasoning metadata", () => {
	test("reads supports_reasoning, reasoning: true and reasoning.supported", () => {
		for (const stated of [{ supports_reasoning: true }, { reasoning: true }, { reasoning: { supported: true } }]) {
			assert.equal(toModel({ id: "m", ...stated }, endpoint())?.reasoning, true, JSON.stringify(stated));
		}
	});

	test("an explicit false wins over listed capabilities", () => {
		for (const stated of [{ supports_reasoning: false }, { reasoning: false }, { reasoning: { supported: false } }]) {
			const model = toModel({ id: "m", supported_features: ["tools", "reasoning"], ...stated }, endpoint());
			assert.equal(model?.reasoning, false, JSON.stringify(stated));
		}
	});

	test("never infers reasoning from a model name", () => {
		assert.equal(toModel({ id: "deepseek-r1-reasoning-thinking" }, endpoint())?.reasoning, false);
	});
});

const loadedId = "orcarouter/Qwen3.8-27B-Uncensored-GGUF";
const unslothStatus = {
	supports_reasoning: true,
	reasoning_style: "enable_thinking_effort",
	reasoning_effort_levels: ["low", "medium", "xhigh"],
	reasoning_always_on: false,
	context_length: 188672,
	loaded: [loadedId],
};
const unslothModels = { object: "list", data: [{ id: loadedId, object: "model" }, { id: "other/idle-model", object: "model" }] };

describe("Unsloth /status", () => {
	test("merges status metadata into loaded models only", () => {
		const merged = mergeStatus(unslothModels.data, unslothStatus);
		assert.equal(merged[0].reasoning_style, "enable_thinking_effort");
		assert.equal(merged[0].context_length, 188672);
		assert.deepEqual(merged[1], { id: "other/idle-model", object: "model" });
		assert.deepEqual(mergeStatus(unslothModels.data, { ...unslothStatus, loaded: [] }), unslothModels.data);
		assert.deepEqual(mergeStatus(unslothModels.data, undefined), unslothModels.data);
	});

	test("maps the reported effort levels exactly, in the default effort format", () => {
		const [loaded] = mergeStatus(unslothModels.data, unslothStatus);
		const model = toModel(loaded, endpoint());
		assert.equal(model?.reasoning, true);
		assert.equal(model?.contextWindow, 188672);
		assert.deepEqual(model?.thinkingLevelMap, {
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: null,
			xhigh: "xhigh",
			max: null,
		});
		assert.deepEqual(model?.compat, {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			supportsReasoningEffort: true,
		});
	});

	test("keeps output limits separate from the context size", () => {
		const [loaded] = mergeStatus(unslothModels.data, unslothStatus);
		assert.equal(toModel(loaded, endpoint())?.maxTokens, 16384);
		assert.equal(toModel(loaded, endpoint({ maxTokens: 8192 }))?.maxTokens, 8192);
	});

	test("a server that keeps reasoning on offers no off level", () => {
		assert.equal(thinkingLevelMapFor(["low", "high"], true)?.off, null);
		assert.equal(thinkingLevelMapFor(["low", "high"], false)?.off, "none");
	});

	test("without /status, discovery uses /models alone and guesses nothing", async () => {
		stubFetch(({ url }) => (url.endsWith("/status") ? json({ error: "not found" }, 404) : json(unslothModels)));
		const agent = fakeAgent(["http://127.0.0.1:8888/v1", "sk-local", "Unsloth"]);
		await agent.run("add");
		const model = agent.registrations.at(-1)?.config.models?.find((m) => m.id === loadedId);
		assert.equal(model?.reasoning, false);
		assert.equal(model?.thinkingLevelMap, undefined);
		assert.equal(model?.contextWindow, 128000);
	});
});

describe("Unsloth thinking gate", () => {
	const efforts = new Set(["low", "medium", "xhigh"]);

	test("turns thinking off for effort none and on for a listed effort, keeping reasoning_effort", () => {
		assert.deepEqual(withThinkingGate({ model: "m", reasoning_effort: "none" }, "m", efforts), {
			model: "m",
			reasoning_effort: "none",
			enable_thinking: false,
		});
		assert.deepEqual(withThinkingGate({ model: "m", reasoning_effort: "xhigh" }, "m", efforts), {
			model: "m",
			reasoning_effort: "xhigh",
			enable_thinking: true,
		});
	});

	test("leaves unlisted efforts, explicit enable_thinking and other models alone", () => {
		assert.equal(withThinkingGate({ model: "m", reasoning_effort: "high" }, "m", efforts), undefined);
		assert.equal(withThinkingGate({ model: "m", reasoning_effort: "low", enable_thinking: false }, "m", efforts), undefined);
		assert.equal(withThinkingGate({ model: "other", reasoning_effort: "none" }, "m", efforts), undefined);
		assert.equal(withThinkingGate({ model: "m" }, "m", efforts), undefined);
		assert.equal(withThinkingGate(undefined, "m", efforts), undefined);
	});

	test("the registered hook applies to the session's gated model only", async () => {
		stubFetch(({ url }) => json(url.endsWith("/status") ? unslothStatus : unslothModels));
		const agent = fakeAgent(["http://127.0.0.1:8888/v1", "sk-local", "Unsloth"]);
		endpoints(agent.pi);
		await agent.run("add");
		const hook = agent.handlers.get("before_provider_request") as unknown as (event: unknown, ctx: unknown) => unknown;
		const request = (reasoning_effort: string, model = loadedId) => ({ type: "before_provider_request", payload: { model, reasoning_effort } });
		const on = (provider: string, id: string) => ({ model: { provider, id } });

		assert.deepEqual(hook(request("none"), on("unsloth", loadedId)), { model: loadedId, reasoning_effort: "none", enable_thinking: false });
		assert.deepEqual(hook(request("low"), on("unsloth", loadedId)), { model: loadedId, reasoning_effort: "low", enable_thinking: true });
		assert.equal(hook(request("none", "other/idle-model"), on("unsloth", "other/idle-model")), undefined);
		assert.equal(hook(request("none"), on("another-endpoint", loadedId)), undefined);
		assert.equal(hook(request("none"), { model: undefined }), undefined);
	});
});
