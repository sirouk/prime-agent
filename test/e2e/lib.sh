# Shared by the end-to-end suites. Source it with the Prime Agent executable as $1.
#
# Each scenario runs Prime Agent with its own HOME and TMPDIR. HOME keeps the real
# ~/.prime untouched; TMPDIR matters because Prime Agent's background service
# listens on $TMPDIR/prime-agent-<uid>/daemon.sock, so a shared TMPDIR would reach
# a Prime Agent the machine is really running. The socket directories live under
# /tmp to stay within the Unix socket path length limit.
# shellcheck shell=bash

agent_bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
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
	mkdir -p "$agent_dir/extensions" "$tmp"
	homes+=("$home")
}

# Runs a command in the current scenario's isolated environment.
# Usage: isolated [VAR=value ...] -- command [arguments ...]
# Output is merged: the npm build prints to stderr where the compiled binary uses stdout.
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

stop_service() {
	agent -- shutdown --force >/dev/null 2>&1 || true
}

# Prints a value from a JSON file: json <file> <JavaScript expression over `data`>
json() {
	node -e 'const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(eval(process.argv[2]))' "$1" "$2"
}

# Starts the OpenAI-compatible mock and sets $base_url and $requests for the suites.
# Usage: start_mock [--models a,b] [--key secret]
# shellcheck disable=SC2034,SC2120
start_mock() {
	requests=$(mktemp "$work/requests.XXXXXX")
	local port_file
	port_file=$(mktemp "$work/port.XXXXXX")
	node "$root/test/e2e/mock-openai.mjs" "$requests" "$@" >"$port_file" &
	mock_pids+=($!)
	for _ in $(seq 50); do
		[ -s "$port_file" ] && break
		sleep 0.1
	done
	[ -s "$port_file" ] || fail "the mock server did not start"
	base_url="http://127.0.0.1:$(cat "$port_file")/v1"
}

# Prints a value from the last logged request that matches a condition.
# Usage: request <JavaScript condition over `r`> <JavaScript expression over `r`>
request() {
	node -e '
		const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
		const r = lines.map((line) => JSON.parse(line)).filter((r) => eval(process.argv[2])).at(-1);
		console.log(r === undefined ? "" : eval(process.argv[3]));
	' "$requests" "$1" "$2"
}
