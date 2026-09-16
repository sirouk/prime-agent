# Chutes for Prime Agent

A [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) extension that adds [Chutes](https://chutes.ai) as a model provider:

- **Sign in with Chutes** in `/login`. Inference is billed to the signed-in Chutes account.
- **`CHUTES_API_KEY`** as an alternative to signing in.
- **Chutes' live model catalog**: every Chutes model that supports tool calling, with its context size, output limit, prices, image input and reasoning settings.

It uses only Prime Agent's public extension API, so it runs on unmodified Prime Agent releases, both the npm install and the compiled binary.

## Install

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

## Use

Start `prime-agent`, run `/login` and choose **Chutes (Sign in with Chutes)**. A browser window opens; if the browser runs on another machine, paste the final redirect URL into Prime Agent instead. Alternatively, export `CHUTES_API_KEY` before starting Prime Agent.

Pick a Chutes model with `/model`, or from the command line:

```sh
prime-agent model list chutes
prime-agent --provider chutes --model moonshotai/Kimi-K3-TEE
```

### Coming from the earlier Chutes build

The provider id (`chutes`) and model ids are unchanged, so your Chutes sign-in and your saved default model keep working after switching. Rerunning the install command is the only step.

### Model catalog

Models come from `https://llm.chutes.ai/v1/models` and are cached in `~/.prime/agent/chutes-models-cache.json`. Prime Agent starts from the cache and refreshes it in the background when it is more than an hour old. Only the very first start waits for the network. With `--offline` (or `PI_OFFLINE=1`) the cache is used as is. If the catalog cannot be loaded and nothing is cached, sign-in still works and Prime Agent shows a warning; restart to try again.

### Other OpenAI-compatible endpoints

Prime Agent supports those without an extension: list them in `~/.prime/agent/models.json`, as described in [Prime Agent's custom models docs](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/models.md).

## Development

```sh
npm install      # includes the Prime Agent release whose API the extension is checked against
npm run check    # typecheck
npm test         # unit tests
test/e2e.sh "$(command -v prime-agent)"   # end-to-end, inside a real Prime Agent (npm build or binary)
```

`test/e2e.sh` runs each scenario in a throwaway home directory and its own background-service socket, so it never touches your `~/.prime`. It needs network access for the live catalog check.

On every push to `chutes-extension`, [CI](.github/workflows/chutes-extension.yml) runs all of the above against Prime Agent's latest release (npm build and compiled binary), tests the installer, and publishes `install.sh` and `extensions/chutes.ts` to GitHub Pages. A daily run repeats the tests to catch a Prime Agent release that breaks the extension.
