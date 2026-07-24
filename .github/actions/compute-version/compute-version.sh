#!/usr/bin/env bash
#
# Compute the next semantic version from the shared deployment tracker
# (nakomis-deployments) and write it to a version.json. Reusable across projects
# via the compute-version composite action.
#
# Inputs (env vars, set by action.yml):
#   PROJECT       tracker project key, e.g. home-portal          [required]
#   VERSION_FILE  path to write version.json (relative to CWD)   [default version.json]
#   API_BASE      tracker API base URL                           [default https://api.infra.nakomis.com]
#   TRACK_ENV     env whose /latest is the high-water mark        [default sandbox]
#
# The previous version is read from the tracker; if it is unreachable — not
# wired up, no record, no credentials — the committed VERSION_FILE is used, or
# 0.1.0 if that is absent too. The sandbox environment is the high-water mark:
# it always deploys, whereas prod may lag a pending approval.
#
# The bump is driven by the latest commit message (which, on a squash merge,
# carries the PR title + description). The keyword must sit ALONE on its own
# line — this is deliberate, so that merely *mentioning* --bump-major in prose
# (e.g. a PR that documents this very mechanism) can't trigger a bump:
#   a line that is exactly  --bump-major  →  X.0.0
#   a line that is exactly  --bump-minor  →  0.X.0
#   (neither present)                     →  0.0.X
#
# The new version is written to VERSION_FILE, echoed to stdout, and — when
# running inside GitHub Actions — appended to $GITHUB_OUTPUT as `version`, so CI
# can compute it once and deploy the *same* value to every environment.
set -euo pipefail

PROJECT="${PROJECT:?PROJECT is required}"
VERSION_FILE="${VERSION_FILE:-version.json}"
API_BASE="${API_BASE:-https://api.infra.nakomis.com}"
TRACK_ENV="${TRACK_ENV:-sandbox}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-west-2}}"
TRACKER_URL="${API_BASE}/deployments/${PROJECT}/${TRACK_ENV}/latest"

LATEST=""
if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
  SIGV4=(--aws-sigv4 "aws:amz:${REGION}:execute-api"
         --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}")
  if [[ -n "${AWS_SESSION_TOKEN:-}" ]]; then
    SIGV4+=(-H "x-amz-security-token: ${AWS_SESSION_TOKEN}")
  fi
  RESPONSE="$(curl -sS "${SIGV4[@]}" "$TRACKER_URL" 2>/dev/null || true)"
  LATEST="$(jq -r '.version // empty' <<< "$RESPONSE" 2>/dev/null || true)"
fi

if [[ -n "$LATEST" ]]; then
  CURRENT="$LATEST"
elif [[ -f "$VERSION_FILE" ]]; then
  CURRENT="$(jq -r '.version // "0.1.0"' "$VERSION_FILE")"
else
  CURRENT="0.1.0"
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
MAJOR="${MAJOR:-0}"
MINOR="${MINOR:-1}"
PATCH="${PATCH:-0}"

MESSAGE="${COMMIT_MESSAGE:-$(git log -1 --pretty=%B 2>/dev/null || true)}"
# Match the keyword only when it is alone on a line (optional surrounding
# whitespace). Anchoring this way means prose that references the flag —
# "bumped from the --bump-major/--bump-minor keyword" — never trips a bump.
if grep -qE '^[[:space:]]*--bump-major[[:space:]]*$' <<< "$MESSAGE"; then
  MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0
elif grep -qE '^[[:space:]]*--bump-minor[[:space:]]*$' <<< "$MESSAGE"; then
  MINOR=$((MINOR + 1)); PATCH=0
else
  PATCH=$((PATCH + 1))
fi

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
mkdir -p "$(dirname "$VERSION_FILE")"
printf '{\n  "version": "%s"\n}\n' "$NEW_VERSION" > "$VERSION_FILE"
echo "${PROJECT} version: ${CURRENT} → ${NEW_VERSION}" >&2
echo "$NEW_VERSION"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "version=${NEW_VERSION}" >> "$GITHUB_OUTPUT"
fi
