// Drives /endpoints through `prime-agent --mode rpc`, answering its dialogs the way
// a user would: add an endpoint, take the handoff to Prime Agent's model picker,
// switch there, chat through it, disable and enable it, then remove it from the menu. Run it inside the suite's
// isolated environment. The endpoint must list models m1 and m2 and accept the
// key sk-e2e; the config must already hold a "seed" endpoint with "seed-model",
// which the session starts on.
//
// Usage: node endpoints-command.mjs <prime-agent> <endpoint base URL>
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [agentBin, baseUrl] = process.argv.slice(2);
const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
const child = spawn(agentBin, ["--mode", "rpc", "--no-session", "--provider", "seed", "--model", "seed-model"], {
	stdio: ["pipe", "pipe", "inherit"],
});

const messages = [];
let waiters = [];
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	// Split on \n only: RPC output is JSON Lines, and JSON may contain U+2028.
	for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
		const line = buffer.slice(0, end).replace(/\r$/, "");
		buffer = buffer.slice(end + 1);
		if (!line.trim()) continue;
		const message = JSON.parse(line);
		if (message.type === "extension_error") {
			fail(`extension error: ${message.error}`);
		}
		messages.push(message);
		for (const waiter of [...waiters]) waiter();
	}
});
child.on("exit", (code) => {
	if (!closing) fail(`prime-agent exited early with code ${code}`);
});

let closing = false;
function fail(reason) {
	console.error(`FAIL ${reason}`);
	child.kill();
	process.exit(1);
}

function send(message) {
	child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitFor(what, matches, timeoutMs = 30_000) {
	return new Promise((resolve) => {
		const check = () => {
			const index = messages.findIndex(matches);
			if (index < 0) return;
			const [message] = messages.splice(index, 1);
			clearTimeout(timer);
			waiters = waiters.filter((waiter) => waiter !== check);
			resolve(message);
		};
		const timer = setTimeout(() => fail(`timed out waiting for ${what}`), timeoutMs);
		waiters.push(check);
		check();
	});
}

async function request(type, fields = {}) {
	const id = `${type}-${Math.random().toString(36).slice(2)}`;
	send({ id, type, ...fields });
	const response = await waitFor(`the ${type} response`, (m) => m.type === "response" && m.id === id);
	if (!response.success) fail(`${type} failed: ${response.error}`);
	return response.data;
}

/** Waits for a dialog whose title starts with `title` and answers it. */
async function answer(method, title, reply) {
	const dialog = await waitFor(
		`the ${method} dialog "${title}"`,
		(m) => m.type === "extension_ui_request" && m.method === method && m.title.startsWith(title),
	);
	const response = typeof reply === "function" ? reply(dialog) : reply;
	send({ type: "extension_ui_response", id: dialog.id, ...response });
	return dialog;
}

/** The editor text an extension leaves for the user, e.g. a `/model` command. */
function editorText(text) {
	return waitFor(`the editor text "${text}"`, (m) => m.type === "extension_ui_request" && m.method === "set_editor_text" && m.text === text);
}

function notice(message) {
	return waitFor(`the notice "${message}"`, (m) => m.type === "extension_ui_request" && m.method === "notify" && m.message.startsWith(message));
}

function check(condition, reason) {
	if (!condition) fail(reason);
}

const commands = await request("get_commands");
check(commands.commands.some((command) => command.name === "endpoints"), "/endpoints is not registered");

// Add an endpoint; it leaves `/model gpu-box` for Prime Agent's picker.
send({ type: "prompt", message: "/endpoints add" });
await answer("input", "Endpoint URL", { value: baseUrl });
await answer("input", "API key", { value: "sk-e2e" });
await answer("input", "Name", { value: "GPU Box" });
await editorText("/model gpu-box");
await notice("Added GPU Box with 2 models. Press Enter to choose one.");
// RPC has no picker; set_model is the command the picker's choice runs.
await request("set_model", { provider: "gpu-box", modelId: "m2" });
const state = await request("get_state");
check(state.model?.provider === "gpu-box" && state.model?.id === "m2", `model is ${state.model?.provider}/${state.model?.id}`);
const saved = JSON.parse(readFileSync(join(agentDir, "endpoints.json"), "utf8")).endpoints;
check(saved.some((e) => e.id === "gpu-box" && e.baseUrl === baseUrl && e.enabled === true), "the endpoint was not saved");
check(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))["gpu-box"]?.key === "sk-e2e", "the key was not saved");
console.log("ok   adds an endpoint and hands model choice to Prime Agent's picker");

// Chat through the endpoint that was just added.
send({ type: "prompt", message: "Reply with pong" });
await waitFor("the end of the reply", (m) => m.type === "agent_end");
console.log("ok   chats through the endpoint's model");

// The menu hands off to the picker too.
send({ type: "prompt", message: "/endpoints" });
await answer("select", "Endpoints", (dialog) => ({ value: dialog.options.find((option) => option.startsWith("GPU Box [gpu-box]")) }));
await answer("select", "GPU Box [gpu-box]", { value: "Choose one of its models" });
await editorText("/model gpu-box");
await notice("Press Enter to choose one of GPU Box's models.");
console.log("ok   offers the picker for an endpoint from the menu");

// Disable hides its models; enabling brings them back.
const models = async () => (await request("get_available_models")).models.filter((m) => m.provider === "gpu-box").map((m) => m.id);
send({ type: "prompt", message: "/endpoints disable gpu-box" });
await notice("GPU Box disabled.");
check((await models()).length === 0, "a disabled endpoint's models are still available");
send({ type: "prompt", message: "/endpoints enable gpu-box" });
await notice("GPU Box enabled with 2 models.");
check(JSON.stringify(await models()) === JSON.stringify(["m1", "m2"]), `models after enabling: ${JSON.stringify(await models())}`);
console.log("ok   disables and enables the endpoint");

// Remove it from the menu.
send({ type: "prompt", message: "/endpoints" });
await answer("select", "Endpoints", (dialog) => ({ value: dialog.options.find((option) => option.startsWith("GPU Box [gpu-box]")) }));
await answer("select", "GPU Box [gpu-box]", { value: "Remove" });
await answer("confirm", "Remove GPU Box?", { confirmed: true });
await notice("GPU Box removed.");
check(!JSON.parse(readFileSync(join(agentDir, "endpoints.json"), "utf8")).endpoints.some((e) => e.id === "gpu-box"), "still saved");
check(!("gpu-box" in JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))), "the key was not deleted");
check((await models()).length === 0, "a removed endpoint's models are still available");
console.log("ok   removes the endpoint and its key from the menu");

closing = true;
child.stdin.end();
const code = await new Promise((resolve) => child.on("exit", resolve));
process.exit(code === 0 ? 0 : 1);
