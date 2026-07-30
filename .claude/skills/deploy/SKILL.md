---
name: deploy
description: Trigger the claude-desktop-extra Build & Release GitHub Actions pipeline (build-and-release.yml). With no argument the skill inspects the changes since the last release and decides force_rebuild itself; "/deploy force" / "/deploy no-force" override.
disable-model-invocation: true
argument-hint: "[force|no-force]"
allowed-tools: Bash(gh workflow run *), Bash(gh run list *), Bash(gh run view *), Bash(gh workflow view *), Bash(gh release list *), Bash(git fetch *), Bash(git diff *), Bash(git log *)
---

# Deploy - trigger Build & Release

Args: `$ARGUMENTS` (`force` / `no-force` override the auto-decision; empty = decide automatically).

## Context
- Repo: `patrickjaja/claude-desktop-bin` · Workflow: `build-and-release.yml` · default branch: `master`.
- Current branch: !`git -C /home/patrickjaja/development/claude-desktop-bin branch --show-current`
- Tracked upstream version: !`cat /home/patrickjaja/development/claude-desktop-bin/.upstream-version 2>/dev/null`
- Last release: !`gh -R patrickjaja/claude-desktop-bin release list --limit 1 2>/dev/null || echo "(gh not ready)"`
- Recent runs: !`gh -R patrickjaja/claude-desktop-bin run list --workflow=build-and-release.yml --limit 3 2>/dev/null || echo "(gh not ready)"`

## Versioning semantics (format: `{upstream}-{pkgrel}`)
- **New upstream version** (`.upstream-version` was bumped by `/update`): pkgrel resets to **1** automatically. This is the plain non-force run.
- **Re-release at the same upstream version**: pkgrel auto-increments (CI counts existing releases). This needs `force_rebuild=true`. It does not matter whether the change was a patch (new patched payload) or packaging-only (launcher, .desktop, packaging scripts) - **both simply bump pkgrel**; the *kind* of change belongs in the CHANGELOG entry and the release notes, not in the version.
- pkgrel is never chosen by hand and never committed anywhere.

## Steps
1. **Resolve the last release tag** (from the Last release context above; `v<upstream>` or `v<upstream>-<pkgrel>`).
2. **Decide FORCE** (skip if `$ARGUMENTS` says `force` or `no-force` - explicit wins):
   - If `.upstream-version` on HEAD differs from the upstream part of the last release tag → **FORCE=false** (new-upstream release, pkgrel resets to 1).
   - Else look at what changed: `git fetch --tags origin` then `git diff --name-only <last-tag>..origin/master`. Classify:
     - any `patches/` or `js/` file → **payload update** → FORCE=true
     - else any `scripts/`, `packaging/`, `PKGBUILD.template`, `*.install`, `flake.nix`, `.github/workflows/` file → **packaging-only update** → FORCE=true
     - else (docs/site/skills/CHANGELOG/baseline only) → **STOP**: nothing shippable changed; tell the user a release would publish identical packages and ask if they really want `/deploy force`.
3. Print a one-line plan including the classification, e.g. "Triggering build-and-release.yml on `master` (force_rebuild=true - packaging-only update, pkgrel will bump)". Mention the classification so the CHANGELOG/release notes wording can say "payload update" vs "packaging-only".
4. Fire it (no interactive confirmation - the user already typed /deploy):
   ```bash
   gh -R patrickjaja/claude-desktop-bin workflow run build-and-release.yml -f force_rebuild=<FORCE>
   ```
5. Wait ~3s, then resolve the run and report its URL:
   ```bash
   gh -R patrickjaja/claude-desktop-bin run list --workflow=build-and-release.yml --limit 1 \
     --json databaseId,url,status,event,createdAt
   ```
   Report the run URL and status. Offer: "Watch with `gh -R patrickjaja/claude-desktop-bin run watch <id>`".

## Notes
- Do NOT bump versions or edit files here - this only triggers the pipeline. Version/patch work belongs in `/update`.
- If the diff shows BOTH a new `.upstream-version` and other changes, the non-force new-upstream run covers everything (the release builds from the committed tree).
- If `gh workflow run` errors with "Workflow does not have 'workflow_dispatch'" it's a permissions/branch issue - confirm the workflow file on `master` still declares `workflow_dispatch`.
