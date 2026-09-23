/**
 * OpenAI-compatible endpoints for Prime Agent.
 *
 * `/endpoints` adds any OpenAI-compatible endpoint that takes an API key, such as
 * a hosted provider, a gateway, or a self-hosted vLLM, Ollama or LM Studio
 * server, and manages the ones you added: enable or disable them, change the key
 * or URL, refresh their models, remove them. Their models are chosen in Prime
 * Agent's own model picker.
 *
 * - Endpoints are saved in `endpoints.json` in Prime Agent's config directory.
 *   Their API keys go to Prime Agent's credential store, so `/login` and
 *   `/logout` work on them too.
 * - Models come from each endpoint's `GET /models`. The list is cached per
 *   endpoint, so startup never waits on the network, and refreshed in the
 *   background when a session starts. Context size, output limit, image input,
 *   reasoning and tool support are read where the endpoint reports them (the
 *   Chutes, OpenRouter and vLLM formats); otherwise Prime Agent's defaults for
 *   custom models apply.
 * - Servers that describe their loaded model in `GET /status` (Unsloth) add its
 *   reasoning controls and context size there; see mergeStatus.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

/** What Prime Agent uses for models.json models that leave these out. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const CATALOG_TIMEOUT_MS = 10_000;
/** A cached model list older than this is refreshed when a session starts. */
const CATALOG_MAX_AGE_MS = 60 * 60 * 1000;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Endpoint = {
	/** Provider id in /model and in the credential store, e.g. "together". */
	id: string;
	name: string;
	/** Includes the API version path, e.g. "https://api.together.xyz/v1". */
	baseUrl: string;
	enabled: boolean;
	/** For models whose context size the endpoint does not report. */
	contextWindow?: number;
	/** For models whose output limit the endpoint does not report. */
	maxTokens?: number;
};

// ---------------------------------------------------------------------------
// Saved endpoints
// ---------------------------------------------------------------------------

function configPath(): string {
	return join(getAgentDir(), "endpoints.json");
}

function isHttpUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

function parseEndpoint(value: unknown, where: string): Endpoint {
	const entry = (value ?? {}) as Record<string, unknown>;
	if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) {
		throw new Error(`${where}: "id" must be lowercase letters, digits and single dashes`);
	}
	if (typeof entry.name !== "string" || !entry.name.trim()) {
		throw new Error(`${where}: "name" is required`);
	}
	if (typeof entry.baseUrl !== "string" || !isHttpUrl(entry.baseUrl)) {
		throw new Error(`${where}: "baseUrl" must be an http or https URL`);
	}
	if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
		throw new Error(`${where}: "enabled" must be true or false`);
	}
	const endpoint: Endpoint = {
		id: entry.id,
		name: entry.name.trim(),
		baseUrl: entry.baseUrl.replace(/\/+$/, ""),
		enabled: entry.enabled !== false,
	};
	for (const field of ["contextWindow", "maxTokens"] as const) {
		const limit = entry[field];
		if (limit === undefined) continue;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
			throw new Error(`${where}: "${field}" must be a positive whole number`);
		}
		endpoint[field] = limit;
	}
	return endpoint;
}

