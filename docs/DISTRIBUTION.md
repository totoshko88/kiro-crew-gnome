# Distribution Guide

## Creating a Release

### 1. Update Changelog

```bash
# Update CHANGELOG.md with changes for the new version.
# metadata.json carries no integer "version": the review guidelines mark it
# deprecated, and extensions.gnome.org sets it itself on upload.
```

### 2. Build Package

```bash
make pack
# Creates: kiro-crew@totoshko88.github.io.shell-extension.zip
```

### 3. Create Git Tag

```bash
# Stage only your own changed files by explicit path (never `git add -A`)
git add CHANGELOG.md <other-changed-files>
git commit -m "release: vX.Y.Z"
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow sets `version-name` from the tag, runs `make pack`, and
creates a release with notes from CHANGELOG.md.

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

- [ ] State tests pass (`make test-logic`)
- [ ] EGO guidelines validated (`bash tests/validate-review-guidelines.sh`)
- [ ] CHANGELOG.md updated
- [ ] README.md version badge updated
- [ ] `metadata.json` has no integer `version` key (set by extensions.gnome.org)
- [ ] Any clipboard use is declared in the `metadata.json` description
