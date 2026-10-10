#!/bin/sh
# Prime Agent with the endpoints helper.
#
#   curl -fsSL https://sirouk.github.io/prime-agent/install.sh | sh
#
# Installs or updates Prime Agent from its official release channel, then the
# prime-agent-endpoints helper from this site, which adds and manages
# OpenAI-compatible endpoints with API keys. Run it again at any time to update both.
#
# Prime Agent v0.10.0 has no extension system, so the helper edits Prime Agent's
# models.json and auth.json instead of running inside it. An earlier version of
# this installer saved the endpoints and Chutes extensions in
# ~/.prime/agent/extensions/; this one removes them and carries your saved
# endpoints over.
#
# Environment:
#   PRIME_AGENT_CODING_AGENT_DIR    Prime Agent's config directory (default ~/.prime/agent)
#   PRIME_AGENT_RUST_PREFIX         where Prime Agent is installed (default ~/.local); the
#                                   helper goes in its bin directory
#   PRIME_AGENT_ENDPOINTS_BASE_URL  where the helper is downloaded from
#                                   (default https://sirouk.github.io/prime-agent)
# Prime Agent's own installer settings, such as PRIME_AGENT_INSTALL_METHOD, pass through.
set -eu

endpoints_base_url="${PRIME_AGENT_ENDPOINTS_BASE_URL:-https://sirouk.github.io/prime-agent}"
endpoints_base_url="${endpoints_base_url%/}"
prime_agent_installer="https://app.primeintellect.ai/prime-agent/install.sh"
helper_name=prime-agent-endpoints
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

# Downloads the helper into the work directory and checks it against SHA256SUMS.
download_helper() {
	curl -fsSL "$endpoints_base_url/helper/SHA256SUMS" -o "$work/SHA256SUMS" ||
		fail "could not download $endpoints_base_url/helper/SHA256SUMS"
	curl -fsSL "$endpoints_base_url/helper/$helper_name" -o "$work/$helper_name" ||
		fail "could not download $endpoints_base_url/helper/$helper_name"
	expected=$(awk -v name="$helper_name" '$2 == name { print $1 }' "$work/SHA256SUMS")
	if [ -z "$expected" ] || [ "$(sha256_of "$work/$helper_name")" != "$expected" ]; then
		fail "$helper_name does not match its published checksum"
	fi
}

# The helper is a Python 3 script. The launcher finds a Python for it: python3 on PATH,
# else uv's, which Prime Agent's installer provides. uv runs without its cache, so an
# unwritable cache directory cannot stop it. The launcher is written here, not downloaded.
place_helper() {
	mkdir -p "$helper_dir" "$bin_dir"
	# Not the final name until complete, so a half-written file is never run.
	cp "$work/$helper_name" "$helper_dir/$helper_name.partial"
	mv "$helper_dir/$helper_name.partial" "$helper_dir/$helper_name"
	cat >"$bin_dir/$helper_name.partial" <<LAUNCHER
#!/bin/sh
# Written by the Prime Agent endpoints installer.
script='$helper_dir/$helper_name'
if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
	exec python3 "\$script" "\$@"
fi
uv=\$(command -v uv 2>/dev/null || true)
[ -n "\$uv" ] || [ ! -x "\$HOME/.local/bin/uv" ] || uv=\$HOME/.local/bin/uv
if [ -n "\$uv" ]; then
	exec "\$uv" run --no-cache --no-project --quiet --python '>=3.9' python "\$script" "\$@"
fi
echo "$helper_name needs Python 3.9 or newer, or uv" >&2
exit 1
LAUNCHER
	chmod 755 "$bin_dir/$helper_name.partial"
	mv "$bin_dir/$helper_name.partial" "$bin_dir/$helper_name"
	say "Installed $helper_name in $bin_dir"
}

# The extensions this installer used to save. Prime Agent v0.10.0 does not load them.
remove_old_extensions() {
	for file in endpoints.ts chutes.ts; do
		path="$agent_dir/extensions/$file"
		[ -f "$path" ] || continue
		case "$file" in
			endpoints.ts) marker='OpenAI-compatible endpoints for Prime Agent' ;;
			chutes.ts) marker='Chutes provider for Prime Agent' ;;
		esac
		# Only the files this installer saved, never one of the same name written by hand.
		if head -n 5 "$path" | grep -q "$marker"; then
			rm -f "$path"
			say "Removed the old $file extension, which Prime Agent v0.10.0 no longer loads."
			removed_extension=$file
		fi
	done
	rmdir "$agent_dir/extensions" 2>/dev/null || true
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
	helper_dir=$agent_dir/helpers
	bin_dir="${PRIME_AGENT_RUST_PREFIX:-$HOME/.local}/bin"
	removed_extension=

	fork_builds=$(find_fork_builds)

	# Everything is downloaded and verified before anything on this machine changes.
	download_helper

	install_prime_agent
	remove_fork_builds
	place_helper
	remove_old_extensions

	# Carry endpoints saved by the extension over: models.json is rebuilt from their
	# saved model lists, then refreshed from the network where it can be.
	if [ -f "$agent_dir/endpoints.json" ]; then
		say "Carrying your saved endpoints over to Prime Agent's models.json..."
		PRIME_AGENT_CODING_AGENT_DIR=$agent_dir "$bin_dir/$helper_name" sync ||
			say "warning: could not rebuild models.json; run '$helper_name sync' to see why"
		PRIME_AGENT_CODING_AGENT_DIR=$agent_dir "$bin_dir/$helper_name" refresh ||
			say "warning: some endpoints could not be refreshed; their saved model lists are in use"
	fi

	say ""
	say "Done. Add an OpenAI-compatible endpoint with:"
	say "  $helper_name add https://api.example.com/v1"
	say "then choose its models with /model in Prime Agent. '$helper_name --help' lists the rest."
	case ":$PATH:" in
		*":$bin_dir:"*) ;;
		*) say "Add $bin_dir to your PATH to run it by name." ;;
	esac
	if [ "$removed_extension" = chutes.ts ]; then
		say "Chutes sign-in is gone with the extension system. For Chutes with an API key:"
		say "  $helper_name add https://llm.chutes.ai/v1 --name Chutes --id chutes-api"
	fi
}

main "$@"
