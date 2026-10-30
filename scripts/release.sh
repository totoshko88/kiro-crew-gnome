#!/usr/bin/env bash
#
# release.sh — cut a Kiro Crew GNOME extension release by pushing a v* tag.
#
# WHY THIS SCRIPT EXISTS
#   The Release workflow (.github/workflows/release.yml) triggers ONLY on a
#   pushed tag matching `v*`. Merging the version PR into main does NOT release
#   anything — it only runs CI. The release is the tag push, and forgetting it
#   leaves main bumped but no GitHub Release and no built zip. This script makes
#   the tag push the one deliberate, checked step.
#
# WHAT IT DOES
#   1. Verifies the working tree, branch, and version are all consistent and
#      that main's CI is green, BEFORE creating anything.
#   2. Re-runs the local gates (lint, logic tests, EGO validate, pack) so a
#      red tag never reaches CI.
#   3. Creates an annotated tag v<version> on the current main and pushes ONLY
#      that tag (never a branch — main is protected).
#   4. Watches the Release workflow and prints the release URL.
#
# USAGE
#   scripts/release.sh            # version is read from metadata.json
#   scripts/release.sh 0.1.6      # or pass it explicitly (must match metadata)
#   DRY_RUN=1 scripts/release.sh  # run every check, but do not tag or push
#
# REQUIREMENTS
#   git, gh (authenticated), make, python3, and the repo's dev deps for `make
#   lint` (run `npm ci` once). Run it from anywhere inside the repo.

set -euo pipefail

# ---- helpers ---------------------------------------------------------------

RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; BLD=$'\e[1m'; RST=$'\e[0m'
info() { printf '%s==>%s %s\n' "$BLD" "$RST" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%swarn%s %s\n' "$YLW" "$RST" "$*"; }
die()  { printf '%sERROR%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

DRY_RUN="${DRY_RUN:-0}"

# ---- locate the repo and its pieces ---------------------------------------

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
cd "$REPO_ROOT"

UUID="kiro-crew@totoshko88.github.io"
METADATA="$UUID/metadata.json"
PKG="package.json"
CHANGELOG="CHANGELOG.md"
DEFAULT_BRANCH="main"

[ -f "$METADATA" ]  || die "missing $METADATA — run from the extension repo"
[ -f "$CHANGELOG" ] || die "missing $CHANGELOG"

# ---- tooling present -------------------------------------------------------

command -v gh  >/dev/null 2>&1 || die "gh (GitHub CLI) is not installed"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run 'gh auth login'"

# ---- version: from metadata.json, cross-checked everywhere -----------------

META_VERSION="$(python3 -c "import json;print(json.load(open('$METADATA'))['version-name'])")" \
    || die "could not read version-name from $METADATA"

VERSION="${1:-$META_VERSION}"
# Accept either "0.1.5" or "v0.1.5" as the argument; normalize to no-v.
VERSION="${VERSION#v}"
TAG="v$VERSION"

echo
info "Releasing ${BLD}$TAG${RST} from $REPO_ROOT"
echo

[ "$VERSION" = "$META_VERSION" ] || \
    die "version mismatch: you asked for $VERSION but $METADATA says $META_VERSION. Bump metadata first (and commit it on $DEFAULT_BRANCH)."
ok "metadata.json version-name = $VERSION"

# package.json version should match too (not read by CI, but kept in lockstep).
if [ -f "$PKG" ]; then
    PKG_VERSION="$(python3 -c "import json;print(json.load(open('$PKG')).get('version',''))")"
    if [ "$PKG_VERSION" != "$VERSION" ]; then
        die "package.json version ($PKG_VERSION) != $VERSION — bump it and commit before releasing"
    fi
    ok "package.json version = $VERSION"
fi

# CHANGELOG must carry a section for this version — the workflow extracts it
# for the release notes, and an empty section ships an empty release body.
if ! grep -q "^## \[$VERSION\]" "$CHANGELOG"; then
    die "no '## [$VERSION]' section in $CHANGELOG — add the release notes and commit first"
fi
NOTES_LINES="$(awk "/^## \[$VERSION\]/{f=1;next} /^## \[/{f=0} f" "$CHANGELOG" | grep -c '[^[:space:]]' || true)"
[ "$NOTES_LINES" -gt 0 ] || die "the '## [$VERSION]' section in $CHANGELOG is empty"
ok "CHANGELOG has a non-empty [$VERSION] section ($NOTES_LINES lines)"

# ---- git state: clean, on main, synced ------------------------------------

[ -z "$(git status --porcelain)" ] || die "working tree is not clean — commit or stash first"
ok "working tree clean"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "$DEFAULT_BRANCH" ] || \
    die "on branch '$BRANCH', not '$DEFAULT_BRANCH' — releases are tagged on $DEFAULT_BRANCH (merge the version PR first)"
ok "on $DEFAULT_BRANCH"

info "fetching origin…"
git fetch --quiet origin "$DEFAULT_BRANCH" --tags
LOCAL="$(git rev-parse "$DEFAULT_BRANCH")"
REMOTE="$(git rev-parse "origin/$DEFAULT_BRANCH")"
[ "$LOCAL" = "$REMOTE" ] || \
    die "local $DEFAULT_BRANCH ($LOCAL) != origin/$DEFAULT_BRANCH ($REMOTE) — pull/push so they match before tagging"
ok "$DEFAULT_BRANCH is in sync with origin ($LOCAL)"

# ---- tag must not already exist (local or remote) -------------------------

if git rev-parse "$TAG" >/dev/null 2>&1; then
    die "tag $TAG already exists locally — a released version is never re-tagged. Bump to the next version."
fi
if git ls-remote --tags origin "refs/tags/$TAG" | grep -q "$TAG"; then
    die "tag $TAG already exists on origin — version $VERSION is already released."
fi
ok "tag $TAG does not exist yet"

# ---- main's CI must be green ----------------------------------------------

info "checking CI status on $DEFAULT_BRANCH…"
CI_CONCLUSION="$(gh run list --branch "$DEFAULT_BRANCH" --workflow=ci.yml --limit 1 \
    --json conclusion,headSha -q '.[0].conclusion' 2>/dev/null || echo '')"
CI_SHA="$(gh run list --branch "$DEFAULT_BRANCH" --workflow=ci.yml --limit 1 \
    --json headSha -q '.[0].headSha' 2>/dev/null || echo '')"
if [ "$CI_SHA" != "$LOCAL" ]; then
    warn "latest CI run on $DEFAULT_BRANCH is for $CI_SHA, not the tip $LOCAL — it may still be running"
fi
if [ "$CI_CONCLUSION" != "success" ]; then
    die "CI on $DEFAULT_BRANCH is '${CI_CONCLUSION:-unknown}', not success — do not release on red CI"
fi
ok "CI on $DEFAULT_BRANCH is green"

# ---- local gates (the same ones CI runs) ----------------------------------

info "running local gates (lint, logic tests, EGO validate, pack)…"
if command -v npx >/dev/null 2>&1 && [ -d node_modules ]; then
    make lint
    ok "lint"
else
    warn "skipping lint (node_modules missing — run 'npm ci' for a full check)"
fi
make test-logic >/dev/null && ok "logic tests"
make validate   >/dev/null && ok "EGO validate"
make pack       >/dev/null && ok "pack builds $UUID.shell-extension.zip"
# pack leaves a zip behind (gitignored); remove it so the tree stays clean.
rm -f "$UUID.shell-extension.zip"

# ---- do it -----------------------------------------------------------------

echo
if [ "$DRY_RUN" = "1" ]; then
    warn "DRY_RUN=1 — all checks passed; NOT tagging or pushing."
    warn "To release for real: scripts/release.sh $VERSION"
    exit 0
fi

info "creating annotated tag $TAG at $LOCAL"
# Read the CHANGELOG section as the tag message, so the annotation matches the
# release notes. Literal tag name, no shell expansion in the push target.
TAG_MSG_FILE="$(mktemp)"
trap 'rm -f "$TAG_MSG_FILE"' EXIT
{
    echo "$TAG — see CHANGELOG"
    echo
    awk "/^## \[$VERSION\]/{f=1;next} /^## \[/{f=0} f" "$CHANGELOG"
} > "$TAG_MSG_FILE"
git tag -a "$TAG" -F "$TAG_MSG_FILE" "$DEFAULT_BRANCH"

info "pushing tag $TAG to origin (this triggers the Release workflow)"
git push origin "$TAG"
ok "tag pushed"

# ---- watch the Release workflow -------------------------------------------

info "waiting for the Release workflow to start…"
RUN_ID=""
for _ in $(seq 1 20); do
    sleep 3
    RUN_ID="$(gh run list --workflow=release.yml --limit 1 \
        --json databaseId,headBranch -q \
        ".[] | select(.headBranch==\"$TAG\") | .databaseId" 2>/dev/null | head -1 || true)"
    [ -n "$RUN_ID" ] && break
done

if [ -z "$RUN_ID" ]; then
    warn "could not find the Release run yet — check: gh run list --workflow=release.yml"
else
    info "watching Release run $RUN_ID"
    if gh run watch "$RUN_ID" --exit-status >/dev/null 2>&1; then
        ok "Release workflow succeeded"
    else
        die "Release workflow failed — inspect: gh run view $RUN_ID --log-failed"
    fi
fi

# ---- report ----------------------------------------------------------------

echo
if URL="$(gh release view "$TAG" --json url -q .url 2>/dev/null)"; then
    ok "Release published: $URL"
    gh release view "$TAG" --json assets -q '.assets[].name' | sed 's/^/     asset: /'
else
    warn "tag pushed but no release found yet — the workflow may still be finishing."
    warn "check: gh release view $TAG"
fi
echo
info "Done."
