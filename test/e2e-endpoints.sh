#!/usr/bin/env bash
# Runs the endpoints extension inside a real Prime Agent executable: the npm
# install's `prime-agent` or the compiled binary. Endpoints are local mocks.
#
# Usage: test/e2e-endpoints.sh /path/to/prime-agent
set -euo pipefail
# shellcheck source=test/e2e/lib.sh
source "$(dirname "$0")/e2e/lib.sh"

extension=$root/extensions/endpoints.ts

# Usage: save_endpoint_cache <id> <refreshedAt> <model ids...>
save_endpoint_cache() {
	local id=$1 refreshed_at=$2
	shift 2
	mkdir -p "$agent_dir/endpoints"
	node -e 'const [path, at, ...ids] = process.argv.slice(1);
		require("fs").writeFileSync(path, JSON.stringify({ refreshedAt: Number(at), data: ids.map((id) => ({ id })) }));' \
		"$agent_dir/endpoints/$id.models.json" "$refreshed_at" "$@"
}

new_home version
echo "Prime Agent $(agent -- --version) at $agent_bin"

# 1. Saved endpoints load from their cached models; a disabled one stays hidden.
new_home listing
cp "$extension" "$agent_dir/extensions/"
cat >"$agent_dir/endpoints.json" <<JSON
{ "endpoints": [
	{ "id": "gpu", "name": "GPU", "baseUrl": "http://127.0.0.1:9/v1", "enabled": true },
	{ "id": "off", "name": "Off", "baseUrl": "http://127.0.0.1:9/v1", "enabled": false }
] }
JSON
now=$(node -e 'console.log(Date.now())')
save_endpoint_cache gpu "$now" m1 m2
save_endpoint_cache off "$now" m3
output=$(agent -- model list)
[ "$(grep -c '^gpu ' <<<"$output" || true)" = 2 ] || fail "expected the two gpu models, got: $output"
if grep -q '^off ' <<<"$output"; then fail "a disabled endpoint's models are listed"; fi
echo "ok   lists saved endpoints' models and hides disabled endpoints"

# 2. The saved key is sent, in the broadly compatible request shape.
start_mock --models m1,m2 --key sk-e2e
chat='r.url === "/v1/chat/completions"'
new_home request
cp "$extension" "$agent_dir/extensions/"
printf '{ "endpoints": [{ "id": "gpu", "name": "GPU", "baseUrl": "%s", "enabled": true }] }\n' "$base_url" >"$agent_dir/endpoints.json"
save_endpoint_cache gpu "$now" m1 m2
printf '{"gpu":{"type":"api_key","key":"sk-e2e"}}\n' >"$agent_dir/auth.json"
chmod 600 "$agent_dir/auth.json"
output=$(agent -- -p "Reply with pong" --provider gpu --model m2)
[[ "$output" == *"pong from mock"* ]] || fail "unexpected reply: $output"
[ "$(request "$chat" 'r.authorization')" = "Bearer sk-e2e" ] || fail "saved key not sent"
[ "$(request "$chat" 'r.body.model')" = "m2" ] || fail "wrong model sent"
[ "$(request "$chat" '"max_tokens" in r.body && !("max_completion_tokens" in r.body) && !("store" in r.body)')" = "true" ] ||
	fail "request fields are not the broadly compatible shape"
[ "$(request "$chat" 'r.body.messages[0].role')" = "system" ] || fail "system prompt not sent as a system message"
stop_service
echo "ok   sends requests with the saved key in the broadly compatible shape"

# 3. A stale model list is refreshed with the saved key when a session starts.
new_home refresh
cp "$extension" "$agent_dir/extensions/"
cp "$work/request/.prime/agent/endpoints.json" "$work/request/.prime/agent/auth.json" "$agent_dir/"
# Two hours old, past the one-hour refresh age.
save_endpoint_cache gpu $((now - 7200000)) m1
output=$(agent -- -p "Reply with pong" --provider gpu --model m1)
[[ "$output" == *"pong from mock"* ]] || fail "unexpected reply: $output"
for _ in $(seq 50); do
	[ "$(json "$agent_dir/endpoints/gpu.models.json" 'data.data.map((m) => m.id).join(",")')" = "m1,m2" ] && break
	sleep 0.1
