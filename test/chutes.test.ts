import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import chutes, {
	type CatalogEntry,
	chutesOAuth,
	parseAuthorizationInput,
	parseCatalog,
	REDIRECT_URI,
	toModel,
} from "../extensions/chutes.ts";

const catalog = JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const entries: CatalogEntry[] = catalog.data;
const byId = (id: string) => entries.find((entry) => entry.id === id) as CatalogEntry;

const realFetch = globalThis.fetch;
let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "chutes-test-"));
	process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
	delete process.env.CHUTES_API_KEY;
	delete process.env.PI_OFFLINE;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(agentDir, { recursive: true, force: true });
});

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
	const calls: FetchCall[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const call = { url: String(input), init };
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return calls;
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakePi() {
	const registrations: { name: string; config: ProviderConfig }[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = {
		registerProvider: (name: string, config: ProviderConfig) => registrations.push({ name, config }),
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
	} as unknown as ExtensionAPI;
	return { pi, registrations, handlers };
}

async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(condition(), "condition not reached");
}

const cacheFile = () => join(agentDir, "chutes-models-cache.json");
const writeCache = (refreshedAt: number, data: CatalogEntry[]) =>
	writeFileSync(cacheFile(), JSON.stringify({ refreshedAt, data }));

describe("model catalog", () => {
	test("keeps the tool-capable models and maps their limits, prices and inputs", () => {
		const models = entries.flatMap((entry) => toModel(entry) ?? []);
		assert.equal(models.length, entries.filter((e) => (e.supported_features as string[] | undefined)?.includes("tools")).length);
		assert.ok(!models.some((model) => model.id === "unsloth/Mistral-Nemo-Instruct-2407-TEE"));

		const glm = toModel(byId("zai-org/GLM-5.2-TEE"));
		assert.deepEqual(glm, {
			id: "zai-org/GLM-5.2-TEE",
			name: "GLM 5.2 TEE",
			reasoning: true,
			input: ["text"],
			cost: { input: 1.25, output: 3.95, cacheRead: (byId("zai-org/GLM-5.2-TEE").pricing?.input_cache_read as number) ?? 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
			compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
		});
		assert.deepEqual(toModel(byId("google/gemma-4-31B-turbo-TEE"))?.input, ["text", "image"]);
	});

	test("applies the DeepSeek V4 and Kimi K3 thinking contracts", () => {
		const deepseek = toModel(byId("deepseek-ai/DeepSeek-V4-Flash-0731-TEE"));
		assert.deepEqual(deepseek?.compat, {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		});
		assert.deepEqual(deepseek?.thinkingLevelMap, { minimal: null, low: null, medium: null, high: "high", xhigh: "max", max: null });

		const kimi = toModel(byId("moonshotai/Kimi-K3-TEE"));
		assert.deepEqual(kimi?.thinkingLevelMap, { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" });
		assert.equal(toModel(byId("moonshotai/Kimi-K2.6-TEE"))?.thinkingLevelMap, undefined);
	});

	test("skips entries whose limits are missing or malformed", () => {
		const base = byId("zai-org/GLM-5.2-TEE");
		assert.equal(toModel({ ...base, context_length: "1048576" }), undefined);
		assert.equal(toModel({ ...base, max_output_length: undefined }), undefined);
		assert.equal(toModel({ ...base, supported_features: ["reasoning"] }), undefined);
	});

	test("rejects payloads without a data array and drops entries without an id", () => {
		assert.throws(() => parseCatalog({ models: [] }), /no data array/);
		assert.throws(() => parseCatalog(null), /no data array/);
		assert.deepEqual(parseCatalog({ data: [{ id: "a" }, { name: "no id" }, null] }), [{ id: "a" }]);
	});
});

describe("registration", () => {
	test("first start fetches the catalog, registers it and caches it", async () => {
		const calls = stubFetch(() => json(catalog));
		const { pi, registrations } = fakePi();
		await chutes(pi);

		assert.deepEqual(calls.map((call) => call.url), ["https://llm.chutes.ai/v1/models"]);
		assert.equal(registrations.length, 1);
		const { name, config } = registrations[0];
		assert.equal(name, "chutes");
		assert.equal(config.baseUrl, "https://llm.chutes.ai/v1");
		assert.equal(config.api, "openai-completions");
		assert.equal(config.apiKey, undefined);
		assert.equal(config.models?.length, entries.flatMap((entry) => toModel(entry) ?? []).length);
		assert.equal((config.oauth as typeof chutesOAuth).usesCallbackServer, true);

		const cache = JSON.parse(readFileSync(cacheFile(), "utf8"));
		assert.equal(cache.data.length, entries.length);
		assert.ok(Date.now() - cache.refreshedAt < 5_000);
	});

	test("refers to CHUTES_API_KEY by name, and only when it is set", async () => {
		stubFetch(() => json(catalog));
		process.env.CHUTES_API_KEY = "cpk_test";
		const { pi, registrations } = fakePi();
		await chutes(pi);
		assert.equal(registrations[0].config.apiKey, "CHUTES_API_KEY");
	});

	test("a fresh cache registers without touching the network", async () => {
		writeCache(Date.now(), entries);
		const calls = stubFetch(() => {
			throw new Error("unexpected fetch");
		});
		const { pi, registrations } = fakePi();
		await chutes(pi);
		assert.equal(calls.length, 0);
		assert.equal(registrations.length, 1);
		assert.ok((registrations[0].config.models?.length ?? 0) > 0);
	});

	test("a stale cache registers at once and refreshes in the background", async () => {
		writeCache(Date.now() - 2 * 60 * 60 * 1000, [byId("zai-org/GLM-5.2-TEE")]);
		const calls = stubFetch(() => json(catalog));
		const { pi, registrations } = fakePi();
		await chutes(pi);

		assert.equal(registrations[0].config.models?.length, 1);
		await until(() => registrations.length === 2);
		assert.equal(calls.length, 1);
		assert.ok((registrations[1].config.models?.length ?? 0) > 1);
		await until(() => JSON.parse(readFileSync(cacheFile(), "utf8")).data.length === entries.length);
	});

	test("a failed refresh keeps the cached catalog", async () => {
		writeCache(Date.now() - 2 * 60 * 60 * 1000, [byId("zai-org/GLM-5.2-TEE")]);
		const calls = stubFetch(() => json({ error: "down" }, 503));
		const { pi, registrations } = fakePi();
		await chutes(pi);
		await until(() => calls.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(registrations.length, 1);
		assert.equal(JSON.parse(readFileSync(cacheFile(), "utf8")).data.length, 1);
	});

	test("without a catalog, sign-in stays available and the session warns", async () => {
		stubFetch(() => json({ error: "down" }, 503));
		const { pi, registrations, handlers } = fakePi();
		await chutes(pi);

		assert.equal(registrations.length, 1);
		assert.deepEqual(registrations[0].config.models, []);
		assert.ok(registrations[0].config.oauth);
		assert.equal(existsSync(cacheFile()), false);

		const notices: { message: string; type?: string }[] = [];
		handlers.get("session_start")?.({}, { ui: { notify: (message: string, type?: string) => notices.push({ message, type }) } });
		assert.equal(notices.length, 1);
		assert.equal(notices[0].type, "warning");
		assert.match(notices[0].message, /HTTP 503/);
	});

	test("offline mode never fetches", async () => {
		process.env.PI_OFFLINE = "1";
		const calls = stubFetch(() => json(catalog));

		const empty = fakePi();
		await chutes(empty.pi);
		assert.deepEqual(empty.registrations[0].config.models, []);

		writeCache(0, entries);
		const cached = fakePi();
		await chutes(cached.pi);
		assert.ok((cached.registrations[0].config.models?.length ?? 0) > 0);

		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(calls.length, 0);
	});
});

describe("sign in with Chutes", () => {
	const tokens = { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600, scope: "openid profile chutes:invoke" };

	/** Logins still waiting when a test ends; cancelled so none keeps the callback port. */
	const pending: (() => void)[] = [];
	afterEach(() => {
		for (const cancel of pending.splice(0)) cancel();
	});

	function browserRedirect(query: Record<string, string>): Promise<number> {
		return new Promise((resolve, reject) => {
			// agent: false, so a connection kept alive to an earlier test's server is never reused.
			get(`http://127.0.0.1:51789/auth/chutes/callback?${new URLSearchParams(query)}`, { agent: false }, (response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			}).on("error", reject);
		});
	}

	/** Starts a login and returns it with the authorize URL it opened. */
	async function startLogin(callbacks: Partial<Parameters<typeof chutesOAuth.login>[0]> = {}) {
		let opened!: (url: URL) => void;
		const authorizeUrl = new Promise<URL>((resolve) => {
			opened = resolve;
		});
		const result = chutesOAuth.login({
			onAuth: ({ url }) => opened(new URL(url)),
			onPrompt: async () => {
				throw new Error("unexpected prompt");
			},
			// Like /login, which always offers the paste box; cancelled after the test.
			onManualCodeInput: () =>
				new Promise<string>((_resolve, reject) => {
					pending.push(() => reject(new Error("Login cancelled")));
				}),
			...callbacks,
		});
		result.catch(() => {});
		return { result, url: await authorizeUrl };
	}

	test("accepts a redirect URL, a query string or a bare code", () => {
		assert.equal(parseAuthorizationInput(`${REDIRECT_URI}?code=abc&state=s1`, "s1"), "abc");
		assert.equal(parseAuthorizationInput("code=abc&state=s1", "s1"), "abc");
		assert.equal(parseAuthorizationInput("  abc  ", "s1"), "abc");
		assert.throws(() => parseAuthorizationInput(`${REDIRECT_URI}?code=abc&state=other`, "s1"), /state mismatch/);
		assert.throws(() => parseAuthorizationInput(`${REDIRECT_URI}?error=access_denied&state=s1`, "s1"), /access_denied/);
		assert.throws(() => parseAuthorizationInput("", "s1"), /Missing authorization code/);
	});

	test("exchanges the browser's code using PKCE", async () => {
		const calls = stubFetch(() => json(tokens));
		const { result, url } = await startLogin();

		assert.equal(url.origin + url.pathname, "https://api.chutes.ai/idp/authorize");
		assert.equal(url.searchParams.get("client_id"), "cid_vvdp89s5y9bj94rciuq5mmhz");
		assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
		assert.equal(url.searchParams.get("scope"), "openid profile chutes:invoke");
		assert.equal(url.searchParams.get("code_challenge_method"), "S256");

		assert.equal(await browserRedirect({ code: "code_1", state: url.searchParams.get("state") ?? "" }), 200);
		const credentials = await result;

		assert.equal(credentials.access, "at_1");
		assert.equal(credentials.refresh, "rt_1");
		assert.equal(credentials.scope, "openid profile chutes:invoke");
		assert.ok(Math.abs(credentials.expires - (Date.now() + 55 * 60 * 1000)) < 5_000);

		assert.equal(calls[0].url, "https://api.chutes.ai/idp/token");
		const form = new URLSearchParams(String(calls[0].init?.body));
		assert.equal(form.get("grant_type"), "authorization_code");
		assert.equal(form.get("code"), "code_1");
		assert.equal(form.get("redirect_uri"), REDIRECT_URI);
		assert.ok(form.get("client_secret"));
		const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
		assert.equal(challenge, url.searchParams.get("code_challenge"));
	});

	test("ignores a redirect carrying another state", async () => {
		stubFetch(() => json(tokens));
		const { result, url } = await startLogin();
		assert.equal(await browserRedirect({ code: "forged", state: "someone-else" }), 400);
		assert.equal(await browserRedirect({ code: "code_2", state: url.searchParams.get("state") ?? "" }), 200);
		assert.equal((await result).access, "at_1");
	});

	test("completes from a pasted redirect URL", async () => {
		const calls = stubFetch(() => json(tokens));
		let paste!: (value: string) => void;
		const { result, url } = await startLogin({
			onManualCodeInput: () =>
				new Promise<string>((resolve) => {
					paste = resolve;
				}),
		});
		paste(`${REDIRECT_URI}?code=pasted&state=${url.searchParams.get("state")}`);
		assert.equal((await result).access, "at_1");
		assert.equal(new URLSearchParams(String(calls[0].init?.body)).get("code"), "pasted");
	});

	test("cancelling the paste prompt cancels sign-in and frees the callback port", async () => {
		stubFetch(() => json(tokens));
		const { result } = await startLogin({ onManualCodeInput: () => Promise.reject(new Error("Login cancelled")) });
		await assert.rejects(result, /Login cancelled/);

		const again = await startLogin();
		assert.equal(await browserRedirect({ code: "code_3", state: again.url.searchParams.get("state") ?? "" }), 200);
		assert.equal((await again.result).access, "at_1");
	});

	test("falls back to a pasted redirect URL when the callback port is taken", async () => {
		stubFetch(() => json(tokens));
		const squatter = createServer(() => {});
		await new Promise<void>((resolve) => squatter.listen(51789, "127.0.0.1", resolve));
		try {
			let paste!: (value: string) => void;
			const { result, url } = await startLogin({
				onManualCodeInput: () =>
					new Promise<string>((resolve) => {
						paste = resolve;
					}),
			});
			paste(`${REDIRECT_URI}?code=by-hand&state=${url.searchParams.get("state")}`);
			assert.equal((await result).access, "at_1");
		} finally {
			squatter.close();
		}
	});

	test("reports token endpoint errors", async () => {
		stubFetch(() => json({ error: "invalid_grant", error_description: "code expired" }, 400));
		const { result, url } = await startLogin();
		await browserRedirect({ code: "stale", state: url.searchParams.get("state") ?? "" });
		await assert.rejects(result, /token exchange failed \(400\): invalid_grant: code expired/);
	});

	test("refreshes with the rotated refresh token and requires one back", async () => {
		const calls = stubFetch(() => json({ ...tokens, access_token: "at_2", refresh_token: "rt_2" }));
		const refreshed = await chutesOAuth.refreshToken({ access: "at_1", refresh: "rt_1", expires: 0 });
		assert.equal(refreshed.access, "at_2");
		assert.equal(refreshed.refresh, "rt_2");
		const form = new URLSearchParams(String(calls[0].init?.body));
		assert.equal(form.get("grant_type"), "refresh_token");
		assert.equal(form.get("refresh_token"), "rt_1");

		stubFetch(() => json({ access_token: "at_3", expires_in: 3600 }));
		await assert.rejects(chutesOAuth.refreshToken({ access: "at_2", refresh: "rt_2", expires: 0 }), /missing tokens/);
	});

	test("uses the access token as the API key", () => {
		assert.equal(chutesOAuth.getApiKey({ access: "at_9", refresh: "rt_9", expires: 0 }), "at_9");
	});
});
