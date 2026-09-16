#!/usr/bin/env bash
# Runs the extension inside a real Prime Agent executable: the npm install's
# `prime-agent` or the compiled binary. Each scenario gets its own HOME, so the
# real ~/.prime is never touched. The first scenario needs network access to
# https://llm.chutes.ai/v1/models; the rest use a local mock of Chutes.
#
# Usage: test/e2e.sh /path/to/prime-agent
set -euo pipefail

agent_bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
root=$(cd "$(dirname "$0")/.." && pwd)
extension=$root/extensions/chutes.ts
work=$(mktemp -d)
# Prime Agent's background service listens on $TMPDIR/prime-agent-<uid>/daemon.sock.
# Giving every scenario its own short TMPDIR keeps it away from any Prime Agent
# the machine is really running (and under the Unix socket path length limit).
sockets=$(mktemp -d /tmp/chutes-e2e.XXXXXX)
homes=()
mock_pid=

cleanup() {
	if [ -n "$mock_pid" ]; then kill "$mock_pid" 2>/dev/null || true; fi
	for h in ${homes[@]+"${homes[@]}"}; do
		home=$h agent_dir=$h/.prime/agent tmp=$sockets/$(basename "$h") stop_service
	done
	rm -rf "$work" "$sockets"
}
trap cleanup EXIT

fail() {
	printf 'FAIL %s\n' "$1" >&2
	exit 1
}

new_home() {
	home=$work/$1
	agent_dir=$home/.prime/agent
	tmp=$sockets/$1
	mkdir -p "$agent_dir/extensions" "$tmp"
	homes+=("$home")
}

# Usage: agent [VAR=value ...] -- [prime-agent arguments ...]
# Output is merged: the npm build prints to stderr where the compiled binary uses stdout.
agent() {
	local vars=()
	while [ "$1" != "--" ]; do
		vars+=("$1")
		shift
	done
	shift
	(cd "$home" && env -i PATH="$PATH" HOME="$home" TMPDIR="$tmp" PRIME_AGENT_CODING_AGENT_DIR="$agent_dir" \
		PI_SKIP_VERSION_CHECK=1 TERM=dumb ${vars[@]+"${vars[@]}"} "$agent_bin" "$@" </dev/null 2>&1)
}

stop_service() {
	agent -- shutdown --force >/dev/null 2>&1 || true
}

# Prints a JSON value from a file: json <file> <javascript expression over `data`>
json() {
	node -e 'const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(eval(process.argv[2]))' "$1" "$2"
}

new_home version
echo "Prime Agent $(agent -- --version) at $agent_bin"

# 1. Installed like the installer does it: auto-discovered, catalog fetched live.
new_home discovered
cp "$extension" "$agent_dir/extensions/chutes.ts"
output=$(agent CHUTES_API_KEY=cpk_e2e -- model list chutes)
listed=$(grep -c '^chutes ' <<<"$output" || true)
cache=$agent_dir/chutes-models-cache.json
[ -f "$cache" ] || fail "the catalog was not cached"
usable=$(json "$cache" 'data.data.filter((m) => (m.supported_features ?? []).includes("tools") && m.context_length && m.max_output_length).length')
[ "$listed" -gt 0 ] && [ "$listed" = "$usable" ] || fail "listed $listed Chutes models, expected $usable"
model=$(json "$cache" 'data.data.find((m) => (m.supported_features ?? []).includes("tools")).id')
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

# The remaining scenarios talk to a local mock of Chutes.
requests=$work/requests.jsonl
: >"$requests"
node "$root/test/e2e/mock-chutes.mjs" "$requests" >"$work/mock-port" &
mock_pid=$!
for _ in $(seq 50); do
	[ -s "$work/mock-port" ] && break
	sleep 0.1
done
base_url="http://127.0.0.1:$(cat "$work/mock-port")/v1"

# --no-extensions plus explicit -e fixes the load order, so the router applies after the extension.
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
last_request() {
	tail -n 1 "$requests" >"$work/last.json"
	json "$work/last.json" "$1"
}

# 3. API key: the request reaches Chutes' endpoint with the compat Chutes needs.
new_home api-key
cp "$cache" "$agent_dir/"
output=$(prompt CHUTES_API_KEY=cpk_e2e -- --provider chutes --model "$model")
[[ "$output" == *"pong from mock chutes"* ]] || fail "unexpected reply: $output"
[ "$(last_request 'data.url')" = "/v1/chat/completions" ] || fail "request went to $(last_request 'data.url')"
[ "$(last_request 'data.authorization')" = "Bearer cpk_e2e" ] || fail "API key not sent"
[ "$(last_request 'data.body.model')" = "$model" ] || fail "wrong model sent"
[ "$(last_request '"max_tokens" in data.body && !("max_completion_tokens" in data.body) && !("store" in data.body)')" = "true" ] ||
	fail "request fields do not match Chutes' compat"
[ "$(last_request 'data.body.messages[0].role')" = "system" ] || fail "system prompt not sent as a system message"
stop_service
echo "ok   sends API-key requests in the shape Chutes expects"

# 4. Sign in with Chutes, stored the way Prime Agent stores OAuth logins.
new_home oauth
cp "$cache" "$agent_dir/"
expires=$(node -e 'console.log(Date.now() + 3600_000)')
printf '{"chutes":{"type":"oauth","access":"at_stored","refresh":"rt_stored","expires":%s}}\n' "$expires" >"$agent_dir/auth.json"
chmod 600 "$agent_dir/auth.json"
output=$(prompt -- --provider chutes --model "$model")
[[ "$output" == *"pong from mock chutes"* ]] || fail "unexpected reply: $output"
[ "$(last_request 'data.authorization')" = "Bearer at_stored" ] || fail "stored login not used"
stop_service
echo "ok   uses a stored Sign in with Chutes login"

# 5. A default model saved by the earlier Chutes build still resolves.
new_home saved-default
cp "$cache" "$agent_dir/"
cp "$work/oauth/.prime/agent/auth.json" "$agent_dir/auth.json"
# The last usable model, so picking the first available one cannot pass by accident.
saved=$(json "$cache" 'data.data.filter((m) => (m.supported_features ?? []).includes("tools")).at(-1).id')
[ "$saved" != "$model" ] || fail "the catalog needs at least two usable models for this check"
printf '{"defaultProvider":"chutes","defaultModel":"%s"}\n' "$saved" >"$agent_dir/settings.json"
output=$(prompt --)
[[ "$output" == *"pong from mock chutes"* ]] || fail "unexpected reply: $output"
[ "$(last_request 'data.body.model')" = "$saved" ] || fail "saved default model not used: $(last_request 'data.body.model')"
stop_service
echo "ok   uses a default Chutes model saved in settings"

# 6. /login registration and the callback server, checked by the probe in both runs above.
[ "$(json "$work/probe.json" 'data.registered && data.usesCallbackServer')" = "true" ] || fail "sign-in not registered for /login"
[ "$(json "$work/probe.json" 'data.name')" = "Chutes (Sign in with Chutes)" ] || fail "unexpected sign-in name"
[ "$(json "$work/probe.json" 'data.access')" = "at_probe" ] || fail "login did not complete: $(json "$work/probe.json" 'data.loginError')"
echo "ok   registers Sign in with Chutes for /login and completes it through the callback server"
