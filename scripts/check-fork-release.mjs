import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflowSource = readFileSync(".github/workflows/fork-release.yml", "utf8");
const syncWorkflowSource = readFileSync(".github/workflows/fork-sync.yml", "utf8");
const tempRoot = mkdtempSync(join(tmpdir(), "prime-agent-fork-release-"));
const baseUrl = "https://example.github.io/prime-agent";
const gitLocalEnvironmentVariables = spawnSync("git", ["rev-parse", "--local-env-vars"], {
	encoding: "utf8",
}).stdout
	.trim()
	.split(/\s+/);
const isolatedProcessEnvironment = { ...process.env };
for (const variable of gitLocalEnvironmentVariables) {
	delete isolatedProcessEnvironment[variable];
}

function extractRunStep(stepName) {
	const stepMarker = `      - name: ${stepName}\n`;
	const stepStart = workflowSource.indexOf(stepMarker);
	if (stepStart === -1) {
		throw new Error(`Could not find workflow step: ${stepName}`);
	}
	if (workflowSource.indexOf(stepMarker, stepStart + stepMarker.length) !== -1) {
		throw new Error(`Workflow step name is not unique: ${stepName}`);
	}

	const runMarker = "        run: |\n";
	const runStart = workflowSource.indexOf(runMarker, stepStart + stepMarker.length);
	if (runStart === -1) {
		throw new Error(`Workflow step has no multiline run block: ${stepName}`);
	}

	const scriptLines = [];
	for (const line of workflowSource.slice(runStart + runMarker.length).split("\n")) {
		if (line.startsWith("          ")) {
			scriptLines.push(line.slice(10));
		} else if (line === "") {
			scriptLines.push("");
		} else {
			break;
		}
	}
	return scriptLines.join("\n");
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env ?? isolatedProcessEnvironment,
	});
	if (result.error) {
		throw result.error;
	}
	return result;
}