done
[ "$(json "$agent_dir/endpoints/gpu.models.json" 'data.data.map((m) => m.id).join(",")')" = "m1,m2" ] ||
	fail "the model list was not refreshed"
[ "$(request 'r.url === "/v1/models"' 'r.authorization')" = "Bearer sk-e2e" ] || fail "the refresh did not send the saved key"
stop_service
echo "ok   refreshes a stale model list with the saved key when a session starts"

# 4. /endpoints itself, driven through RPC mode like a user: add, switch, chat, disable, enable, remove.
new_home command
cp "$extension" "$agent_dir/extensions/"
printf '{ "endpoints": [{ "id": "seed", "name": "Seed", "baseUrl": "%s", "enabled": true }] }\n' "$base_url" >"$agent_dir/endpoints.json"
save_endpoint_cache seed "$now" seed-model
isolated -- node "$root/test/e2e/endpoints-command.mjs" "$agent_bin" "$base_url" || fail "the /endpoints session failed"
[ "$(request 'r.url === "/v1/models" && r.authorization === "Bearer sk-e2e"' 'true')" = "true" ] || fail "adding did not check the endpoint with its key"
[ "$(request "$chat" 'r.body.model + " " + r.authorization')" = "m2 Bearer sk-e2e" ] || fail "the chat did not use the endpoint's model and key"
stop_service

# 5. An Unsloth-style server: /status marks the loaded model as needing enable_thinking
#    next to reasoning_effort. The hook adds it; reasoning_effort goes out unchanged.
status='{"supports_reasoning":true,"reasoning_style":"enable_thinking_effort","reasoning_effort_levels":["low","medium","xhigh"],"reasoning_always_on":false,"context_length":188672,"loaded":["zz-thinker"]}'
start_mock --models zz-thinker --key sk-e2e --status "$status"
new_home thinking
cp "$extension" "$agent_dir/extensions/"
printf '{ "endpoints": [{ "id": "unsloth", "name": "Unsloth", "baseUrl": "%s", "enabled": true }] }\n' "$base_url" >"$agent_dir/endpoints.json"
printf '{"unsloth":{"type":"api_key","key":"sk-e2e"}}\n' >"$agent_dir/auth.json"
chmod 600 "$agent_dir/auth.json"
# A stale cache, so the session refreshes it from /models and /status in the background.
save_endpoint_cache unsloth 1 zz-thinker
for _ in $(seq 50); do
	# The first run's refresh writes the merged catalog; later runs start from it.
	agent -- -p "Reply with pong" --provider unsloth --model zz-thinker --thinking off >/dev/null || true
	[ "$(json "$agent_dir/endpoints/unsloth.models.json" 'data.data[0].reasoning_style')" = "enable_thinking_effort" ] && break
	sleep 0.2
done
[ "$(json "$agent_dir/endpoints/unsloth.models.json" 'data.data[0].context_length')" = "188672" ] || fail "/status was not merged into the loaded model"
for level in off low xhigh; do
	output=$(agent -- -p "Reply with pong" --provider unsloth --model zz-thinker --thinking "$level")
	[[ "$output" == *"pong from mock"* ]] || fail "unexpected reply at thinking $level: $output"
	sent=$(request "$chat" 'r.body.reasoning_effort + " " + r.body.enable_thinking')
	case $level in
		off) expected="none false" ;;
		*) expected="$level true" ;;
	esac
	[ "$sent" = "$expected" ] || fail "thinking $level sent '$sent', expected '$expected'"
done
stop_service
echo "ok   sends Unsloth's enable_thinking gate with reasoning_effort for off and listed levels"
