# Shared by the end-to-end suite. Source it with the Prime Agent executable as $1.
#
# Each scenario runs with its own HOME and TMPDIR. HOME keeps the real ~/.prime
# untouched; TMPDIR matters because Prime Agent's background service listens on
# $TMPDIR/prime-agent-<uid>/daemon.sock, so a shared TMPDIR would reach a Prime
# Agent the machine is really running. The socket directories live under /tmp to
# stay within the Unix socket path length limit.
# shellcheck shell=bash

agent_bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
helper=$root/helper/prime-agent-endpoints
work=$(mktemp -d)
sockets=$(mktemp -d /tmp/prime-agent-e2e.XXXXXX)
homes=()
mock_pids=()

cleanup() {
	for pid in ${mock_pids[@]+"${mock_pids[@]}"}; do
		kill "$pid" 2>/dev/null || true
	done
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
	mkdir -p "$agent_dir" "$tmp"
	homes+=("$home")
}

# Runs a command in the current scenario's isolated environment.
# Usage: isolated [VAR=value ...] -- command [arguments ...]
# Output is merged so that stderr diagnostics show up in failures.
isolated() {
	local vars=()
	while [ "$1" != "--" ]; do
		vars+=("$1")
		shift
	done
	shift
	(cd "$home" && env -i PATH="$PATH" HOME="$home" TMPDIR="$tmp" PRIME_AGENT_CODING_AGENT_DIR="$agent_dir" \
		PI_SKIP_VERSION_CHECK=1 TERM=dumb ${vars[@]+"${vars[@]}"} "$@" </dev/null 2>&1)
}

# Usage: agent [VAR=value ...] -- [prime-agent arguments ...]
agent() {
	local vars=()
	while [ "$1" != "--" ]; do
		vars+=("$1")
		shift
	done
	shift
	isolated ${vars[@]+"${vars[@]}"} -- "$agent_bin" "$@"
}

# Usage: endpoints [VAR=value ...] -- [prime-agent-endpoints arguments ...]
endpoints() {
	local vars=()
	while [ "$1" != "--" ]; do
		vars+=("$1")
		shift
	done
	shift
	isolated ${vars[@]+"${vars[@]}"} -- python3 "$helper" "$@"
}

stop_service() {
	agent -- shutdown --force >/dev/null 2>&1 || true
}

# Starts the OpenAI-compatible mock and sets $base_url and $requests for the suite.
# Usage: start_mock [--models a,b] [--key secret] [--status json]
# shellcheck disable=SC2034,SC2120
start_mock() {
	requests=$(mktemp "$work/requests.XXXXXX")
	local port_file
	port_file=$(mktemp "$work/port.XXXXXX")
	python3 "$root/test/mock_openai.py" "$requests" "$@" >"$port_file" &
	mock_pid=$!
	mock_pids+=("$mock_pid")
	for _ in $(seq 50); do
		[ -s "$port_file" ] && break
		sleep 0.1
	done
	[ -s "$port_file" ] || fail "the mock server did not start"
	base_url="http://127.0.0.1:$(tr -d '\n' <"$port_file")/v1"
}

stop_mock() {
	kill "$mock_pid" 2>/dev/null || true
	wait "$mock_pid" 2>/dev/null || true
}

# Prints a value from the last logged request that matches a condition.
# Usage: request <Python condition over `r`> <Python expression over `r`>
request() {
	python3 -I - "$requests" "$1" "$2" <<'PY'
import json, sys
path, condition, expression = sys.argv[1:4]
rows = [json.loads(line) for line in open(path) if line.strip()]
matches = [r for r in rows if eval(condition, {}, {"r": r})]
value = eval(expression, {}, {"r": matches[-1]}) if matches else ""
print(str(value).lower() if isinstance(value, bool) else value)
PY
}

# Prints a value from a JSON file: json <file> <Python expression over `data`>
json() {
	python3 -I - "$1" "$2" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
print(eval(sys.argv[2], {}, {"data": data}))
PY
}
