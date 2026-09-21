// OpenAI-compatible stand-in. GET /v1/models lists the --models ids; POST
// /v1/chat/completions streams a fixed reply; GET /v1/status returns --status
// (JSON), like an Unsloth server, or 404 without it. Every request is logged as a
// JSON line. With --key, all answer 401 unless "Authorization: Bearer <key>" is sent.
// Prints the port it listens on.
//
// Usage: node mock-openai.mjs <log file> [--models a,b] [--key secret] [--status json]
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { models: { type: "string", default: "" }, key: { type: "string" }, status: { type: "string" } },
});
const [logPath] = positionals;
const models = values.models.split(",").filter(Boolean);

const chunk = (choices, extra = {}) =>
	`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices, ...extra })}\n\n`;

const server = createServer((request, response) => {
	let body = "";
	request.on("data", (part) => {
		body += part;
	});
	request.on("end", () => {
		appendFileSync(
			logPath,
			`${JSON.stringify({
				method: request.method,
				url: request.url,
				authorization: request.headers.authorization,
				body: body ? JSON.parse(body) : null,
			})}\n`,
		);
		if (values.key && request.headers.authorization !== `Bearer ${values.key}`) {
			response.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"invalid api key"}');
		} else if (request.method === "GET" && request.url === "/v1/status" && values.status) {
			response.writeHead(200, { "Content-Type": "application/json" }).end(values.status);
		} else if (request.method === "GET" && request.url === "/v1/models") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model", max_model_len: 32768 })) }));
		} else if (request.method === "POST" && request.url === "/v1/chat/completions") {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write(chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]));
			response.write(chunk([{ index: 0, delta: { content: "pong from mock" }, finish_reason: null }]));
			response.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
			response.write(chunk([], { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
			response.end("data: [DONE]\n\n");
		} else {
			response.writeHead(404).end();
		}
	});
});

server.listen(0, "127.0.0.1", () => {
	console.log(server.address().port);
});
