#!/usr/bin/env python3
"""Auto-resolve the one safe conflict class in the Chutes overlay.

Most provider/OAuth integration points only *add* lines. They conflict with
upstream when upstream edits the lines that anchored those additions --
typically by deleting a neighbouring comment banner. Git cannot place the
addition and stops.

Such a hunk is resolved here iff, in diff3 terms:

  * "ours" (upstream, HEAD during a rebase) is empty, i.e. upstream deleted the
    base lines outright rather than rewriting them, and
  * base -> theirs is a pure insertion: every base line survives in theirs, in
    order, with nothing deleted or rewritten.

The resolution is then `theirs - base`: exactly the lines the overlay authored.
Emitting "theirs" wholesale would instead resurrect the base lines upstream had
just deleted, silently reverting part of upstream's change.

Anything else -- upstream rewriting the region, the overlay deleting or
modifying an upstream line, a delete/modify conflict, a binary file -- is left
alone so the rebase fails loudly and a human decides. Unmerged index stages are
checked before reading the working tree because modify/delete conflicts have no
marker hunk and must never be mistaken for an empty successful resolution.

Exit 0 if every conflicted path was fully resolved and staged, 1 otherwise.
"""

import difflib
import subprocess
import sys

OURS, BASE, THEIRS = "<<<<<<<", "|||||||", ">>>>>>>"


def git(*args):
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=True
    ).stdout


def unmerged_paths():
    out = git("diff", "--name-only", "--diff-filter=U", "-z")
    return [p for p in out.split("\0") if p]


def unmerged_stage_sets():
    out = git("ls-files", "--unmerged", "-z")
    stages = {}
    for record in out.split("\0"):
        if not record:
            continue
        metadata, path = record.split("\t", 1)
        stage = int(metadata.rsplit(" ", 1)[1])
        stages.setdefault(path, set()).add(stage)
    return stages


def split_hunks(lines, path):
    """Yield ("text", [lines]) and ("conflict", ours, base, theirs) in order."""
    i, n = 0, len(lines)
    plain = []
    while i < n:
        if not lines[i].startswith(OURS):
            plain.append(lines[i])
            i += 1
            continue
        if plain:
            yield ("text", plain)
            plain = []
        ours, base, theirs = [], [], None
        i += 1
        while i < n and not lines[i].startswith(BASE):
            if lines[i].startswith((THEIRS, "=======")):
                raise ValueError(
                    f"{path}: conflict without a diff3 base section; "
                    "the rebase must run with merge.conflictStyle=diff3"
                )
            ours.append(lines[i])
            i += 1
        if i >= n:
            raise ValueError(f"{path}: unterminated conflict (no base marker)")
        i += 1
        while i < n and not lines[i].startswith("======="):
            base.append(lines[i])
            i += 1
        if i >= n:
            raise ValueError(f"{path}: unterminated conflict (no separator)")
        i += 1
        theirs = []
        while i < n and not lines[i].startswith(THEIRS):
            theirs.append(lines[i])
            i += 1
        if i >= n:
            raise ValueError(f"{path}: unterminated conflict (no closing marker)")
        i += 1
        yield ("conflict", ours, base, theirs)
    if plain:
        yield ("text", plain)


def overlay_additions(base, theirs):
    """Return the lines theirs inserts into base, or None if not a pure insertion."""
    added = []
    matcher = difflib.SequenceMatcher(a=base, b=theirs, autojunk=False)
    for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "insert":
            added.extend(theirs[j1:j2])
            continue
        return None  # "delete" or "replace": the overlay touched upstream's lines
    return added


def resolve(path):
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().splitlines(keepends=True)
    except (OSError, UnicodeDecodeError) as exc:
        print(f"  {path}: cannot read as text ({exc})")
        return False

    out, resolved = [], 0
    for piece in split_hunks(lines, path):
        if piece[0] == "text":
            out.extend(piece[1])
            continue
        _, ours, base, theirs = piece
        if any(line.strip() for line in ours):
            print(f"  {path}: upstream rewrote the region; leaving it conflicted")
            return False
        added = overlay_additions(base, theirs)
        if added is None:
            print(f"  {path}: overlay modifies upstream lines; leaving it conflicted")
            return False
        out.extend(added)
        resolved += 1

    if resolved == 0:
        print(f"  {path}: no diff3 conflict hunks; leaving it conflicted")
        return False

    with open(path, "w", encoding="utf-8") as handle:
        handle.write("".join(out))
    print(f"  {path}: auto-resolved {resolved} pure-insertion hunk(s)")
    return True


def main():
    paths = unmerged_paths()
    if not paths:
        print("No conflicted paths to resolve.")
        return 1

    stage_sets = unmerged_stage_sets()
    unsupported = [
        (path, stage_sets.get(path, set()))
        for path in paths
        if stage_sets.get(path, set()) != {1, 2, 3}
    ]
    if unsupported:
        print("Refusing non-content conflict(s):")
        for path, stages in unsupported:
            rendered = ",".join(str(stage) for stage in sorted(stages)) or "none"
            print(f"  {path}: unmerged index stages {rendered}; expected 1,2,3")
        return 1

    print(f"Attempting auto-resolution of {len(paths)} conflicted path(s):")
    staged = []
    for path in paths:
        try:
            if not resolve(path):
                return 1
        except ValueError as exc:
            print(f"  {exc}")
            return 1
        staged.append(path)

    subprocess.run(["git", "add", "--", *staged], check=True)
    print(f"Staged {len(staged)} auto-resolved path(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
