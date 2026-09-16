/**
 * Chutes provider for Prime Agent.
 *
 * Adds Chutes (https://chutes.ai) through Prime Agent's public extension API, so
 * it runs on unmodified upstream releases:
 *
 * - Models come from Chutes' live catalog and are cached next to Prime Agent's
 *   own catalog caches. Startup only waits on the network while nothing is
 *   cached; after that, a stale cache is refreshed in the background.
 * - `/login` offers "Sign in with Chutes" (OAuth 2.0 authorization code + PKCE).
 *   Inference is billed to the signed-in account through the `chutes:invoke`
 *   scope.
 * - `CHUTES_API_KEY` works as an alternative to signing in.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "chutes";
const BASE_URL = "https://llm.chutes.ai/v1";
const CATALOG_URL = `${BASE_URL}/models`;
const CATALOG_TIMEOUT_MS = 5_000;
/** A cached catalog older than this is refreshed in the background. */
const CATALOG_MAX_AGE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

/** An entry of https://llm.chutes.ai/v1/models. Only `id` is guaranteed. */
export type CatalogEntry = {
	id: string;
	context_length?: unknown;
	max_output_length?: unknown;
	input_modalities?: unknown;
	supported_features?: unknown;
	pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown };
};

// The thinking-level contracts Prime Agent's bundled catalog applies to these model families.
const DEEPSEEK_V4_THINKING = { minimal: null, low: null, medium: null, high: "high", xhigh: "max", max: null };
const KIMI_K3_THINKING = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" };

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Reads a `{ data: [...] }` catalog payload, keeping entries that have an id. */
export function parseCatalog(payload: unknown): CatalogEntry[] {
	const data = (payload as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) {
		throw new Error("the model catalog has no data array");
	}
	return data.filter((entry): entry is CatalogEntry => typeof entry?.id === "string");
}

