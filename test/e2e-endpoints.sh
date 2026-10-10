#!/usr/bin/env bash
# Runs the endpoints helper against a real Prime Agent executable: what the helper
# writes must be what Prime Agent reads. Endpoints are local mocks.
#
# Usage: test/e2e-endpoints.sh /path/to/prime-agent
set -euo pipefail
# shellcheck source=test/e2e/lib.sh
source "$(dirname "$0")/e2e/lib.sh"

chat='r["url"] == "/v1/chat/completions"'

new_home version
echo "Prime Agent $(agent -- --version) at $agent_bin"

# 1. An added endpoint's models are listed by Prime Agent; a disabled one's are not,
#    and providers already in models.json are untouched.
start_mock --models m1,m2 --key sk-e2e
new_home listing
cat >"$agent_dir/models.json" <<JSON
{ "providers": { "ollama": { "baseUrl": "http://127.0.0.1:9/v1", "apiKey": "none", "api": "openai-completions", "models": [ { "id": "llama3" } ] } } }
JSON
output=$(endpoints E2E_KEY=sk-e2e -- add "$base_url" --name GPU --id gpu --key-env E2E_KEY) || fail "add failed: $output"
output=$(agent -- model list)
[ "$(grep -c '^gpu ' <<<"$output" || true)" = 2 ] || fail "expected the two gpu models, got: $output"
grep -q '^ollama ' <<<"$output" || fail "the existing provider disappeared: $output"
output=$(endpoints -- disable gpu) || fail "disable failed: $output"
output=$(agent -- model list)
if grep -q '^gpu ' <<<"$output"; then fail "a disabled endpoint's models are listed: $output"; fi
grep -q '^ollama ' <<<"$output" || fail "the existing provider disappeared after disabling: $output"
echo "ok   lists an endpoint's models, hides it when disabled, and leaves other providers alone"

# 2. The saved key is sent, in the broadly compatible request shape.
new_home request
output=$(endpoints E2E_KEY=sk-e2e -- add "$base_url" --name GPU --id gpu --key-env E2E_KEY) || fail "add failed: $output"
output=$(agent -- -p "Reply with pong" --provider gpu --model m2)
[[ "$output" == *"pong from mock"* ]] || fail "unexpected reply: $output"
[ "$(request "$chat" 'r["authorization"]')" = "Bearer sk-e2e" ] || fail "saved key not sent"
[ "$(request "$chat" 'r["body"]["model"]')" = "m2" ] || fail "wrong model sent"
[ "$(request "$chat" '"max_tokens" in r["body"] and "max_completion_tokens" not in r["body"] and "store" not in r["body"]')" = "true" ] ||
	fail "request fields are not the broadly compatible shape"
[ "$(request "$chat" 'r["body"]["messages"][0]["role"]')" = "system" ] || fail "system prompt not sent as a system message"
echo "ok   sends requests with the saved key in the broadly compatible shape"

# 3. A re-keyed endpoint sends its new key to a Prime Agent that is already running.
stop_mock
start_mock --models m1,m2 --key sk-rotated
output=$(endpoints -- url gpu "$base_url" 2>&1) && fail "the old key was accepted by the rotated server"
[[ "$output" == *"refused the API key"* ]] || fail "unexpected url error: $output"
output=$(endpoints E2E_KEY=sk-rotated -- key gpu --key-env E2E_KEY) || fail "key failed: $output"
output=$(endpoints -- url gpu "$base_url") || fail "url failed: $output"
output=$(agent -- -p "Reply with pong" --provider gpu --model m1)
[[ "$output" == *"pong from mock"* ]] || fail "unexpected reply after re-keying: $output"
[ "$(request "$chat" 'r["authorization"]')" = "Bearer sk-rotated" ] || fail "the new key was not sent"
echo "ok   sends a re-keyed endpoint's new key"

# 4. An endpoint that lists effort levels gets reasoning_effort for them and "none" for off.
stop_mock
printf '%s' '[{"id":"eff","supports_reasoning":true,"reasoning_effort_levels":["low","high"],"max_model_len":32768}]' >"$work/effort.json"
start_mock --catalog "$work/effort.json"
new_home effort
output=$(endpoints -- add "$base_url" --name Effort --id effort --no-key) || fail "add failed: $output"
for level in off low high; do
	output=$(agent -- -p "Reply with pong" --provider effort --model eff --thinking "$level")
	[[ "$output" == *"pong from mock"* ]] || fail "unexpected reply at thinking $level: $output"
	sent=$(request "$chat" '"reasoning_effort" in r["body"] and r["body"]["reasoning_effort"] or "-"')
	case $level in off) expected=none ;; *) expected=$level ;; esac
	[ "$sent" = "$expected" ] || fail "thinking $level sent reasoning_effort '$sent', expected '$expected'"
done
echo "ok   sends reasoning_effort for the listed levels and none for off"

# 5. An Unsloth-style server whose /status gates thinking with enable_thinking:
#    thinking is switched on or off, and no effort level is sent.
stop_mock
status='{"supports_reasoning":true,"reasoning_style":"enable_thinking_effort","reasoning_effort_levels":["low","medium","xhigh"],"reasoning_always_on":false,"context_length":188672,"loaded":["zz-thinker"]}'
start_mock --models zz-thinker --status "$status"
new_home thinking
output=$(endpoints -- add "$base_url" --name Unsloth --id unsloth --no-key) || fail "add failed: $output"
for level in off low xhigh; do
	output=$(agent -- -p "Reply with pong" --provider unsloth --model zz-thinker --thinking "$level")
	[[ "$output" == *"pong from mock"* ]] || fail "unexpected reply at thinking $level: $output"
	sent=$(request "$chat" 'str(r["body"].get("enable_thinking")) + " " + str("reasoning_effort" in r["body"])')
	case $level in off) expected="False False" ;; *) expected="True False" ;; esac
	[ "$sent" = "$expected" ] || fail "thinking $level sent '$sent', expected '$expected'"
done
echo "ok   switches thinking with enable_thinking for a server that gates it"