function runChecked(command, args, options = {}) {
	const result = run(command, args, options);
	if (result.status !== 0) {
		throw new Error(
			[
				`${command} ${args.join(" ")} exited with status ${result.status}`,
				result.stdout,
				result.stderr,
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	return result;
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function assertStepSucceeded(stepName, result) {
	assert(result.status === 0, `${stepName} failed:\n${result.stdout}\n${result.stderr}`);
}

function createFixture(name) {
	const root = join(tempRoot, name);
	const site = join(root, "site");
	const releases = join(site, "releases");
	mkdirSync(releases, { recursive: true });
	runChecked("git", ["init", "--quiet"], { cwd: site });
	runChecked("git", ["config", "user.name", "Fork Release Check"], { cwd: site });
	runChecked("git", ["config", "user.email", "fork-release-check@example.invalid"], { cwd: site });
	runChecked("git", ["config", "commit.gpgsign", "false"], { cwd: site });
	return { releases, root, site };
}

function commitRelease(fixture, release, sequence) {
	const releaseDir = join(fixture.releases, release);
	mkdirSync(releaseDir, { recursive: true });
	writeFileSync(join(releaseDir, "marker.txt"), `${release}\n`, "utf8");
	runChecked("git", ["add", `releases/${release}/marker.txt`], { cwd: fixture.site });
	const commitDate = `2026-08-${String(sequence).padStart(2, "0")}T00:00:00Z`;
	runChecked("git", ["commit", "--quiet", "-m", `release: ${release}`], {
		cwd: fixture.site,
		env: {
			...isolatedProcessEnvironment,
			GIT_AUTHOR_DATE: commitDate,
			GIT_COMMITTER_DATE: commitDate,
		},
	});
}

function artifactInventory(releaseVersion) {
	return [
		`prime-agent-${releaseVersion}.tgz`,
		`prime-agent-ai-${releaseVersion}.tgz`,
		`prime-agent-core-${releaseVersion}.tgz`,
		`prime-agent-tui-${releaseVersion}.tgz`,
	].map((file) => {
		const contents = `fixture for ${file}\n`;
		return {
			contents,
			file,
			package: file.replace(`-${releaseVersion}.tgz`, ""),
			sha256: createHash("sha256").update(contents).digest("hex"),
		};
	});
}

function writeStaging(fixture, releaseVersion) {
	const artifactsDir = join(fixture.root, "staging", "artifacts");
	const installersDir = join(fixture.root, "staging", "installers");
	mkdirSync(artifactsDir, { recursive: true });
	mkdirSync(installersDir, { recursive: true });

	const currentRelease = `v${releaseVersion}`;
	const tarballs = artifactInventory(releaseVersion);
	for (const tarball of tarballs) {
		writeFileSync(join(artifactsDir, tarball.file), tarball.contents, "utf8");
	}
	writeFileSync(
		join(artifactsDir, "SHA256SUMS"),
		tarballs.map((tarball) => `${tarball.sha256}  ${tarball.file}`).join("\n") + "\n",
		"utf8",
	);
	writeFileSync(join(artifactsDir, "stable"), `${currentRelease}\n`, "utf8");
	writeFileSync(
		join(artifactsDir, "latest.json"),
		`${JSON.stringify(
			{
				package: "prime-agent",
				tarball: `releases/${currentRelease}/prime-agent-${releaseVersion}.tgz`,
				tarballs: tarballs.map(({ file, package: packageName, sha256 }) => ({
					file,
					package: packageName,
					sha256,
				})),
				version: currentRelease,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	writeFileSync(join(installersDir, "install.sh"), `#!/bin/sh\nbase_url=${baseUrl}\n`, "utf8");
	writeFileSync(join(installersDir, "install-beta.sh"), `#!/bin/sh\nbase_url=${baseUrl}\n`, "utf8");
	return tarballs;
}

function runWorkflowStep(stepName, fixture, releaseVersion) {
	return runExtractedStep(stepName, {
		cwd: fixture.root,
		env: {
			...isolatedProcessEnvironment,
			BASE_URL: baseUrl,
			KEEP_RELEASES: "12",
			RELEASE_VERSION: releaseVersion,
			UPSTREAM_VERSION: "0.8.1",
		},
	});
}

function runExtractedStep(stepName, options) {
	return run("bash", ["-e", "-o", "pipefail", "-c", extractRunStep(stepName)], options);
}

function releaseNames(fixture) {
	return readdirSync(fixture.releases, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

function oldReleaseNames(count) {
	return Array.from({ length: count }, (_, index) => `v0.8.0-chutes.${index + 1}`);
}

function prepareScenario(name, committedReleases, releaseVersion) {
	const fixture = createFixture(name);
	for (const [index, release] of committedReleases.entries()) {
		commitRelease(fixture, release, index + 1);
	}
	const tarballs = writeStaging(fixture, releaseVersion);
	const stageResult = runWorkflowStep("Stage release into the site", fixture, releaseVersion);
	assertStepSucceeded("Stage release into the site", stageResult);
	assert(
		readFileSync(join(fixture.site, "stable"), "utf8") === readFileSync(join(fixture.site, "beta"), "utf8"),
		"Stage release produced different stable and beta pointers",
	);
	assert(
		readFileSync(join(fixture.site, "latest.json"), "utf8") ===
			readFileSync(join(fixture.site, "beta.json"), "utf8"),
		"Stage release produced different stable and beta manifests",
	);
	return { fixture, tarballs };
}

function assertPruneScenario({ committedReleases, currentVersion, name, removed }) {
	const { fixture, tarballs } = prepareScenario(name, committedReleases, currentVersion);
	const currentRelease = `v${currentVersion}`;
	const pruneResult = runWorkflowStep("Prune old releases", fixture, currentVersion);
	assertStepSucceeded("Prune old releases", pruneResult);
	assert(existsSync(join(fixture.releases, currentRelease)), `${name}: pruning removed ${currentRelease}`);
	for (const release of removed) {
		assert(!existsSync(join(fixture.releases, release)), `${name}: pruning retained ${release}`);
	}
	assert(releaseNames(fixture).length <= 12, `${name}: pruning retained more than 12 releases`);
	return { currentRelease, fixture, tarballs };
}

function checkImmutableVersionTag() {
	const root = join(tempRoot, "immutable-tag");
	const packageDir = join(root, "packages", "coding-agent");
	const outputPath = join(root, "github-output");
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), '{"version":"0.8.1"}\n', "utf8");
	runChecked("git", ["init", "--quiet"], { cwd: root });
	runChecked("git", ["config", "user.name", "Fork Release Check"], { cwd: root });
	runChecked("git", ["config", "user.email", "fork-release-check@example.invalid"], { cwd: root });
	runChecked("git", ["config", "commit.gpgsign", "false"], { cwd: root });
	runChecked("git", ["add", "packages/coding-agent/package.json"], { cwd: root });
	runChecked("git", ["commit", "--quiet", "-m", "initial build"], { cwd: root });
	runChecked("git", ["tag", "v0.8.1-chutes.1"], { cwd: root });

	const env = {
		...isolatedProcessEnvironment,
		GITHUB_OUTPUT: outputPath,
		GITHUB_REPOSITORY: "example/prime-agent",
		INPUT_REF: "chutes",
		INPUT_VERSION: "0.8.1-chutes.1",
		PAGES_BASE_URL: baseUrl,
	};
	const sameCommitResult = runExtractedStep("Resolve version and base URL", { cwd: root, env });
	assertStepSucceeded("Resolve version and base URL", sameCommitResult);
	assert(
		readFileSync(outputPath, "utf8").includes("release_tag=v0.8.1-chutes.1"),
		"Resolve context omitted the immutable release tag",
	);

	writeFileSync(join(root, "new-build.txt"), "different build\n", "utf8");
	runChecked("git", ["add", "new-build.txt"], { cwd: root });
	runChecked("git", ["commit", "--quiet", "-m", "different build"], { cwd: root });
	const movedTagResult = runExtractedStep("Resolve version and base URL", { cwd: root, env });
	assert(movedTagResult.status !== 0, "Resolve context allowed an existing release tag to move");
}

try {
	for (const stepName of [
		"Resolve version and base URL",
		"Stage release into the site",
		"Prune old releases",
		"Verify staged site",
		"Commit and push the site",
		"Configure and request the GitHub Pages build",
		"Tag the built commit",
		"Check the channel pointers and manifests",
	]) {
		const syntaxResult = run("bash", ["-n", "-c", extractRunStep(stepName)]);
		assert(syntaxResult.status === 0, `${stepName} has invalid shell syntax:\n${syntaxResult.stderr}`);
	}
	const pagesStep = extractRunStep("Configure and request the GitHub Pages build");
	assert(
		pagesStep.includes('gh api --method POST "repos/${GITHUB_REPOSITORY}/pages/builds"'),
		"Pages step does not explicitly request a build",
	);
	assert(
		pagesStep.includes('[ "$build_commit" = "$SITE_SHA" ]'),
		"Pages step does not bind completion to the pushed site commit",
	);
	assert(
		syncWorkflowSource.includes(
			"if: ${{ inputs.skip_release != true && needs.sync.outputs.rebased == 'true' }}",
		),
		"Fork sync publishes a release when the overlay did not move",
	);
	checkImmutableVersionTag();

	const boundaryReleases = oldReleaseNames(12);
	const boundary = assertPruneScenario({
		committedReleases: boundaryReleases,
		currentVersion: "0.8.1-chutes.1",
		name: "fresh-boundary",
		removed: [boundaryReleases[0]],
	});
	assert(releaseNames(boundary.fixture).length === 12, "Fresh boundary did not retain exactly 12 releases");

	const verifyResult = runWorkflowStep("Verify staged site", boundary.fixture, "0.8.1-chutes.1");
	assertStepSucceeded("Verify staged site", verifyResult);
	writeFileSync(
		join(boundary.fixture.root, "staging", "artifacts", "SHA256SUMS"),
		`${"0".repeat(64)}  ${boundary.tarballs[0].file}\n`,
		"utf8",
	);
	const collisionResult = runWorkflowStep(
		"Stage release into the site",
		boundary.fixture,
		"0.8.1-chutes.1",
	);
	assert(collisionResult.status !== 0, "Stage release overwrote an existing version with different checksums");
	rmSync(join(boundary.fixture.releases, boundary.currentRelease, boundary.tarballs[0].file));
	const corruptResult = runWorkflowStep("Verify staged site", boundary.fixture, "0.8.1-chutes.1");
	assert(corruptResult.status !== 0, "Verify staged site accepted a missing primary tarball");

	const atCapacityReleases = oldReleaseNames(11);
	const atCapacity = assertPruneScenario({
		committedReleases: atCapacityReleases,
		currentVersion: "0.8.1-chutes.1",
		name: "at-capacity",
		removed: [],
	});
	assert(releaseNames(atCapacity.fixture).length === 12, "At-capacity pruning changed the release count");

	const repeatedReleases = oldReleaseNames(13);
	const repeatedVersion = repeatedReleases[0].slice(1);
	const repeated = assertPruneScenario({
		committedReleases: repeatedReleases,
		currentVersion: repeatedVersion,
		name: "repeated-current",
		removed: [repeatedReleases[1]],
	});
	assert(releaseNames(repeated.fixture).length === 12, "Repeated-current pruning retained the wrong count");

	const overflowReleases = oldReleaseNames(14);
	const overflow = assertPruneScenario({
		committedReleases: overflowReleases,
		currentVersion: "0.8.1-chutes.1",
		name: "multiple-overflow",
		removed: overflowReleases.slice(0, 3),
	});
	assert(releaseNames(overflow.fixture).length === 12, "Multiple-overflow pruning retained the wrong count");

	const unexpectedReleases = oldReleaseNames(12);
	const unexpected = prepareScenario("unexpected-directory", unexpectedReleases, "0.8.1-chutes.1");
	mkdirSync(join(unexpected.fixture.releases, "v-uncommitted"));
	const beforeUnexpectedPrune = releaseNames(unexpected.fixture);
	const unexpectedResult = runWorkflowStep(
		"Prune old releases",
		unexpected.fixture,
		"0.8.1-chutes.1",
	);
	assert(unexpectedResult.status !== 0, "Pruning accepted an unrelated uncommitted release directory");
	assert(
		JSON.stringify(releaseNames(unexpected.fixture)) === JSON.stringify(beforeUnexpectedPrune),
		"Pruning changed the site before rejecting an uncommitted release directory",
	);

	console.log("Fork release workflow check passed.");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	rmSync(tempRoot, { force: true, recursive: true });
}