/** Reads endpoints.json; a missing file means none. A malformed one fails with the problem named. */
export function readEndpoints(): Endpoint[] {
	let text: string;
	try {
		text = readFileSync(configPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	let parsed: { endpoints?: unknown };
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${configPath()}: ${(error as Error).message}`);
	}
	if (!Array.isArray(parsed.endpoints)) {
		throw new Error(`${configPath()}: "endpoints" must be a list`);
	}
	const endpoints = parsed.endpoints.map((value, index) => parseEndpoint(value, `${configPath()}: endpoints[${index}]`));
	const ids = new Set<string>();
	for (const { id } of endpoints) {
		if (ids.has(id)) throw new Error(`${configPath()}: the id "${id}" is used twice`);
		ids.add(id);
	}
	return endpoints;
}

function writeJsonAtomically(path: string, value: unknown): void {
	const temporary = `${path}.${process.pid}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temporary, path);
}

function writeEndpoints(endpoints: Endpoint[]): void {
	writeJsonAtomically(configPath(), { endpoints });
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** An entry of an endpoint's `GET /models` list. Only `id` is guaranteed. */
export type CatalogEntry = { id: string } & Record<string, unknown>;

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function field(entry: CatalogEntry, parent: string, key: string): unknown {
	const object = entry[parent];
	return object && typeof object === "object" ? (object as Record<string, unknown>)[key] : undefined;
}

/**
 * Reasoning support stated by the entry: `supports_reasoning`, `reasoning: true` or
 * `reasoning: { supported: true }`. An explicit false wins; undefined when silent.
 */
function statedReasoning(entry: CatalogEntry): boolean | undefined {
	const stated = [entry.supports_reasoning, entry.reasoning, field(entry, "reasoning", "supported")].filter(
		(value): value is boolean => typeof value === "boolean",
	);
	if (stated.includes(false)) return false;
	return stated.includes(true) ? true : undefined;
}

/** Prime Agent's thinking levels above "off". */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Maps Prime Agent's thinking levels onto the effort values a server lists, sent as
 * reasoning_effort. Levels it does not list are hidden (null); "off" sends "none"
 * unless the server keeps reasoning always on.
 */
export function thinkingLevelMapFor(effortLevels: string[], alwaysOn: boolean): ProviderModelConfig["thinkingLevelMap"] {
	return {
		off: alwaysOn ? null : "none",
		...Object.fromEntries(THINKING_LEVELS.map((level) => [level, effortLevels.includes(level) ? level : null])),
	};
}

/** Maps a model list entry, or returns undefined for a model the endpoint says cannot call tools. */
export function toModel(entry: CatalogEntry, endpoint: Endpoint): ProviderModelConfig | undefined {
	// Chutes lists capabilities in supported_features, OpenRouter in supported_parameters.
	const capabilities = [...strings(entry.supported_features), ...strings(entry.supported_parameters)];
	// Prime Agent works through tool calls, so drop models known to lack them.
	if (capabilities.length > 0 && !capabilities.includes("tools")) {
		return undefined;
	}
	const contextWindow =
		positive(entry.context_length) ?? positive(entry.max_model_len) ?? endpoint.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const outputLimit =
		positive(entry.max_output_length) ??
		positive(field(entry, "top_provider", "max_completion_tokens")) ??
		endpoint.maxTokens ??
		DEFAULT_MAX_TOKENS;
	const inputs = [...strings(entry.input_modalities), ...strings(field(entry, "architecture", "input_modalities"))];
	const reasoning = statedReasoning(entry) ?? capabilities.includes("reasoning");
	// Effort levels are stated flat (Unsloth: reasoning_effort_levels) or nested (reasoning.levels).
	const effortLevels = [...strings(entry.reasoning_effort_levels), ...strings(field(entry, "reasoning", "levels"))];
	const effortControl = reasoning && effortLevels.length > 0;
	return {
		id: entry.id,
		name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.id,
		reasoning,
		input: inputs.includes("image") ? ["text", "image"] : ["text"],
		// Endpoints report prices in different units, so usage is not priced.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(outputLimit, contextWindow),
		// The broadly supported request shape: a system message, max_tokens, no store. With
		// listed effort levels, thinking goes out as reasoning_effort (the default format).
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			...(effortControl ? { supportsReasoningEffort: true } : {}),
		},
		...(effortControl
			? { thinkingLevelMap: thinkingLevelMapFor(effortLevels, entry.reasoning_always_on === true) }
			: {}),
	};
}

/** Reads an OpenAI-style `{ data: [...] }` model list, keeping entries that have an id. */
export function parseCatalog(payload: unknown): CatalogEntry[] {
	const data = (payload as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) {
		throw new Error("the response is not an OpenAI-compatible model list");
	}
	return data.filter((entry): entry is CatalogEntry => typeof entry?.id === "string");
}

/** Fields of an Unsloth `GET /status` that describe the loaded model(s). */
const STATUS_FIELDS = [
	"supports_reasoning",
	"reasoning_style",
	"reasoning_effort_levels",
	"reasoning_always_on",
	"context_length",
] as const;

/**
 * Copies a server status's model metadata onto the entries it lists as loaded.
 * Unsloth's /models omits reasoning and context details that /status reports.
 */
export function mergeStatus(entries: CatalogEntry[], status: unknown): CatalogEntry[] {
	const report = (status && typeof status === "object" ? status : {}) as Record<string, unknown>;
	const loaded = new Set(strings(report.loaded));
	const metadata = Object.fromEntries(STATUS_FIELDS.filter((key) => report[key] !== undefined).map((key) => [key, report[key]]));
	if (loaded.size === 0 || Object.keys(metadata).length === 0) return entries;
	return entries.map((entry) => (loaded.has(entry.id) ? { ...entry, ...metadata } : entry));
}

/** The server's /status, when it has one; undefined otherwise, so discovery falls back to /models alone. */
async function fetchStatus(baseUrl: string, apiKey: string | undefined): Promise<unknown> {
	try {
		const response = await fetch(`${baseUrl}/status`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
		});
		return response.ok ? await response.json() : undefined;
	} catch {
		return undefined;
	}
}

