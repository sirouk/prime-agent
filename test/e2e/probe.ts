// Checks, from inside Prime Agent, that "Sign in with Chutes" is registered for
// /login and that its callback server completes a login in this runtime. Only
// the token endpoint is stubbed.
import { writeFileSync } from "node:fs";
import { get } from "node:http";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const provider = ctx.modelRegistry.authStorage.getOAuthProviders().find((candidate) => candidate.id === "chutes");
		const report: Record<string, unknown> = {
			registered: Boolean(provider),
			name: provider?.name,
			usesCallbackServer: provider?.usesCallbackServer,
		};
		if (provider) {
			const realFetch = globalThis.fetch;
			let tokenRequest = "";
			globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				if (String(input) !== "https://api.chutes.ai/idp/token") return realFetch(input, init);
				tokenRequest = String(init?.body);
				return new Response(JSON.stringify({ access_token: "at_probe", refresh_token: "rt_probe", expires_in: 3600 }));
			}) as typeof fetch;
			try {
				const credentials = await provider.login({
					onAuth: ({ url }) => {
						const state = new URL(url).searchParams.get("state") ?? "";
						const callback = `http://127.0.0.1:51789/auth/chutes/callback?code=probe&state=${encodeURIComponent(state)}`;
						get(callback, { agent: false }, (response) => {
							report.callbackStatus = response.statusCode;
							response.resume();
						});
					},
					onPrompt: async () => {
						throw new Error("unexpected prompt");
					},
				});
				report.access = credentials.access;
				report.grant = new URLSearchParams(tokenRequest).get("grant_type");
			} catch (error) {
				report.loginError = String(error);
			} finally {
				globalThis.fetch = realFetch;
			}
		}
		writeFileSync(process.env.CHUTES_E2E_PROBE_OUT ?? "probe.json", JSON.stringify(report));
	});
}
