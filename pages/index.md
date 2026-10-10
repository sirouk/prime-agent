# Prime Agent endpoints

```sh
curl -fsSL https://sirouk.github.io/prime-agent/install.sh | sh
```

This installs [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) from its official release channel and adds `prime-agent-endpoints`, a helper that adds and manages OpenAI-compatible endpoints with API keys. Run `prime-agent-endpoints add <url>`, then choose the endpoint's models with `/model` in Prime Agent. Run the same command again to update.

Prime Agent v0.10.0 has no extension system, so this is a command-line helper that edits Prime Agent's `models.json` and `auth.json`, not a plugin.

Source and details: [sirouk/prime-agent, `extensions` branch](https://github.com/sirouk/prime-agent/tree/extensions).
