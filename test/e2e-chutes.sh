#!/usr/bin/env bash
# Runs the Chutes extension inside a real Prime Agent executable: the npm
# install's `prime-agent` or the compiled binary. The first scenario needs network
# access to https://llm.chutes.ai/v1/models; the rest use a local mock.
#
# Usage: test/e2e-chutes.sh /path/to/prime-agent
set -euo pipefail
# shellcheck source=test/e2e/lib.sh
source "$(dirname "$0")/e2e/lib.sh"

extension=$root/extensions/chutes.ts
tools_models='data.data.filter((m) => (m.supported_features ?? []).includes("tools") && m.context_length && m.max_output_length)'

new_home version
echo "Prime Agent $(agent -- --version) at $agent_bin"

# 1. Installed like the installer does it: auto-discovered, catalog fetched live.
new_home discovered
cp "$extension" "$agent_dir/extensions/chutes.ts"
output=$(agent CHUTES_API_KEY=cpk_e2e -- model list chutes)
listed=$(grep -c '^chutes ' <<<"$output" || true)
cache=$agent_dir/chutes-models-cache.json
[ -f "$cache" ] || fail "the catalog was not cached"
usable=$(json "$cache" "${tools_models}.length")
[ "$listed" -gt 0 ] && [ "$listed" = "$usable" ] || fail "listed $listed Chutes models, expected $usable"
model=$(json "$cache" "${tools_models}[0].id")
echo "ok   loads from the extensions directory and lists $listed live Chutes models"

# 2. No key and no login: Chutes models must not look usable.
new_home anonymous
cp "$extension" "$agent_dir/extensions/chutes.ts"
cp "$cache" "$agent_dir/"
output=$(agent -- model list chutes)
if grep -q '^chutes ' <<<"$output"; then
	fail "Chutes models are listed without credentials"
fi
echo "ok   offers no Chutes models without credentials"

# The remaining scenarios talk to the mock. --no-extensions plus explicit -e
# fixes the load order, so the router applies after the extension.
# shellcheck disable=SC2119
start_mock
# Usage: prompt [VAR=value ...] -- [model selection arguments ...]
prompt() {
	local vars=()
	while [ "$1" != "--" ]; do
		vars+=("$1")
		shift
	done
	shift
	agent ${vars[@]+"${vars[@]}"} CHUTES_E2E_BASE_URL="$base_url" CHUTES_E2E_PROBE_OUT="$work/probe.json" -- \
		--no-extensions -e "$extension" -e "$root/test/e2e/route-to-mock.ts" -e "$root/test/e2e/probe.ts" \
		-p "Reply with pong" "$@"
}
chat='r.url === "/v1/chat/completions"'

# 3. API key: the request reaches Chutes' endpoint with the compat Chutes needs.
new_home api-key
cp "$cache" "$agent_dir/"
output=$(prompt CHUTES_API_KEY=cpk_e2e -- --provider chutes --model "$model")
[[ "$output" == *"pong from mock"* ]] || fail "unexpected reply: $output"
[ "$(request "$chat" 'r.authorization')" = "Bearer cpk_e2e" ] || fail "API key not sent"
[ "$(request "$chat" 'r.body.model')" = "$model" ] || fail "wrong model sent"
[ "$(request "$chat" '"max_tokens" in r.body && !("max_completion_tokens" in r.body) && !("store" in r.body)')" = "true" ] ||
	fail "request fields do not match Chutes' compat"
[ "$(request "$chat" 'r.body.messages[0].role')" = "system" ] || fail "system prompt not sent as a system message"
stop_service
echo "ok   sends API-key requests in the shape Chutes expects"

# 4. Sign in with Chutes, stored the way Prime Agent stores OAuth logins.
new_home oauth
cp "$cache" "$agent_dir/"
expires=$(node -e 'console.log(Date.now() + 3600_000)')
printf '{"chutes":{"type":"oauth","access":"at_stored","refresh":"rt_stored","expires":%s}}\n' "$expires" >"$agent_dir/auth.json"
chmod 600 "$agent_dir/auth.json"
output=$(prompt -- --provider chutes --model "$model")
[[ "$output" == *"pong from mock"* ]] || fail "unexpected reply: $output"
[ "$(request "$chat" 'r.authorization')" = "Bearer at_stored" ] || fail "stored login not used"
stop_service
echo "ok   uses a stored Sign in with Chutes login"

# 5. A default model saved by the earlier Chutes build still resolves.
new_home saved-default
cp "$cache" "$agent_dir/"
cp "$work/oauth/.prime/agent/auth.json" "$agent_dir/auth.json"
# The last usable model, so picking the first available one cannot pass by accident.
saved=$(json "$cache" "${tools_models}.at(-1).id")
[ "$saved" != "$model" ] || fail "the catalog needs at least two usable models for this check"
printf '{"defaultProvider":"chutes","defaultModel":"%s"}\n' "$saved" >"$agent_dir/settings.json"
output=$(prompt --)
[[ "$output" == *"pong from mock"* ]] || fail "unexpected reply: $output"
[ "$(request "$chat" 'r.body.model')" = "$saved" ] || fail "saved default model not used: $(request "$chat" 'r.body.model')"
stop_service
echo "ok   uses a default Chutes model saved in settings"

# 6. /login registration and the callback server, checked by the probe in the runs above.
[ "$(json "$work/probe.json" 'data.registered && data.usesCallbackServer')" = "true" ] || fail "sign-in not registered for /login"
[ "$(json "$work/probe.json" 'data.name')" = "Chutes (Sign in with Chutes)" ] || fail "unexpected sign-in name"
[ "$(json "$work/probe.json" 'data.access')" = "at_probe" ] || fail "login did not complete: $(json "$work/probe.json" 'data.loginError')"
echo "ok   registers Sign in with Chutes for /login and completes it through the callback server"
