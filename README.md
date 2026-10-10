# Prime Agent endpoints

`prime-agent-endpoints` adds and manages OpenAI-compatible endpoints for [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent): a hosted provider, a gateway, or your own vLLM, Ollama, LM Studio or Unsloth server. Their models then appear in Prime Agent's `/model` picker next to all the others.

It is a command-line helper, not a plugin. Prime Agent v0.10.0 removed its extension system ([#3189](https://github.com/PrimeIntellect-ai/prime-agent/pull/3189)), so nothing can run inside Prime Agent any more. The helper uses what remains: it writes providers into `~/.prime/agent/models.json` and keys into `~/.prime/agent/auth.json`, the same files Prime Agent reads.

## Install

```sh
curl -fsSL https://sirouk.github.io/prime-agent/install.sh | sh
```

The installer:

1. downloads the helper and checks it against its published SHA-256 before changing anything;
2. installs or updates Prime Agent with Prime Agent's own installer, from its official release channel;
3. removes an earlier Chutes build of Prime Agent (versions like `0.9.4-chutes.3`) if one is on your `PATH`;
4. installs `prime-agent-endpoints` next to `prime-agent` (`~/.local/bin`);
5. removes the endpoints and Chutes extensions an earlier version of this installer saved in `~/.prime/agent/extensions/`, which Prime Agent v0.10.0 no longer loads (a file you wrote yourself is left alone), and carries your saved endpoints over to `models.json`.

Run it again at any time to update. The helper needs Python 3.9 or newer, or uv, which Prime Agent's installer provides.

## Use

```sh
prime-agent-endpoints add https://api.together.xyz/v1 --name Together
prime-agent-endpoints list
prime-agent-endpoints refresh [id]
prime-agent-endpoints disable <id>      # hides its models, keeps its settings and key
prime-agent-endpoints enable <id>
prime-agent-endpoints key <id>          # save a new key; --remove deletes it
prime-agent-endpoints url <id> <url>
prime-agent-endpoints remove <id>
prime-agent-endpoints                   # a menu, in a terminal
```

`add` lists the endpoint's models to check the URL and key before saving anything, and asks for the key without echoing it. In scripts, pass it with `--key-stdin` or `--key-env NAME`, or `--no-key` for an endpoint that needs none. `--id` sets the provider id used in `/model` (default: derived from `--name`), and `--context-window` and `--max-tokens` fill in limits the endpoint does not report.

Then, in Prime Agent, `/model <id>` shows that endpoint's models. A Prime Agent that is already running reads `models.json` when it refreshes its model list: restart it, or run `/reload`, if a change is not in `/model` yet.

### What is saved, and where

| File in `~/.prime/agent/` | Contents |
| --- | --- |
| `endpoints.json` | Your endpoints: id, name, URL, enabled, optional `contextWindow` and `maxTokens`. You can edit it by hand and run `prime-agent-endpoints sync`. |
| `endpoints/<id>.models.json` | The model list each endpoint last reported. |
| `models.json` | A provider block per enabled endpoint, regenerated from the two above. Other providers in the file are left alone. Comments are dropped when the file is rewritten; the original is kept once as `models.json.before-endpoints`. |
| `auth.json` | API keys, as Prime Agent's own credential store, so `/login` and `/logout` work on them. The helper takes the same lock Prime Agent does. |

A key can also come from an environment variable named after the id: `TOGETHER_API_KEY` for `together`, `MY_GPU_API_KEY` for `my-gpu`. A saved key wins. With no key at all, requests go out with the variable's name as the key and fail with an authentication error.

### How models are read

Models come from each endpoint's `GET /models`. Name, context size, output limit, image input, reasoning and tool support are read where the endpoint reports them, as Chutes, OpenRouter and vLLM do, or in `display_name`, `max_output_tokens` and `input_modalities` fields. Models an endpoint says cannot call tools are skipped. Reasoning is taken only from what the endpoint states (`supports_reasoning`, `reasoning: true`, `reasoning: { supported: true }` or a listed `reasoning` capability), never from model names, and an explicit `false` wins. Otherwise Prime Agent's defaults for custom models apply: a 128,000-token context and a 16,384-token output limit. Prices are not read, because endpoints report them in different units.

Requests use the broadly compatible shape: a system message, `max_tokens`, no `store`. Where a model lists reasoning effort levels, Prime Agent's thinking levels are limited to them and sent as `reasoning_effort`.

The models are saved as the server reported them, so refresh after it changes, for example when it loads another model. Nothing refreshes in the background any more; run `prime-agent-endpoints refresh` from cron or a launch agent if you want that.

## Differences from the extension

- **No `/endpoints` command inside Prime Agent.** Run the helper in a terminal.
- **No live refresh at session start.** Refresh when the server's models change.
- **Servers that gate thinking with `enable_thinking`** (Unsloth's `reasoning_style: "enable_thinking_effort"`) get `enable_thinking` switched on or off from Prime Agent's thinking level, without the effort level. The extension sent both, using a per-request hook that Prime Agent v0.10.0 no longer has. Where one endpoint has both gated models and models with effort levels, effort levels win.
- **Chutes has no sign-in.** Add it as an endpoint with an API key: `prime-agent-endpoints add https://llm.chutes.ai/v1 --name Chutes --id chutes-api`. Use an id other than `chutes` if you signed in before: that sign-in is still in `auth.json`.

## Development

```sh
python3 -m unittest discover -s test -v                  # unit tests, with a mock endpoint
test/e2e-endpoints.sh "$(command -v prime-agent)"        # end to end, with a real Prime Agent
```

The unit tests start a mock endpoint on a local port. The end-to-end suite runs each scenario in a throwaway home directory with its own background-service socket, so it never touches your `~/.prime`.

On every push to `extensions`, [CI](.github/workflows/extensions.yml) runs both against Prime Agent's latest release, tests the installer against a clean home that has the old extensions in it, and publishes `install.sh` and the helper to GitHub Pages. A daily run repeats the tests to catch a Prime Agent release that breaks the helper.
