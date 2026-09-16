// OpenAI-compatible stand-in for llm.chutes.ai: logs each request as a JSON line
// and streams a fixed reply. Prints the port it listens on.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const logPath = process.argv[2];

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
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.write(chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]));
		response.write(chunk([{ index: 0, delta: { content: "pong from mock chutes" }, finish_reason: null }]));
		response.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
		response.write(chunk([], { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
		response.end("data: [DONE]\n\n");
	});
});

server.listen(0, "127.0.0.1", () => {
	console.log(server.address().port);
});
