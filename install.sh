#!/bin/sh
# Prime Agent with the endpoints extension.
#
#   curl -fsSL https://sirouk.github.io/prime-agent/install.sh | sh
#
# Installs or updates Prime Agent from its official release channel, then the
# endpoints extension from this site, which adds OpenAI-compatible endpoints with
# API keys through /endpoints. Run it again at any time to update both.
#
# The Chutes extension ("Sign in with Chutes") is installed as well when asked for,
# when it is already installed, or when this replaces an earlier Chutes build of
# Prime Agent:
#
#   curl -fsSL https://sirouk.github.io/prime-agent/install.sh | PRIME_AGENT_WITH_CHUTES=1 sh
#
# Environment:
#   PRIME_AGENT_CODING_AGENT_DIR     Prime Agent's config directory (default ~/.prime/agent)
#   PRIME_AGENT_WITH_CHUTES          1 to install the Chutes extension
#   PRIME_AGENT_EXTENSIONS_BASE_URL  where the extensions are downloaded from
#                                    (default https://sirouk.github.io/prime-agent)
# Prime Agent's own installer settings, such as PRIME_AGENT_INSTALL_METHOD, pass through.
set -eu

extensions_base_url="${PRIME_AGENT_EXTENSIONS_BASE_URL:-https://sirouk.github.io/prime-agent}"
extensions_base_url="${extensions_base_url%/}"
prime_agent_installer="https://app.primeintellect.ai/prime-agent/install.sh"
tab=$(printf '\t')

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

# This fork used to publish npm builds of Prime Agent versioned x.y.z-chutes.N,
# with Chutes compiled in. Left installed, one shadows the new command on PATH.
# Prints "<directory><tab><version>" for each one found.
find_fork_builds() {
	old_ifs=$IFS
	IFS=:
	for dir in $PATH; do
		IFS=$old_ifs
		[ -x "$dir/prime-agent" ] || continue
		version=$(PI_SKIP_VERSION_CHECK=1 PI_OFFLINE=1 "$dir/prime-agent" --version </dev/null 2>&1 | tail -n 1) || continue
		case "$version" in
			*-chutes.*) printf '%s%s%s\n' "$dir" "$tab" "$version" ;;
		esac
	done
	IFS=$old_ifs
}

remove_fork_builds() {
	printf '%s\n' "$fork_builds" | while IFS="$tab" read -r dir version; do
		[ -n "$dir" ] || continue
		prefix=$(dirname "$dir")
		say "Removing the earlier Chutes build of Prime Agent ($version) from $prefix..."
		npm=npm
		[ -x "$dir/npm" ] && npm="$dir/npm"
		"$npm" uninstall --global --prefix "$prefix" prime-agent >/dev/null 2>&1 ||
			fail "could not remove $dir/prime-agent. Remove it with: npm uninstall --global --prefix '$prefix' prime-agent"
	done
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

# Downloads an extension into the work directory and checks it against SHA256SUMS.
download_extension() {
	curl -fsSL "$extensions_base_url/extensions/$1" -o "$work/$1" ||
		fail "could not download $extensions_base_url/extensions/$1"
	expected=$(awk -v name="$1" '$2 == name { print $1 }' "$work/SHA256SUMS")
	if [ -z "$expected" ] || [ "$(sha256_of "$work/$1")" != "$expected" ]; then
		fail "$1 does not match its published checksum"
	fi
}

place_extension() {
	mkdir -p "$extensions_dir"
	# Not a .ts name until complete, so a half-written file is never loaded.
	cp "$work/$1" "$extensions_dir/$1.partial"
	mv "$extensions_dir/$1.partial" "$extensions_dir/$1"
	say "Installed $1 in $extensions_dir"
}

main() {
	command -v curl >/dev/null 2>&1 || fail "curl is required"
	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT

	agent_dir="${PRIME_AGENT_CODING_AGENT_DIR:-$HOME/.prime/agent}"
	# Expand a literal ~ the way Prime Agent does when it reads this variable.
	# shellcheck disable=SC2088
	case "$agent_dir" in
		"~") agent_dir=$HOME ;;
		"~/"*) agent_dir="$HOME/${agent_dir#"~/"}" ;;
	esac
	extensions_dir=$agent_dir/extensions

	fork_builds=$(find_fork_builds)
	extensions=endpoints.ts
	if [ "${PRIME_AGENT_WITH_CHUTES:-0}" = 1 ] || [ -f "$extensions_dir/chutes.ts" ] || [ -n "$fork_builds" ]; then
		extensions="$extensions chutes.ts"
	fi

	# Everything is downloaded and verified before anything on this machine changes.
	curl -fsSL "$extensions_base_url/extensions/SHA256SUMS" -o "$work/SHA256SUMS" ||
		fail "could not download $extensions_base_url/extensions/SHA256SUMS"
	for extension in $extensions; do
		download_extension "$extension"
	done

	install_prime_agent
	remove_fork_builds
	for extension in $extensions; do
		place_extension "$extension"
	done

	say ""
	say "Done. Start Prime Agent and run /endpoints to add an OpenAI-compatible endpoint."
	case "$extensions" in
		*chutes.ts*) say "For Chutes, run /login and choose \"Chutes (Sign in with Chutes)\", or set CHUTES_API_KEY." ;;
	esac
}

main "$@"
