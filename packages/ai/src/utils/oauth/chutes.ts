/**
 * Chutes OAuth flow ("Sign in with Chutes")
 *
 * Authorization Code + PKCE (S256) against the Chutes IDP. The resulting access
 * token is a first-class Chutes credential: it is accepted verbatim as the
 * bearer token by the same OpenAI-compatible endpoint the API-key path uses
 * (https://llm.chutes.ai/v1), so no model/baseUrl rewriting is needed. Inference
 * is billed to the signed-in user's own Chutes account via the `chutes:invoke`
 * scope.
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import type { Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.js";

type CallbackServerInfo = {
	server: Server;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

export const CHUTES_CLIENT_ID = "cid_vvdp89s5y9bj94rciuq5mmhz";

/**
 * Chutes issues a `client_secret` for every registered OAuth app, including
 * public/native ones (`client_secret_hash` is non-nullable server-side), and the
 * token endpoint rejects a pure-PKCE exchange with `invalid_client`. Per RFC 8252
 * (OAuth 2.0 for Native Apps) a distributed CLI cannot keep a secret, so this
 * value is deliberately NOT treated as one - it is a public client identifier,
 * checked into a public repository on purpose.
 *
 * The actual protections on this client are:
 *   - PKCE S256, so an intercepted authorization code is useless without the
 *     verifier that never leaves this process, and
 *   - the client's registered redirect URIs, which are localhost-only, so a code
 *     can only ever be delivered back to the machine that started the flow.
 *
 * If Chutes makes the secret optional for public clients, this constant can be
 * deleted; the token endpoint ignores the parameter when no secret hash is set.
 */
const CHUTES_CLIENT_SECRET = "csc_9YU1hMv5316XbkztDIognNFSo4PjuBCfvMV173UgGFIkli7t";

const AUTHORIZE_URL = "https://api.chutes.ai/idp/authorize";
const TOKEN_URL = "https://api.chutes.ai/idp/token";
const REVOKE_URL = "https://api.chutes.ai/idp/token/revoke";
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 51789;
const CALLBACK_PATH = "/auth/chutes/callback";
/** Registered with the Chutes IDP for both `localhost` and `127.0.0.1`. */
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = "openid profile chutes:invoke";
/** Refresh a little early so an in-flight request never races the expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Chutes OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

function randomUrlSafeToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") details.push(`cause=${formatErrorDetails(error.cause)}`);
		return details.join("; ");
	}
	return String(error);
}

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();

	return new Promise((resolve, reject) => {
		let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
		const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = createServer((req, res) => {
			try {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					const description = url.searchParams.get("error_description");
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Chutes authentication did not complete.", description ?? `Error: ${error}`));
					return;
				}

				if (!code || !state) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}

				if (state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("State mismatch."));
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml("Chutes authentication completed. You can close this window."));
				settleWait?.({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({
				server,
				cancelWait: () => {
					settleWait?.(null);
				},
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	token_type?: string;
	scope?: string;
	error?: string;
	error_description?: string;
};

/** The Chutes IDP token endpoint is form-encoded (`client_secret_post`). */
async function postTokenRequest(params: Record<string, string>, context: string): Promise<OAuthCredentials> {
	let response: Response;
	try {
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({ ...params, client_secret: CHUTES_CLIENT_SECRET }),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (error) {
		throw new Error(`Chutes ${context} request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	const responseBody = await response.text();

	let data: TokenResponse;
	try {
		data = JSON.parse(responseBody) as TokenResponse;
	} catch (error) {
		throw new Error(
			`Chutes ${context} returned invalid JSON. url=${TOKEN_URL}; status=${response.status}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	if (!response.ok || data.error) {
		const detail = data.error_description ? `${data.error}: ${data.error_description}` : (data.error ?? responseBody);
		throw new Error(`Chutes ${context} failed (${response.status}): ${detail}`);
	}

	if (!data.access_token || !data.refresh_token) {
		throw new Error(`Chutes ${context} response is missing tokens. body=${responseBody}`);
	}

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + (data.expires_in ?? 3600) * 1000 - EXPIRY_SKEW_MS,
		...(data.scope ? { scope: data.scope } : {}),
	};
}

/**
 * Login with Chutes OAuth (authorization code + PKCE).
 */
export async function loginChutes(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
}): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const state = randomUrlSafeToken();
	const server = await startCallbackServer(state);

	let code: string | undefined;

	const applyManualInput = (input: string): void => {
		const parsed = parseAuthorizationInput(input);
		if (parsed.state && parsed.state !== state) {
			throw new Error("OAuth state mismatch");
		}
		code = parsed.code;
	};

	try {
		const authParams = new URLSearchParams({
			response_type: "code",
			client_id: CHUTES_CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			scope: SCOPES,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});

		options.onAuth({
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Sign in with your Chutes account in the browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		if (options.onManualCodeInput) {
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();

			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				code = result.code;
			} else if (manualInput) {
				applyManualInput(manualInput);
			}

			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualInput) {
					applyManualInput(manualInput);
				}
			}
		} else {
			const result = await server.waitForCode();
			if (result?.code) {
				code = result.code;
			}
		}

		if (!code) {
			applyManualInput(
				await options.onPrompt({
					message: "Paste the authorization code or full redirect URL:",
					placeholder: REDIRECT_URI,
				}),
			);
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		options.onProgress?.("Exchanging authorization code for tokens...");
		return await postTokenRequest(
			{
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				client_id: CHUTES_CLIENT_ID,
				code_verifier: verifier,
			},
			"token exchange",
		);
	} finally {
		server.server.close();
	}
}

/**
 * Refresh a Chutes OAuth token. Refresh tokens are single-use: the IDP returns a
 * new one on every refresh, so the returned credentials must be persisted.
 */
export async function refreshChutesToken(refreshToken: string): Promise<OAuthCredentials> {
	return postTokenRequest(
		{
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CHUTES_CLIENT_ID,
		},
		"token refresh",
	);
}

/**
 * Best-effort revocation of a Chutes token (used on logout). Never throws.
 */
export async function revokeChutesToken(token: string): Promise<boolean> {
	try {
		const response = await fetch(REVOKE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				token,
				client_id: CHUTES_CLIENT_ID,
				client_secret: CHUTES_CLIENT_SECRET,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export const chutesOAuthProvider: OAuthProviderInterface = {
	id: "chutes",
	name: "Chutes (Sign in with Chutes)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginChutes({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshChutesToken(credentials.refresh);
	},

	// Chutes access tokens are accepted verbatim as the bearer credential by
	// https://llm.chutes.ai/v1, which is where the `chutes` models already point.
	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
