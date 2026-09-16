#!/bin/sh
# Prime Agent with Chutes.
#
#   curl -fsSL https://sirouk.github.io/prime-agent/install.sh | sh
#
# Installs or updates Prime Agent from its official release channel, then the
# Chutes extension from this site. Run it again at any time to update both.
#
# Environment:
#   PRIME_AGENT_CODING_AGENT_DIR  Prime Agent's config directory (default ~/.prime/agent)
#   PRIME_AGENT_CHUTES_BASE_URL   where the extension is downloaded from
#                                 (default https://sirouk.github.io/prime-agent)
# Prime Agent's own installer settings, such as PRIME_AGENT_INSTALL_METHOD, pass through.
set -eu

chutes_base_url="${PRIME_AGENT_CHUTES_BASE_URL:-https://sirouk.github.io/prime-agent}"
chutes_base_url="${chutes_base_url%/}"
prime_agent_installer="https://app.primeintellect.ai/prime-agent/install.sh"

say() {
	printf '%s\n' "$*"
}

fail() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	else
		shasum -a 256 "$1" | cut -d ' ' -f 1
	fi
}

install_prime_agent() {
	say "Installing Prime Agent from its official release channel..."
	curl -fsSL "$prime_agent_installer" -o "$work/prime-agent-install.sh" ||
		fail "could not download $prime_agent_installer"
	# PRIME_AGENT_DOWNLOAD_BASE_URL may still point at this fork's former release channel.
	(
		unset PRIME_AGENT_DOWNLOAD_BASE_URL
		sh "$work/prime-agent-install.sh"
	) || fail "Prime Agent's installer did not finish"
}

# This fork used to publish npm builds of Prime Agent versioned x.y.z-chutes.N,
# with Chutes compiled in. Left installed, one shadows the new command on PATH.
remove_fork_builds() {
	old_ifs=$IFS
	IFS=:
	for dir in $PATH; do
		IFS=$old_ifs
		command_path="$dir/prime-agent"
		[ -x "$command_path" ] || continue
		version=$(PI_SKIP_VERSION_CHECK=1 PI_OFFLINE=1 "$command_path" --version </dev/null 2>&1 | tail -n 1) || continue
		case "$version" in
			*-chutes.*) ;;
			*) continue ;;
		esac
		prefix=$(dirname "$dir")
		say "Removing the earlier Chutes build of Prime Agent ($version) from $prefix..."
		npm=npm
		[ -x "$dir/npm" ] && npm="$dir/npm"
		"$npm" uninstall --global --prefix "$prefix" prime-agent >/dev/null 2>&1 ||
			fail "could not remove $command_path. Remove it with: npm uninstall --global --prefix '$prefix' prime-agent"
	done
	IFS=$old_ifs
}

install_extension() {
	agent_dir="${PRIME_AGENT_CODING_AGENT_DIR:-$HOME/.prime/agent}"
	# Expand a literal ~ the way Prime Agent does when it reads this variable.
	# shellcheck disable=SC2088
	case "$agent_dir" in
		"~") agent_dir=$HOME ;;
		"~/"*) agent_dir="$HOME/${agent_dir#"~/"}" ;;
	esac
	say "Installing the Chutes extension into $agent_dir/extensions..."
	curl -fsSL "$chutes_base_url/extensions/SHA256SUMS" -o "$work/SHA256SUMS" ||
		fail "could not download $chutes_base_url/extensions/SHA256SUMS"
	curl -fsSL "$chutes_base_url/extensions/chutes.ts" -o "$work/chutes.ts" ||
		fail "could not download $chutes_base_url/extensions/chutes.ts"
	expected=$(awk '$2 == "chutes.ts" { print $1 }' "$work/SHA256SUMS")
	if [ -z "$expected" ] || [ "$(sha256_of "$work/chutes.ts")" != "$expected" ]; then
		fail "chutes.ts does not match its published checksum"
	fi
	mkdir -p "$agent_dir/extensions"
	# Not a .ts name until complete, so a half-written file is never loaded.
	cp "$work/chutes.ts" "$agent_dir/extensions/chutes.ts.partial"
	mv "$agent_dir/extensions/chutes.ts.partial" "$agent_dir/extensions/chutes.ts"
}

main() {
	command -v curl >/dev/null 2>&1 || fail "curl is required"
	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT

	install_prime_agent
	remove_fork_builds
	install_extension

	say ""
	say "Done. Start Prime Agent, run /login and choose \"Chutes (Sign in with Chutes)\","
	say "or set CHUTES_API_KEY. Chutes models are listed under /model."
}

main "$@"
