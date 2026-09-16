# Prime Agent extensions

```sh
curl -fsSL https://sirouk.github.io/prime-agent/install.sh | sh
```

This installs [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) from its official release channel and adds the endpoints extension. Start `prime-agent` and run `/endpoints` to add any OpenAI-compatible endpoint with an API key, then choose its models in `/model`. Run the same command again to update.

For [Chutes](https://chutes.ai) with "Sign in with Chutes", add the Chutes extension:

```sh
curl -fsSL https://sirouk.github.io/prime-agent/install.sh | PRIME_AGENT_WITH_CHUTES=1 sh
```

Source and details: [sirouk/prime-agent, `extensions` branch](https://github.com/sirouk/prime-agent/tree/extensions).
