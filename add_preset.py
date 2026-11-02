#!/usr/bin/env python3
"""Register the agy-gemini preset into a DSH profile patch.

DSH's agent-preset registry does not scan a directory and does not accept a
preset path: a preset only appears in the selector once it is registered as an
`insert` record inside the profile patch. This script writes that record.

The preset must be registered as:

    - insert:                     # `insert` is a LIST; data.push(...insert) spreads it
        - id: preset-agy-gemini
          name: '@deepseek-ai/dsh-agent-preset'
          config:
            id: agy-gemini
            ...
            plugins:              # agent.cordis.yml, every row indented by 10 spaces
              - id: tool-bootstrap
                ...

Two things this script gets right so you do not have to:

1. every `name: ./x.mjs` resolves relative to the PATCH file, not to this
   directory, so module paths are rewritten to `./agy-gemini/x.mjs`;
2. rows are indented 10 spaces so they land under `config.plugins`.

Usage:
    python add_preset.py <profile>/cordis.patch.yml
    python add_preset.py <profile>/cordis.patch.yml --dry-run
    python add_preset.py <profile>/cordis.patch.yml --remove

Exit codes: 0 ok, 1 usage/IO error, 2 already registered (use --remove).
"""

from __future__ import annotations

import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "agent.cordis.yml")
MANIFEST = os.path.join(HERE, "preset.yml")

DEFAULT_NAME = "agy-gemini"
DEFAULT_DESCRIPTION = "A DSH agent preset for Gemini-family models."

BEGIN = "# >>> agy-gemini preset (managed block) >>>"
END = "# <<< agy-gemini preset (managed block) <<<"

PLUGIN_INDENT = " " * 10

# `./x.mjs` -> `./agy-gemini/x.mjs`, but never double-prefix an already
# qualified path. The negative lookahead is what makes a re-run idempotent.
MODULE_RE = re.compile(r"\./(?!agy-gemini/)([\w.-]+\.mjs)")


def read_manifest() -> tuple[str, str]:
    """Read the display name and description from preset.yml.

    preset.yml is the single source of truth, so the text shown in the selector
    cannot drift away from the text written into the patch. Falls back to
    constants when the file is missing or unreadable.
    """
    try:
        with io.open(MANIFEST, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return DEFAULT_NAME, DEFAULT_DESCRIPTION

    name, description = DEFAULT_NAME, DEFAULT_DESCRIPTION
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("name:"):
            name = stripped[len("name:") :].strip().strip("'\"") or name
        elif stripped.startswith("description:"):
            description = (
                stripped[len("description:") :].strip().strip("'\"") or description
            )
    return name, description


def build_block(source_text: str, preset_name: str, preset_description: str) -> str:
    body = MODULE_RE.sub(r"./agy-gemini/\1", source_text).rstrip()
    indented = "\n".join(
        (PLUGIN_INDENT + line) if line.strip() else "" for line in body.splitlines()
    )
    escaped = preset_description.replace("\\", "\\\\").replace('"', '\\"')
    return (
        f"{BEGIN}\n"
        "- insert:\n"
        "    - id: preset-agy-gemini\n"
        "      name: '@deepseek-ai/dsh-agent-preset'\n"
        "      config:\n"
        "        id: agy-gemini\n"
        f"        name: {preset_name}\n"
        f'        description: "{escaped}"\n'
        "        order: 100\n"
        "        plugins:\n"
        f"{indented}\n"
        f"{END}\n"
    )


def count_rows(source_text: str) -> int:
    return sum(1 for line in source_text.splitlines() if line.startswith("- id: "))


def read_text(path: str) -> str:
    with io.open(path, encoding="utf-8") as handle:
        return handle.read()


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {a for a in argv[1:] if a.startswith("--")}
    dry_run = "--dry-run" in flags
    remove = "--remove" in flags

    if len(args) != 1:
        sys.stderr.write(
            "usage: python add_preset.py <profile>/cordis.patch.yml "
            "[--dry-run | --remove]\n"
        )
        return 1

    patch_path = args[0]
    if not os.path.isfile(patch_path):
        sys.stderr.write(f"error: patch file not found: {patch_path}\n")
        return 1

    try:
        patch = read_text(patch_path)
        source = read_text(SOURCE)
    except OSError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1

    registered = BEGIN in patch or "id: preset-agy-gemini" in patch

    if remove:
        if not registered:
            sys.stderr.write("nothing to remove: preset is not registered\n")
            return 1
        start = patch.find(BEGIN)
        if start == -1:
            sys.stderr.write(
                "error: managed block markers not found; refusing to guess what to "
                "delete. Remove the block by hand.\n"
            )
            return 1
        end = patch.find(END, start)
        if end == -1:
            sys.stderr.write("error: END marker not found; refusing to cut\n")
            return 1
        end += len(END)
        # Also swallow the trailing newline of the END marker line.
        if patch[end : end + 1] == "\n":
            end += 1
        updated = patch[:start].rstrip("\n") + "\n" + patch[end:].lstrip("\n")
        if dry_run:
            print("[dry-run] would remove the managed block (rest unchanged)")
            return 0
        with io.open(patch_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(updated)
        print(f"removed agy-gemini preset block from {patch_path}")
        return 0

    if registered:
        sys.stderr.write(
            "error: preset is already registered in this patch (look for "
            f"'{BEGIN}').\n"
            "       Re-run with --remove first, or edit the patch by hand.\n"
        )
        return 2

    block = build_block(source, *read_manifest())
    rows = count_rows(source)

    if dry_run:
        print(block)
        print(f"[dry-run] {rows} plugin rows -> {patch_path} (nothing written)")
        return 0

    with io.open(patch_path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write("\n" + block)
    print(f"appended {rows} plugin rows to {patch_path}")
    print("Restart DSH fully; a page refresh does not reload the profile patch.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