async function fetchCatalog(baseUrl: string, apiKey: string | undefined): Promise<CatalogEntry[]> {
	const [entries, status] = await Promise.all([fetchModelList(baseUrl, apiKey), fetchStatus(baseUrl, apiKey)]);
	return mergeStatus(entries, status);
}

async function fetchModelList(baseUrl: string, apiKey: string | undefined): Promise<CatalogEntry[]> {
	let response: Response;
	try {
		response = await fetch(`${baseUrl}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`could not reach ${baseUrl}/models: ${describe(error)}`);
	}
	if (response.status === 401 || response.status === 403) {
		throw new Error(`${baseUrl}/models refused the API key (HTTP ${response.status})`);
	}
	if (!response.ok) {
		throw new Error(`${baseUrl}/models answered HTTP ${response.status}`);
	}
	try {
		return parseCatalog(await response.json());
	} catch (error) {
		throw new Error(`${baseUrl}/models: ${describe(error)}`);
	}
}

function cachePath(id: string): string {
	return join(getAgentDir(), "endpoints", `${id}.models.json`);
}

function readCachedCatalog(id: string): { refreshedAt: number; entries: CatalogEntry[] } | undefined {
	try {
		const cache = JSON.parse(readFileSync(cachePath(id), "utf8")) as { refreshedAt?: unknown };
		const { refreshedAt } = cache;
		if (typeof refreshedAt !== "number" || !Number.isFinite(refreshedAt)) return undefined;
		return { refreshedAt, entries: parseCatalog(cache) };
	} catch {
		// Missing or unreadable: same as nothing cached.
		return undefined;
	}
}

function writeCachedCatalog(id: string, entries: CatalogEntry[]): void {
	try {
		writeJsonAtomically(cachePath(id), { refreshedAt: Date.now(), data: entries });
	} catch {
		// The cache only saves a request on the next start; failing to write it must not lose the models.
	}
}

/** Prime Agent sets PI_OFFLINE for --offline and treats these values as on. */
function isOffline(): boolean {
	return ["1", "true", "yes"].includes(process.env.PI_OFFLINE?.toLowerCase() ?? "");
}

function describe(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

// ---------------------------------------------------------------------------
// Keys and registration
// ---------------------------------------------------------------------------

/** The environment variable that can also hold an endpoint's key, e.g. TOGETHER_API_KEY for "together". */
export function envVarFor(id: string): string {
	return `${id.toUpperCase().replaceAll("-", "_")}_API_KEY`;
}

/** The key saved in Prime Agent's credential store, else the environment variable. */
async function keyFor(ctx: ExtensionContext, id: string): Promise<string | undefined> {
	const saved = await ctx.modelRegistry.authStorage.getApiKey(id, { includeFallback: false });
	return saved || process.env[envVarFor(id)] || undefined;
}

/**
 * Models whose server gates thinking with a boolean enable_thinking next to
 * reasoning_effort ("enable_thinking_effort"), keyed "provider/id", with the effort
 * values that turn thinking on. reasoning_effort "none" alone does not turn it off.
 */
const thinkingGates = new Map<string, Set<string>>();

/**
 * Adds enable_thinking to a request for a gated model: false for effort "none", true
 * for an effort the server lists. Returns undefined to leave the payload unchanged,
 * including when enable_thinking is already set or the request is for another model.
 */
export function withThinkingGate(payload: unknown, modelId: string, enabledEfforts: ReadonlySet<string>): unknown {
	if (!payload || typeof payload !== "object") return undefined;
	const body = payload as Record<string, unknown>;
	if (body.model !== modelId || "enable_thinking" in body) return undefined;
	if (body.reasoning_effort === "none") return { ...body, enable_thinking: false };
	if (typeof body.reasoning_effort === "string" && enabledEfforts.has(body.reasoning_effort)) {
		return { ...body, enable_thinking: true };
	}
	return undefined;
}

function register(pi: ExtensionAPI, endpoint: Endpoint, entries: CatalogEntry[]): void {
	for (const key of thinkingGates.keys()) {
		if (key.startsWith(`${endpoint.id}/`)) thinkingGates.delete(key);
	}
	for (const entry of entries) {
		const model = toModel(entry, endpoint);
		if (model?.reasoning && entry.reasoning_style === "enable_thinking_effort") {
			thinkingGates.set(`${endpoint.id}/${entry.id}`, new Set(strings(entry.reasoning_effort_levels)));
		}
	}
	pi.registerProvider(endpoint.id, {
		name: endpoint.name,
		baseUrl: endpoint.baseUrl,
		api: "openai-completions",
		// A saved key wins over this. With no saved key and the variable unset, its name
		// is sent as the key: endpoints that need none ignore it, the rest reject it.
		apiKey: envVarFor(endpoint.id),
		models: entries.flatMap((entry) => toModel(entry, endpoint) ?? []),
	});
}

/** Fetches an endpoint's models, caches them and registers them if the endpoint is enabled. */
async function refreshModels(pi: ExtensionAPI, ctx: ExtensionContext, endpoint: Endpoint): Promise<number> {
	const entries = await fetchCatalog(endpoint.baseUrl, await keyFor(ctx, endpoint.id));
	if (endpoint.enabled) register(pi, endpoint, entries);
	writeCachedCatalog(endpoint.id, entries);
	return entries.filter((entry) => toModel(entry, endpoint)).length;
}

// ---------------------------------------------------------------------------
// The /endpoints command
// ---------------------------------------------------------------------------

const USAGE = "Usage: /endpoints [add | enable <id> | disable <id> | refresh <id> | remove <id>]";

function modelsOf(ctx: ExtensionContext, id: string) {
	return ctx.modelRegistry.getAll().filter((model) => model.provider === id);
}

/** One line per endpoint; the id is shown because the shortcut commands take it. */
function describeEndpoint(ctx: ExtensionContext, endpoint: Endpoint): string {
	const label = `${endpoint.name} [${endpoint.id}] · ${new URL(endpoint.baseUrl).host}`;
	if (!endpoint.enabled) return `${label} · disabled`;
	const inUse = ctx.model?.provider === endpoint.id ? " · in use" : "";
	return `${label} · ${modelsOf(ctx, endpoint.id).length} models${inUse}`;
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

async function askForUrl(ctx: ExtensionCommandContext, title: string, placeholder: string): Promise<string | undefined> {
	for (;;) {
		const answer = (await ctx.ui.input(title, placeholder))?.trim();
		if (!answer) return undefined;
		if (isHttpUrl(answer)) return answer.replace(/\/+$/, "");
		ctx.ui.notify(`"${answer}" is not an http or https URL.`, "error");
	}
}

async function addEndpoint(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const baseUrl = await askForUrl(
		ctx,
		"Endpoint URL, usually ending in /v1",
		"https://api.example.com/v1",
	);
	if (!baseUrl) return;
	const key = await ctx.ui.input("API key (leave empty if the endpoint needs none)", "");
	if (key === undefined) return;

	let entries: CatalogEntry[];
	try {
		entries = await fetchCatalog(baseUrl, key.trim() || undefined);
	} catch (error) {
		ctx.ui.notify(`Not added: ${describe(error)}`, "error");
		return;
	}

	const endpoints = readEndpoints();
	const taken = new Set([...endpoints.map((endpoint) => endpoint.id), ...ctx.modelRegistry.getAll().map((model) => model.provider)]);
	const suggested = new URL(baseUrl).host;
	let name: string;
	let id: string;
	for (;;) {
		const answer = await ctx.ui.input(`Name (leave empty for ${suggested})`, suggested);
		if (answer === undefined) return;
		name = answer.trim() || suggested;
		id = slugify(name);
		if (!id) {
			ctx.ui.notify("The name needs at least one letter or digit.", "error");
		} else if (taken.has(id)) {
			ctx.ui.notify(`"${id}" is already a provider in Prime Agent; choose another name.`, "error");
		} else {
			break;
		}
	}

	const endpoint: Endpoint = { id, name, baseUrl, enabled: true };
	writeEndpoints([...endpoints, endpoint]);
	if (key.trim()) {
		ctx.modelRegistry.authStorage.set(id, { type: "api_key", key: key.trim() });
	}
	writeCachedCatalog(id, entries);
	register(pi, endpoint, entries);

	const count = modelsOf(ctx, id).length;
	if (count === 0) {
		ctx.ui.notify(`Added ${name}, but it lists no models the agent can use.`, "warning");
		return;
	}
	openModelPicker(ctx, endpoint, `Added ${name} with ${count} models. Press Enter to choose one.`);
}

/**
 * Leaves `/model <id>` in the editor, so Enter opens Prime Agent's model picker
 * searched to this endpoint. Extensions cannot open the picker themselves, and
 * switching there, rather than with pi.setModel, keeps Prime Agent's display of
 * the current model up to date.
 */
function openModelPicker(ctx: ExtensionCommandContext, endpoint: Endpoint, message: string): void {
	ctx.ui.setEditorText(`/model ${endpoint.id}`);
	ctx.ui.notify(message, "info");
}

async function setEnabled(pi: ExtensionAPI, ctx: ExtensionCommandContext, endpoint: Endpoint, enabled: boolean): Promise<void> {
	const endpoints = readEndpoints().map((saved) => (saved.id === endpoint.id ? { ...saved, enabled } : saved));
	writeEndpoints(endpoints);
	if (!enabled) {
		pi.unregisterProvider(endpoint.id);
		const inUse = ctx.model?.provider === endpoint.id ? " It was in use; pick another model with /model." : "";
		ctx.ui.notify(`${endpoint.name} disabled.${inUse}`, inUse ? "warning" : "info");
		return;
	}
	const updated = { ...endpoint, enabled };
	register(pi, updated, readCachedCatalog(endpoint.id)?.entries ?? []);
	try {
		const count = await refreshModels(pi, ctx, updated);
		ctx.ui.notify(`${endpoint.name} enabled with ${count} models.`, "info");
	} catch (error) {
		ctx.ui.notify(`${endpoint.name} enabled, but its models could not be refreshed: ${describe(error)}`, "warning");
	}
}

async function refreshEndpoint(pi: ExtensionAPI, ctx: ExtensionCommandContext, endpoint: Endpoint): Promise<void> {
	try {
		const count = await refreshModels(pi, ctx, endpoint);
		ctx.ui.notify(`${endpoint.name}: ${count} models.`, "info");
	} catch (error) {
		ctx.ui.notify(`${endpoint.name}: ${describe(error)}`, "error");
	}
}

async function changeKey(pi: ExtensionAPI, ctx: ExtensionCommandContext, endpoint: Endpoint): Promise<void> {
	const key = await ctx.ui.input(`API key for ${endpoint.name} (leave empty to delete the saved key)`, "");
	if (key === undefined) return;
	if (key.trim()) {
		ctx.modelRegistry.authStorage.set(endpoint.id, { type: "api_key", key: key.trim() });
	} else {
		ctx.modelRegistry.authStorage.remove(endpoint.id);
	}
	await refreshEndpoint(pi, ctx, endpoint);
}

async function changeUrl(pi: ExtensionAPI, ctx: ExtensionCommandContext, endpoint: Endpoint): Promise<void> {
	const baseUrl = await askForUrl(ctx, `URL for ${endpoint.name}`, endpoint.baseUrl);
	if (!baseUrl || baseUrl === endpoint.baseUrl) return;
	const updated = { ...endpoint, baseUrl };
	let count: number;
	try {
		count = await refreshModels(pi, ctx, updated);
	} catch (error) {
		ctx.ui.notify(`URL not changed: ${describe(error)}`, "error");
		return;
	}
	writeEndpoints(readEndpoints().map((saved) => (saved.id === endpoint.id ? { ...saved, baseUrl } : saved)));
	ctx.ui.notify(`${endpoint.name} now uses ${baseUrl} (${count} models).`, "info");
}

async function removeEndpoint(pi: ExtensionAPI, ctx: ExtensionCommandContext, endpoint: Endpoint): Promise<void> {
	if (!(await ctx.ui.confirm(`Remove ${endpoint.name}?`, "Its saved API key is deleted too."))) return;
	writeEndpoints(readEndpoints().filter((saved) => saved.id !== endpoint.id));
	ctx.modelRegistry.authStorage.remove(endpoint.id);
	pi.unregisterProvider(endpoint.id);
	rmSync(cachePath(endpoint.id), { force: true });
	ctx.ui.notify(`${endpoint.name} removed.`, "info");
}

async function manageEndpoint(pi: ExtensionAPI, ctx: ExtensionCommandContext, endpoint: Endpoint): Promise<void> {
	const actions = new Map<string, () => Promise<void> | void>();
	if (endpoint.enabled && modelsOf(ctx, endpoint.id).length > 0) {
		actions.set("Choose one of its models", () =>
			openModelPicker(ctx, endpoint, `Press Enter to choose one of ${endpoint.name}'s models.`),
		);
	}
	actions.set(endpoint.enabled ? "Disable" : "Enable", () => setEnabled(pi, ctx, endpoint, !endpoint.enabled));
	actions.set("Refresh models", () => refreshEndpoint(pi, ctx, endpoint));
	actions.set("Change API key", () => changeKey(pi, ctx, endpoint));
	actions.set("Change URL", () => changeUrl(pi, ctx, endpoint));
	actions.set("Remove", () => removeEndpoint(pi, ctx, endpoint));
	const choice = await ctx.ui.select(describeEndpoint(ctx, endpoint), [...actions.keys()]);
	if (choice !== undefined) await actions.get(choice)?.();
}

