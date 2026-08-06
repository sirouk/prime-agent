import { afterEach, describe, expect, it, vi } from "vitest";
import { CHUTES_CLIENT_ID, chutesOAuthProvider, loginChutes, refreshChutesToken } from "../src/utils/oauth/chutes.js";
import { getOAuthProvider } from "../src/utils/oauth/index.js";

const TOKEN_URL = "https://api.chutes.ai/idp/token";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getFormBody(init?: RequestInit): URLSearchParams {
	if (!(init?.body instanceof URLSearchParams)) {
		throw new Error(`Expected URLSearchParams request body, got ${typeof init?.body}`);
	}
	return init.body;
}

/** base64url(SHA-256(verifier)), per RFC 7636 section 4.2. */
async function s256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	let binary = "";
	for (const byte of new Uint8Array(digest)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

describe.sequential("Chutes OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("is registered as a built-in OAuth provider under the `chutes` provider id", () => {
		expect(getOAuthProvider("chutes")).toBe(chutesOAuthProvider);
		expect(chutesOAuthProvider.usesCallbackServer).toBe(true);
	});

	it("returns the raw access token as the API key, so it works against llm.chutes.ai", () => {
		expect(chutesOAuthProvider.getApiKey({ access: "cak_abc", refresh: "crt_abc", expires: 0 })).toBe("cak_abc");
	});

	it("builds an authorization URL with PKCE S256 and exchanges the code form-encoded", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe(TOKEN_URL);
			expect(init?.method).toBe("POST");
			const body = getFormBody(init);
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("code")).toBe("manual-code");
			expect(body.get("client_id")).toBe(CHUTES_CLIENT_ID);
			expect(body.get("redirect_uri")).toBe("http://localhost:51789/auth/chutes/callback");

			// The verifier sent here must hash to the challenge in the authorize URL.
			const verifier = body.get("code_verifier");
			expect(verifier).toBeTruthy();
			const challenge = new URL(authUrl).searchParams.get("code_challenge");
			expect(await s256(verifier as string)).toBe(challenge);

			return jsonResponse({
				access_token: "cak_access",
				refresh_token: "crt_refresh",
				expires_in: 3600,
				token_type: "Bearer",
				scope: "openid profile chutes:invoke",
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const before = Date.now();
		const credentials = await loginChutes({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const url = new URL(authUrl);
				expect(url.origin + url.pathname).toBe("https://api.chutes.ai/idp/authorize");
				expect(url.searchParams.get("response_type")).toBe("code");
				expect(url.searchParams.get("client_id")).toBe(CHUTES_CLIENT_ID);
				expect(url.searchParams.get("scope")).toBe("openid profile chutes:invoke");
				expect(url.searchParams.get("code_challenge_method")).toBe("S256");
				const state = url.searchParams.get("state");
				const redirectUri = url.searchParams.get("redirect_uri");
				// state must be its own random value, not the PKCE verifier.
				expect(state).toBeTruthy();
				expect(state).not.toBe(url.searchParams.get("code_challenge"));
				return `${redirectUri}?code=manual-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("cak_access");
		expect(credentials.refresh).toBe("crt_refresh");
		expect(credentials.scope).toBe("openid profile chutes:invoke");
		// 1h lifetime minus the 5m refresh skew.
		expect(credentials.expires).toBeGreaterThanOrEqual(before + 3600_000 - 300_000);
		expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 3600_000 - 300_000);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("rejects a callback whose state does not match the authorization request", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			throw new Error("token endpoint must not be called on a state mismatch");
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			loginChutes({
				onAuth: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () =>
					"http://localhost:51789/auth/chutes/callback?code=manual-code&state=not-the-state",
			}),
		).rejects.toThrow("OAuth state mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("surfaces the IDP error code when the token exchange is rejected", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)),
		);

		await expect(
			loginChutes({
				onAuth: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () => "http://localhost:51789/auth/chutes/callback?code=stale-code",
			}),
		).rejects.toThrow(/token exchange failed \(400\): invalid_grant/);
	});

	it("refreshes with grant_type=refresh_token and persists the rotated refresh token", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe(TOKEN_URL);
			const body = getFormBody(init);
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("crt_old");
			expect(body.get("client_id")).toBe(CHUTES_CLIENT_ID);
			expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
			return jsonResponse({
				access_token: "cak_new",
				refresh_token: "crt_new",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshChutesToken("crt_old");

		expect(credentials.access).toBe("cak_new");
		// The Chutes IDP rotates refresh tokens on every use.
		expect(credentials.refresh).toBe("crt_new");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("refreshes through the provider interface", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: "cak_new", refresh_token: "crt_new", expires_in: 3600 })),
		);

		const credentials = await chutesOAuthProvider.refreshToken({
			access: "cak_old",
			refresh: "crt_old",
			expires: 0,
		});

		expect(credentials.access).toBe("cak_new");
	});

	it("fails loudly when the token response has no tokens", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ token_type: "Bearer" })),
		);

		await expect(refreshChutesToken("crt_old")).rejects.toThrow(/missing tokens/);
	});
});
