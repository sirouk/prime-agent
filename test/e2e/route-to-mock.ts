// Points the chutes provider at the mock server; its models are kept.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("chutes", { baseUrl: process.env.CHUTES_E2E_BASE_URL });
}