export async function runEndpointsCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const [action, id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
	if (action === "add" && id === undefined) return addEndpoint(pi, ctx);

	const endpoints = readEndpoints();
	if (action === undefined) {
		const ADD = "Add an endpoint";
		const byLabel = new Map(endpoints.map((endpoint) => [describeEndpoint(ctx, endpoint), endpoint] as const));
		const choice = await ctx.ui.select("Endpoints", [...byLabel.keys(), ADD]);
		if (choice === ADD) return addEndpoint(pi, ctx);
		const endpoint = choice === undefined ? undefined : byLabel.get(choice);
		return endpoint ? manageEndpoint(pi, ctx, endpoint) : undefined;
	}

	const endpoint = endpoints.find((saved) => saved.id === id);
	const commands: Record<string, (endpoint: Endpoint) => Promise<void>> = {
		enable: (found) => setEnabled(pi, ctx, found, true),
		disable: (found) => setEnabled(pi, ctx, found, false),
		refresh: (found) => refreshEndpoint(pi, ctx, found),
		remove: (found) => removeEndpoint(pi, ctx, found),
	};
	const run = commands[action];
	if (!run || id === undefined || rest.length > 0) {
		ctx.ui.notify(USAGE, "error");
	} else if (!endpoint) {
		ctx.ui.notify(`No endpoint "${id}". Endpoints: ${endpoints.map((saved) => saved.id).join(", ") || "none yet"}.`, "error");
	} else {
		await run(endpoint);
	}
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function endpoints(pi: ExtensionAPI): void {
	for (const endpoint of readEndpoints()) {
		if (endpoint.enabled) register(pi, endpoint, readCachedCatalog(endpoint.id)?.entries ?? []);
	}

	// The event carries only the payload; ctx.model says which model the session is on.
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		const efforts = model && thinkingGates.get(`${model.provider}/${model.id}`);
		return efforts ? withThinkingGate(event.payload, model.id, efforts) : undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		if (isOffline()) return;
		for (const endpoint of readEndpoints()) {
			const cached = readCachedCatalog(endpoint.id);
			if (!endpoint.enabled || (cached && Date.now() - cached.refreshedAt < CATALOG_MAX_AGE_MS)) continue;
			// In the background, so a slow endpoint never holds up the session. On failure the
			// cached models stay, and refreshing from /endpoints shows the error.
			refreshModels(pi, ctx, endpoint).catch(() => {});
		}
	});

	pi.registerCommand("endpoints", {
		description: "Add, switch between, enable or disable, and remove OpenAI-compatible endpoints",
		handler: (args, ctx) => runEndpointsCommand(pi, ctx, args),
	});
}
