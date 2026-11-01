# Distribution Guide

## Creating a Release

**The release is the pushed `v*` tag, not the merge.** The CI workflow runs on
every push/PR, but the Release workflow (`.github/workflows/release.yml`)
triggers *only* on a tag matching `v*`. Merging the version PR into `main` runs
CI and bumps the version — it does **not** build the zip or create the GitHub
Release. That only happens when you push the tag. Forgetting the tag leaves
`main` bumped with no release.

### The one-command path (recommended)

Prepare the version on a branch, open a PR, and merge it into `main` (CI must be
green). The version bump lives in that PR:

- `CHANGELOG.md` has a `## [X.Y.Z]` section (its body becomes the release notes),
- `kiro-crew@totoshko88.github.io/metadata.json` `version-name` is `X.Y.Z`,
- `package.json` `version` is `X.Y.Z`,
- `README.md` version badge is updated.

Then, on an up-to-date `main`, cut the release:

```bash
scripts/release.sh          # version read from metadata.json
# or: scripts/release.sh 0.1.6
# or: DRY_RUN=1 scripts/release.sh   # run every check, tag nothing
```

`scripts/release.sh` refuses to release unless the tree is clean, you are on an
in-sync `main`, the version is consistent across metadata/package/CHANGELOG, the
tag does not already exist, `main`'s CI is green, and the local gates (lint,
`make test-logic`, `make validate`, `make pack`) pass. It then creates the
annotated tag, pushes **only the tag** (never `main` — that branch is
protected), watches the Release workflow, and prints the release URL.

The release workflow sets `version-name` from the tag, runs `make pack`, and
creates a GitHub Release with the notes extracted from `CHANGELOG.md`.

### Manual tag (fallback, if you can't run the script)

```bash
# On an up-to-date main, with the version already merged in:
git tag -a vX.Y.Z -m "vX.Y.Z" main
git push origin vX.Y.Z          # push the TAG only; never `git push origin main`
```

## Manual Release (if needed)

1. Go to GitHub → Releases → Create new release
2. Select the tag
3. Upload `kiro-crew@totoshko88.github.io.shell-extension.zip`
4. Copy the relevant section from CHANGELOG.md

## extensions.gnome.org Submission

### Prerequisites

- Account on https://extensions.gnome.org
- Pass validation: `bash tests/validate-review-guidelines.sh`

### Submit

1. Log in to extensions.gnome.org
2. Click "Upload Extension"
3. Upload `kiro-crew@totoshko88.github.io.shell-extension.zip`
4. Fill in details and submit

### Common Review Issues

| Issue | Solution |
|-------|----------|
| Sync operations | Use async/await |
| Resource leaks | Clean up in `disable()` |
| GTK in extension.js | Move to prefs.js |
| try/catch or `?.` around calls that never throw | Remove them (best practices) |
| Undeclared clipboard use | Declare it in the description |

## Version Numbering

Follow [Semantic Versioning](https://semver.org/):

- **Major** (X.0.0): Breaking changes
- **Minor** (0.X.0): New features
- **Patch** (0.1.X): Bug fixes

The semantic version lives in `version-name`. extensions.gnome.org numbers each
upload itself; `metadata.json` has no integer `version`.

## Pre-Release Checklist

Most of this is enforced automatically by `scripts/release.sh`; the list is the
human-facing version of its checks.

- [ ] State/logic tests pass (`make test-logic`)
- [ ] EGO guidelines validated (`bash tests/validate-review-guidelines.sh`)
- [ ] CHANGELOG.md has a non-empty `## [X.Y.Z]` section
- [ ] `metadata.json` `version-name`, `package.json` `version`, and the tag all agree
- [ ] README.md version badge updated
- [ ] `metadata.json` has no integer `version` key (set by extensions.gnome.org)
- [ ] Any clipboard use is declared in the `metadata.json` description
- [ ] Version PR merged into `main` and `main`'s CI is green **before** tagging
- [ ] Release cut with `scripts/release.sh` (which pushes the `v*` tag)
