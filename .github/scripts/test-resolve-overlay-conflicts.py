#!/usr/bin/env python3
"""Integration tests for the fail-closed overlay conflict resolver."""

import subprocess
import tempfile
import unittest
from pathlib import Path

RESOLVER = Path(__file__).with_name("resolve-overlay-conflicts.py")


def git(repo, *args, check=True):
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=check,
    )


class ResolverIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="prime-agent-overlay-resolver-")
        self.repo = Path(self.temp_dir.name)
        git(self.repo, "init", "--initial-branch=main")
        git(self.repo, "config", "user.name", "Resolver Test")
        git(self.repo, "config", "user.email", "resolver-test@example.invalid")

    def tearDown(self):
        self.temp_dir.cleanup()

    def write(self, content):
        (self.repo / "fixture.txt").write_text(content, encoding="utf-8")

    def commit(self, message):
        git(self.repo, "add", "--all")
        git(self.repo, "commit", "-m", message)

    def start_rebase(self, base, overlay, upstream):
        self.write(base)
        self.commit("base")
        git(self.repo, "switch", "-c", "overlay")
        self.write(overlay)
        self.commit("overlay")
        git(self.repo, "switch", "main")
        if upstream is None:
            (self.repo / "fixture.txt").unlink()
        else:
            self.write(upstream)
        self.commit("upstream")
        git(self.repo, "switch", "overlay")
        result = git(
            self.repo,
            "-c",
            "merge.conflictStyle=diff3",
            "rebase",
            "main",
            check=False,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def run_resolver(self):
        return subprocess.run(
            ["python3", str(RESOLVER)],
            cwd=self.repo,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_resolves_only_overlay_lines_when_upstream_deletes_the_anchor(self):
        self.start_rebase(
            "keep\nanchor\ntail\n",
            "keep\nanchor\noverlay\ntail\n",
            "keep\ntail\n",
        )

        result = self.run_resolver()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.repo / "fixture.txt").read_text(encoding="utf-8"), "keep\noverlay\ntail\n")
        self.assertEqual(git(self.repo, "diff", "--name-only", "--diff-filter=U").stdout, "")

    def test_refuses_marker_free_modify_delete_conflict(self):
        self.start_rebase("base\n", "overlay rewrite\n", None)

        result = self.run_resolver()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing non-content conflict", result.stdout)
        self.assertIn("fixture.txt", git(self.repo, "diff", "--name-only", "--diff-filter=U").stdout)

    def test_refuses_upstream_rewrite_of_overlay_anchor(self):
        self.start_rebase(
            "keep\nanchor\ntail\n",
            "keep\nanchor\noverlay\ntail\n",
            "keep\nrewritten\ntail\n",
        )

        result = self.run_resolver()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("upstream rewrote the region", result.stdout)
        self.assertIn("fixture.txt", git(self.repo, "diff", "--name-only", "--diff-filter=U").stdout)


if __name__ == "__main__":
    unittest.main()
