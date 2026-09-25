# Prime Agent extensions: custom endpoints and Chutes

Two extensions for [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent):

- **Custom endpoints** (`extensions/endpoints.ts`): add any OpenAI-compatible endpoint that uses an API key, then switch between endpoints in Prime Agent's model picker.
- **Chutes** (`extensions/chutes.ts`): [Chutes](https://chutes.ai) as a model provider, with "Sign in with Chutes".

Both use only Prime Agent's public extension API, so they run on unmodified Prime Agent releases, both the npm install and the compiled binary.

## Install

```sh
curl -fsSL https://sirouk.github.io/prime-agent/install.sh | sh
```

The installer:

1. downloads the extensions and checks them against their published SHA-256 before changing anything;
2. installs or updates Prime Agent with Prime Agent's own installer, from its official release channel;
3. removes an earlier Chutes build of Prime Agent (versions like `0.9.4-chutes.3`) if one is on your `PATH`;
4. saves the extensions in `~/.prime/agent/extensions/`, where Prime Agent loads them automatically.

It always installs the endpoints extension. It installs the Chutes extension as well when you ask for it, when it is already installed, or when it replaces an earlier Chutes build:

```sh
curl -fsSL https://sirouk.github.io/prime-agent/install.sh | PRIME_AGENT_WITH_CHUTES=1 sh
```

Run the installer again at any time to update everything. If you already have Prime Agent, you can also download an extension by itself:

```sh
mkdir -p ~/.prime/agent/extensions
curl -fsSL https://sirouk.github.io/prime-agent/extensions/endpoints.ts -o ~/.prime/agent/extensions/endpoints.ts
```

## Custom endpoints

The endpoints extension adds any OpenAI-compatible endpoint that uses an API key, such as a hosted provider, a gateway, or your own vLLM, Ollama or LM Studio server. Run `/endpoints` in Prime Agent:

- **Add an endpoint**: enter its URL (usually ending in `/v1`), its API key (leave it empty if the endpoint needs none) and a name. The endpoint is checked by listing its models and saved. `/model <id>` is then left in the input line: press Enter to choose one of its models in Prime Agent's model picker.
- **Pick an endpoint** to choose one of its models (again through the model picker), disable or enable it, refresh its models, change its API key or URL, or remove it. A disabled endpoint keeps its settings and key, but its models are hidden.

Endpoint models are ordinary Prime Agent models, so `/model` lists them next to all the others, and `/model <id>` searches for one endpoint's models. Shortcuts take the id shown in brackets in the `/endpoints` list: `/endpoints add`, `/endpoints enable <id>`, `/endpoints disable <id>`, `/endpoints refresh <id>`, `/endpoints remove <id>`.

Endpoints are saved in `~/.prime/agent/endpoints.json`, which you can also edit by hand. API keys are saved in Prime Agent's credential store, so `/login` and `/logout` work for these endpoints too. A key can also come from an environment variable named after the id: `TOGETHER_API_KEY` for `together`, `MY_GPU_API_KEY` for `my-gpu`. With no key at all, the endpoint's models are still listed and requests fail with an authentication error until you add one.

Models come from each endpoint's `GET /models` list. It is cached in `~/.prime/agent/endpoints/` and refreshed in the background when a session starts, once it is more than an hour old. Name, context size, output limit, image input, reasoning and tool support are read when the endpoint reports them, as Chutes, OpenRouter and vLLM do, or in `display_name`, `max_output_tokens` and `input_modalities` fields. Reasoning is taken only from what the endpoint states (`supports_reasoning`, `reasoning: true`, `reasoning: { supported: true }` or a listed `reasoning` capability), never from model names, and an explicit `false` wins.

Servers that describe their loaded model in `GET /status`, such as Unsloth, add its reasoning controls and context size there. Prime Agent's thinking levels are then limited to the effort levels the server lists, and for servers that also need `enable_thinking`, requests carry it next to `reasoning_effort` (`false` for off, `true` otherwise).

After the server changes, for example when it loads another model, run `/endpoints refresh <id>` and pick the model again in `/model`: a model already in use keeps its old settings until it is chosen again. A model picker opened with Ctrl+L or a plain `/model` can take up to a minute to show newly added or refreshed models, because Prime Agent caches its model list; `/model <id>` always shows the current list. Otherwise Prime Agent's defaults for custom models apply: a 128,000-token context and a 16,384-token output limit. You can set `contextWindow` and `maxTokens` on an endpoint in `endpoints.json` to override them. Prices are not read, because endpoints report them in different units, so usage through these endpoints is not priced.

## Chutes

The Chutes extension adds [Chutes](https://chutes.ai) as a model provider:

- **Sign in with Chutes** in `/login`. Inference is billed to the signed-in Chutes account.
- **`CHUTES_API_KEY`** as an alternative to signing in.
- **Chutes' live model catalog**: every Chutes model that supports tool calling, with its context size, output limit, prices, image input and reasoning settings.

Start `prime-agent`, run `/login` and choose **Chutes (Sign in with Chutes)**. A browser window opens; if the browser runs on another machine, paste the final redirect URL into Prime Agent instead. Alternatively, export `CHUTES_API_KEY` before starting Prime Agent. Then pick a Chutes model with `/model`, or from the command line:

```sh
prime-agent model list chutes
prime-agent --provider chutes --model moonshotai/Kimi-K3-TEE
```

### Coming from the earlier Chutes build

Rerun the install command. It replaces the earlier build and installs the Chutes extension. The provider id (`chutes`) and model ids are unchanged, so your Chutes sign-in and your saved default model keep working.

### Model catalog

Models come from `https://llm.chutes.ai/v1/models` and are cached in `~/.prime/agent/chutes-models-cache.json`. Prime Agent starts from the cache and refreshes it in the background when it is more than an hour old. Only the very first start waits for the network. With `--offline` (or `PI_OFFLINE=1`) the cache is used as is. If the catalog cannot be loaded and nothing is cached, sign-in still works and Prime Agent shows a warning; restart to try again.

## Development

```sh
npm install      # includes the Prime Agent release whose API the extensions are checked against
npm run check    # typecheck
npm test         # unit tests
test/e2e-endpoints.sh "$(command -v prime-agent)"   # end-to-end, inside a real Prime Agent (npm build or binary)
test/e2e-chutes.sh "$(command -v prime-agent)"
```

The end-to-end suites run each scenario in a throwaway home directory with its own background-service socket, so they never touch your `~/.prime`. The Chutes suite needs network access for its live catalog check.

On every push to `extensions`, [CI](.github/workflows/extensions.yml) runs all of the above against Prime Agent's latest release (npm build and compiled binary), tests the installer, and publishes `install.sh` and both extensions to GitHub Pages. A daily run repeats the tests to catch a Prime Agent release that breaks an extension.