/** Maps a catalog entry to a model, or returns undefined for models the agent cannot drive. */
export function toModel(entry: CatalogEntry): ProviderModelConfig | undefined {
	const features = strings(entry.supported_features);
	const contextWindow = finite(entry.context_length);
	const maxTokens = finite(entry.max_output_length);
	// Prime Agent works through tool calls, so models without them are left out.
	if (!features.includes("tools") || !contextWindow || !maxTokens) {
		return undefined;
	}

	const id = entry.id.toLowerCase();
	const isDeepSeekV4 = id.includes("deepseek-v4");
	const isKimiK3 = /(^|\/)kimi-k3(-|$)/.test(id);
	return {
		id: entry.id,
		name: entry.id.slice(entry.id.lastIndexOf("/") + 1).replaceAll("-", " "),
		reasoning: features.includes("reasoning"),
		input: strings(entry.input_modalities).includes("image") ? ["text", "image"] : ["text"],
		cost: {
			input: finite(entry.pricing?.prompt) ?? 0,
			output: finite(entry.pricing?.completion) ?? 0,
			cacheRead: finite(entry.pricing?.input_cache_read) ?? 0,
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens,
		compat: {
			// Prime Agent infers these three from a chutes.ai base URL; stating them
			// keeps requests the same wherever the endpoint is reached from.
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			...(isDeepSeekV4 ? { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" } : {}),
		},
		...(isDeepSeekV4 ? { thinkingLevelMap: { ...DEEPSEEK_V4_THINKING } } : {}),
		...(isKimiK3 ? { thinkingLevelMap: { ...KIMI_K3_THINKING } } : {}),
	};
}

async function fetchCatalog(): Promise<CatalogEntry[]> {
	const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return parseCatalog(await response.json());
}

/** Next to models.json, like Prime Agent's own prime-inference-models-cache.json. */
function cachePath(): string {
	return join(getAgentDir(), "chutes-models-cache.json");
}

function readCachedCatalog(): { refreshedAt: number; entries: CatalogEntry[] } | undefined {
	try {
		const cache = JSON.parse(readFileSync(cachePath(), "utf8")) as { refreshedAt?: unknown };
		const refreshedAt = finite(cache.refreshedAt);
		return refreshedAt === undefined ? undefined : { refreshedAt, entries: parseCatalog(cache) };
	} catch {
		// Missing or unreadable: same as nothing cached.
		return undefined;
	}
}

function writeCachedCatalog(entries: CatalogEntry[]): void {
	const path = cachePath();
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify({ refreshedAt: Date.now(), data: entries })}\n`);
		renameSync(temporary, path);
	} catch {
		// The cache only saves a request on the next start; failing to write it must not drop the models.
	}
}

/** Prime Agent sets PI_OFFLINE for --offline and treats these values as on. */
function isOffline(): boolean {
	return ["1", "true", "yes"].includes(process.env.PI_OFFLINE?.toLowerCase() ?? "");
}

function describe(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

// ---------------------------------------------------------------------------
// Sign in with Chutes
// ---------------------------------------------------------------------------

const CLIENT_ID = "cid_vvdp89s5y9bj94rciuq5mmhz";
/**
 * Chutes issues a secret for every registered OAuth app, including native ones,
 * and its token endpoint rejects a PKCE-only exchange. A distributed CLI cannot
 * keep a secret (RFC 8252), so this is deliberately public. The protections are
 * PKCE, which makes an intercepted code useless without the verifier, and the
 * app's localhost-only redirect URIs.
 */
const CLIENT_SECRET = "csc_9YU1hMv5316XbkztDIognNFSo4PjuBCfvMV173UgGFIkli7t";
const AUTHORIZE_URL = "https://api.chutes.ai/idp/authorize";
const TOKEN_URL = "https://api.chutes.ai/idp/token";
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 51789;
const CALLBACK_PATH = "/auth/chutes/callback";
/** Registered with the Chutes IDP; changing it breaks sign-in. */
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = "openid profile chutes:invoke";
/** Refresh a little early so an in-flight request never races the expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

type CallbackServer = {
	close(): void;
	/** Stop waiting for the browser; waitForCode then resolves undefined. */
	cancelWait(): void;
	waitForCode(): Promise<string | undefined>;
};

function callbackPage(message: string): string {
	const text = message.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
	return `<!doctype html><meta charset="utf-8"><title>Chutes</title><p style="font:16px system-ui,sans-serif;margin:3rem">${text}</p>`;
}

function startCallbackServer(state: string): Promise<CallbackServer> {
	let settle: (code: string | undefined) => void = () => {};
	const code = new Promise<string | undefined>((resolve) => {
		settle = resolve;
	});

	const server = createServer((request, response) => {
		const reply = (status: number, message: string) => {
			response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
			response.end(callbackPage(message));
		};
		const url = new URL(request.url ?? "", "http://localhost");
		if (url.pathname !== CALLBACK_PATH) return reply(404, "Not found.");
		if (url.searchParams.get("state") !== state) return reply(400, "State mismatch.");
		const error = url.searchParams.get("error");
		if (error) return reply(400, `Chutes sign-in did not complete: ${url.searchParams.get("error_description") ?? error}`);
		const received = url.searchParams.get("code");
		if (!received) return reply(400, "Missing authorization code.");
		reply(200, "Signed in to Chutes. You can close this window.");
		settle(received);
	});

	return new Promise((resolve) => {
		server.once("error", () => {
			// The port is taken: fall back to pasting the redirect URL, like Prime Agent's built-in logins.
			settle(undefined);
			resolve({ close: () => {}, cancelWait: () => {}, waitForCode: () => code });
		});
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({ close: () => server.close(), cancelWait: () => settle(undefined), waitForCode: () => code });
		});
	});
}

/** Accepts a full redirect URL, its query string, or a bare authorization code. */
export function parseAuthorizationInput(input: string, state: string): string {
	const value = input.trim();
	let params: URLSearchParams;
	try {
		params = new URL(value).searchParams;
	} catch {
		params = new URLSearchParams(value.includes("=") ? value : `code=${encodeURIComponent(value)}`);
	}
	const returnedState = params.get("state");
	if (returnedState && returnedState !== state) {
		throw new Error("OAuth state mismatch");
	}
	const error = params.get("error");
	if (error) {
		throw new Error(`Chutes sign-in did not complete: ${params.get("error_description") ?? error}`);
	}
	const code = params.get("code");
	if (!code) {
		throw new Error("Missing authorization code");
	}
	return code;
}

/** The browser redirect, or a pasted redirect URL, whichever arrives first. */
async function receiveCode(server: CallbackServer, state: string, callbacks: OAuthLoginCallbacks): Promise<string> {
	const pasted = callbacks.onManualCodeInput?.();
	pasted?.then(server.cancelWait, server.cancelWait);

	const code = await server.waitForCode();
	if (code) {
		return code;
	}
	const input =
		(await pasted) ??
		(await callbacks.onPrompt({ message: "Paste the authorization code or full redirect URL:", placeholder: REDIRECT_URI }));
	return parseAuthorizationInput(input, state);
}

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	error?: string;
	error_description?: string;
};

/** The Chutes token endpoint takes form-encoded requests with the client secret (`client_secret_post`). */
async function requestTokens(params: Record<string, string>, action: string): Promise<OAuthCredentials> {
	let response: Response;
	try {
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({ ...params, client_secret: CLIENT_SECRET }),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (error) {
		throw new Error(`Chutes ${action} request failed: ${describe(error)}`);
	}

	const body = await response.text();
	let data: TokenResponse;
	try {
		data = JSON.parse(body) as TokenResponse;
	} catch {
		throw new Error(`Chutes ${action} failed (${response.status}): ${body.slice(0, 300)}`);
	}
	if (!response.ok || data.error) {
		const detail = data.error_description ? `${data.error}: ${data.error_description}` : (data.error ?? body.slice(0, 300));
		throw new Error(`Chutes ${action} failed (${response.status}): ${detail}`);
	}
	if (!data.access_token || !data.refresh_token) {
		throw new Error(`Chutes ${action} response is missing tokens`);
	}
	return {
		access: data.access_token,
		refresh: data.refresh_token,
		expires: Date.now() + (data.expires_in ?? 3600) * 1000 - EXPIRY_SKEW_MS,
		...(data.scope ? { scope: data.scope } : {}),
	};
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(32).toString("base64url");
	const server = await startCallbackServer(state);
	try {
		const query = new URLSearchParams({
			response_type: "code",
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			scope: SCOPES,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		callbacks.onAuth({
			url: `${AUTHORIZE_URL}?${query}`,
			instructions:
				"Sign in with your Chutes account in the browser. If the browser is on another machine, paste the final redirect URL here.",
		});
		const code = await receiveCode(server, state, callbacks);
		callbacks.onProgress?.("Exchanging authorization code for tokens...");
		return await requestTokens(
			{ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier },
			"token exchange",
		);
	} finally {
		server.close();
	}
}

export const chutesOAuth = {
	name: "Chutes (Sign in with Chutes)",
	// Not part of ProviderConfig's type, but Prime Agent reads it from the registered
	// OAuth provider to offer "paste the redirect URL" in /login.
	usesCallbackServer: true,
	login,
	// Chutes rotates refresh tokens, so every refresh returns a new one to persist.
	refreshToken: (credentials: OAuthCredentials) =>
		requestTokens({ grant_type: "refresh_token", refresh_token: credentials.refresh, client_id: CLIENT_ID }, "token refresh"),
	// llm.chutes.ai accepts the access token as the bearer key.
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default async function chutes(pi: ExtensionAPI): Promise<void> {
	const register = (entries: CatalogEntry[]) =>
		pi.registerProvider(PROVIDER_ID, {
			name: "Chutes",
			baseUrl: BASE_URL,
			api: "openai-completions",
			// Only when set: an unset name would be sent as a literal key and make
			// Chutes models look usable without credentials.
			...(process.env.CHUTES_API_KEY ? { apiKey: "CHUTES_API_KEY" } : {}),
			models: entries.flatMap((entry) => toModel(entry) ?? []),
			oauth: chutesOAuth,
		});

	const refresh = async () => {
		const entries = await fetchCatalog();
		register(entries);
		writeCachedCatalog(entries);
	};

	const cached = readCachedCatalog();
	if (cached) {
		register(cached.entries);
		if (!isOffline() && Date.now() - cached.refreshedAt > CATALOG_MAX_AGE_MS) {
			// A failed refresh keeps the cached catalog, as Prime Agent does with its own.
			refresh().catch(() => {});
		}
		return;
	}

	const failure = isOffline() ? "offline mode is on" : await refresh().then(() => undefined, describe);
	if (failure) {
		// Register anyway so "Sign in with Chutes" stays available.
		register([]);
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(
				`Chutes models are unavailable: the catalog at ${CATALOG_URL} could not be loaded (${failure}). Restart to try again.`,
				"warning",
			);
		});
	}
}
