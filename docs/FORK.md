# Chutes fork maintenance

This fork exists to ship upstream Prime Agent with Chutes support added. It is
built so that syncing with upstream is a single click and everything else is
automatic.

## Branch layout

| Branch          | What it is                                                                 |
| --------------- | -------------------------------------------------------------------------- |
| `main`          | Upstream `PrimeIntellect-ai/prime-agent@main`, plus fork-maintenance workflows and documentation. Safe to update with GitHub's **Sync fork** button. |
| `chutes`        | `main` plus the Chutes provider/OAuth and kernel-safety overlay commits. **Rebased and force-pushed by CI** — never commit anything here that you are not willing to see replayed. |
| `gh-pages`      | The published release site. Written only by CI. |
| `chutes-provider` | Untouched import of `chutesai/prime-agent@chutes-provider`, kept for provenance. Not maintained. |
| `chutes-oauth`  | Untouched import of `fstandhartinger/prime-agent@chutes-oauth`, kept for provenance. Not maintained. |

## What happens when you click "Sync fork"

1. GitHub pushes upstream's commits onto `main`.
2. That push fires [`fork-sync.yml`](../.github/workflows/fork-sync.yml), which:
   - merges `upstream/main` into `main` (a no-op if the button already did it),
   - rebases `chutes` onto the new `main` and force-pushes it,
   - calls [`fork-release.yml`](../.github/workflows/fork-release.yml).
3. The release workflow builds, packs, publishes to GitHub Pages, mirrors the
   artifacts to a GitHub Release, and then **installs the result from the
   published URL** to prove the installer works.

A release is cut on every sync, even when nothing changed.

The same run also happens daily at 07:00 UTC as a safety net, and can be started
by hand from the Actions tab.

### If the rebase conflicts

CI aborts the rebase, publishes nothing, and opens (or comments on) an issue
titled *"Fork sync failed: chutes needs a manual rebase"* with the conflicting
paths. Fix it locally:

```sh
git fetch origin
git checkout -B chutes origin/chutes
git rebase origin/main
# resolve, then
git push --force-with-lease origin chutes
```

Pushing `chutes` yourself triggers a release directly.

The Chutes commits deliberately **do not touch `packages/ai/CHANGELOG.md`**.
Upstream inserts new version headers at the top of that file on every release,
which made it the only recurring conflict. The Chutes changes are described in
the generated GitHub Release notes instead.

The kernel-safety overlay prevents daemon discovery from probing internal
forkserver sockets and re-provisions Python after any other unexpected kernel
death. Its exact source/test paths are allowlisted by `fork-sync.yml`; conflicts
inside those paths still stop the rebase for manual review. Every release runs
the four focused regression files before packaging.

## The update channel

Upstream hard-codes its own R2 bucket in `packages/coding-agent/src/utils/version-check.ts`
as the place to look for new releases. Left alone, an installed fork build
compares its `0.7.2-chutes.1` against upstream's `0.7.2` — and because a
prerelease sorts *below* the plain release, it reports "Update available:
v0.7.2" and `/update` would replace the Chutes build with stock Prime Agent.

`fork-release.yml` therefore rewrites that constant (and its test and docs) to
this fork's base URL **at build time**, in the working tree only. Nothing is
committed, so the overlay branch gains no conflict surface. The step fails the
build if the upstream URL is no longer found, so a rename upstream is caught
loudly rather than silently shipping a self-downgrading build.

Result: released builds check `https://sirouk.github.io/prime-agent/latest.json`,
`/update` installs this fork's tarball, and `-chutes.N` increments are seen as
updates while upstream releases are not.

You still learn about upstream releases — the daily sync rebases onto them and
cuts a new `-chutes.N` automatically, so an upstream release becomes a fork
release (and a new GitHub Release entry) within a day.

To temporarily point an installed build somewhere else without rebuilding:

```sh
export PRIME_AGENT_DOWNLOAD_BASE_URL=https://sirouk.github.io/prime-agent
```

`PI_SKIP_VERSION_CHECK=1` disables the check entirely.

## Versioning

Releases are versioned `<upstream-version>-chutes.<N>`, e.g. `0.7.2-chutes.1`.
`N` is derived by scanning existing tags, so re-running the workflow produces a
new version rather than clobbering one. Both `install.sh` and
`scripts/pack-prime-agent-release.mjs` accept `[0-9A-Za-z.-]`, so the suffix is
safe.

## Install

```sh
curl -fsSL https://sirouk.github.io/prime-agent/install.sh | sh
```

Beta channel installer (same artifacts and manifest, `beta` channel default):

```sh
curl -fsSL https://sirouk.github.io/prime-agent/install-beta.sh | sh
```

Pin a specific version:

```sh
PRIME_AGENT_VERSION=0.7.2-chutes.1 sh -c "$(curl -fsSL https://sirouk.github.io/prime-agent/install.sh)"
```

## Why GitHub Pages and not Release assets

`scripts/pack-prime-agent-release.mjs` rewrites the cross-package dependencies
inside each tarball to absolute URLs of the form:

```
<base>/releases/v<version>/prime-agent-ai-<version>.tgz
```

`install.sh` resolves the channel pointer and checksums with the same layout.
GitHub Release assets are served from a flat
`/releases/download/<tag>/<file>` namespace, which cannot express that nested
path — using it would mean patching both `install.sh` and the pack script and
carrying those patches against upstream forever. A static site matches the
stock layout exactly, so **neither file is modified in this fork**.

Artifacts are still mirrored to a GitHub Release for durability and for a
human-visible download page.

## One-time repository setup

- **Settings → Pages**: source = *Deploy from a branch*, branch = `gh-pages`,
  folder = `/ (root)`. Already configured. The release workflow tries to set
  this automatically, but `GITHUB_TOKEN` usually cannot create a Pages site for
  the first time, so the initial enablement is manual; after that it sticks.
- **Settings → General → Features → Issues** is off by default on forks. The
  sync workflow's conflict notification is best-effort and will only warn in the
  run log until Issues is enabled. Failures still show as a red run either way.
- Upstream's own `Release Prime Agent` workflow (`build-binaries.yml`) publishes
  to Cloudflare R2 and can never succeed here, so it is **disabled** in this
  fork's Actions settings. It is left on disk so it never conflicts on sync.
- **Settings → Actions → General → Workflow permissions**: *Read and write
  permissions*, and allow Actions to create pull requests is not required.
- **Actions must be enabled** — forks start with workflows disabled, so the
  "Sync fork" push will not trigger anything until you enable them once.
- Optional: set a repository variable `PAGES_BASE_URL` to override the derived
  `https://<owner>.github.io/<repo>` base (e.g. for a custom domain).

## Keeping site size in check

`fork-release.yml` keeps the most recent `KEEP_RELEASES` (default 12) version
directories on `gh-pages` and prunes older ones. The release staged by the
current run is excluded from that run's prune candidates; only older committed
release directories are eligible. Before the site commit is pushed, the
workflow verifies the retained-release limit, stable/beta pointers and
manifests, installers, and checksums. Because pushes
made with `GITHUB_TOKEN` do not trigger Pages builds, the workflow explicitly
requests a Pages build after pushing `gh-pages` and waits for that exact commit.
The `check:fork-release` npm script exercises the 12-existing-plus-1-new
retention boundary against the workflow's own shell steps.

Each release is roughly 10 MB. The branch accumulates history; if it ever gets
unwieldy, squash it:

```sh
git checkout gh-pages
git checkout --orphan gh-pages-fresh
git commit -m "chore: squash release history"
git push --force origin gh-pages-fresh:gh-pages
```
