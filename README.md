# Chutes and custom endpoints for Prime Agent

Two [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) extensions:

- **Chutes** (`extensions/chutes.ts`), described first below.
- **Custom endpoints** (`extensions/endpoints.ts`): add any OpenAI-compatible endpoint that uses an API key and switch between them. See [Custom endpoints](#custom-endpoints).

## Chutes

The Chutes extension adds [Chutes](https://chutes.ai) as a model provider:

- **Sign in with Chutes** in `/login`. Inference is billed to the signed-in Chutes account.
- **`CHUTES_API_KEY`** as an alternative to signing in.
- **Chutes' live model catalog**: every Chutes model that supports tool calling, with its context size, output limit, prices, image input and reasoning settings.

It uses only Prime Agent's public extension API, so it runs on unmodified Prime Agent releases, both the npm install and the compiled binary.

### Install

```sh
curl -fsSL https://sirouk.github.io/prime-agent/install.sh | sh
```

The installer:

1. installs or updates Prime Agent with Prime Agent's own installer, from its official release channel;
2. removes an earlier Chutes build of Prime Agent (versions like `0.9.4-chutes.3`) if one is on your `PATH`;
3. downloads `chutes.ts`, checks it against its published SHA-256, and saves it as `~/.prime/agent/extensions/chutes.ts`, where Prime Agent loads it automatically.

Run it again at any time to update both. If you already have Prime Agent and only want the extension:

```sh
mkdir -p ~/.prime/agent/extensions
curl -fsSL https://sirouk.github.io/prime-agent/extensions/chutes.ts -o ~/.prime/agent/extensions/chutes.ts
```

### Use

Start `prime-agent`, run `/login` and choose **Chutes (Sign in with Chutes)**. A browser window opens; if the browser runs on another machine, paste the final redirect URL into Prime Agent instead. Alternatively, export `CHUTES_API_KEY` before starting Prime Agent.

Pick a Chutes model with `/model`, or from the command line:

```sh
prime-agent model list chutes
prime-agent --provider chutes --model moonshotai/Kimi-K3-TEE
```

#### Coming from the earlier Chutes build

The provider id (`chutes`) and model ids are unchanged, so your Chutes sign-in and your saved default model keep working after switching. Rerunning the install command is the only step.

#### Model catalog

Models come from `https://llm.chutes.ai/v1/models` and are cached in `~/.prime/agent/chutes-models-cache.json`. Prime Agent starts from the cache and refreshes it in the background when it is more than an hour old. Only the very first start waits for the network. With `--offline` (or `PI_OFFLINE=1`) the cache is used as is. If the catalog cannot be loaded and nothing is cached, sign-in still works and Prime Agent shows a warning; restart to try again.

## Custom endpoints

The endpoints extension adds any OpenAI-compatible endpoint that uses an API key, such as a hosted provider, a gateway, or your own vLLM, Ollama or LM Studio server, and lets you switch between the ones you added. Install it next to Prime Agent:

```sh
mkdir -p ~/.prime/agent/extensions
curl -fsSL https://sirouk.github.io/prime-agent/extensions/endpoints.ts -o ~/.prime/agent/extensions/endpoints.ts
```

Then run `/endpoints` in Prime Agent:

- **Add an endpoint**: enter its URL (usually ending in `/v1`), its API key (leave it empty if the endpoint needs none) and a name. The endpoint is checked by listing its models, then saved, and you can switch to one of its models right away.
- **Pick an endpoint** to use one of its models, disable or enable it, refresh its models, change its API key or URL, or remove it. A disabled endpoint keeps its settings and key, but its models are hidden.

Shortcuts take the id shown in brackets in the list: `/endpoints add`, `/endpoints use <id>`, `/endpoints enable <id>`, `/endpoints disable <id>`, `/endpoints refresh <id>`, `/endpoints remove <id>`.

Endpoints are saved in `~/.prime/agent/endpoints.json`, which you can also edit by hand. API keys are saved in Prime Agent's credential store, so `/login` and `/logout` work for these endpoints too. A key can also come from an environment variable named after the id: `TOGETHER_API_KEY` for `together`, `MY_GPU_API_KEY` for `my-gpu`. With no key at all, the endpoint's models are still listed and requests fail with an authentication error until you add one.

Models come from each endpoint's `GET /models` list. It is cached in `~/.prime/agent/endpoints/` and refreshed in the background when a session starts, once it is more than an hour old. Context size, output limit, image input, reasoning and tool support are read when the endpoint reports them, as Chutes, OpenRouter and vLLM do. Otherwise Prime Agent's defaults for custom models apply: a 128,000-token context and a 16,384-token output limit. You can set `contextWindow` and `maxTokens` on an endpoint in `endpoints.json` to override them. Prices are not read, because endpoints report them in different units, so usage through these endpoints is not priced.

## Development

```sh
npm install      # includes the Prime Agent release whose API the extension is checked against
npm run check    # typecheck
npm test         # unit tests
test/e2e-chutes.sh "$(command -v prime-agent)"      # end-to-end, inside a real Prime Agent (npm build or binary)
test/e2e-endpoints.sh "$(command -v prime-agent)"
```

The end-to-end suites run each scenario in a throwaway home directory with its own background-service socket, so they never touch your `~/.prime`. The Chutes suite needs network access for its live catalog check.

On every push to `chutes-extension`, [CI](.github/workflows/chutes-extension.yml) runs all of the above against Prime Agent's latest release (npm build and compiled binary), tests the installer, and publishes `install.sh` and both extensions to GitHub Pages. A daily run repeats the tests to catch a Prime Agent release that breaks an extension.
