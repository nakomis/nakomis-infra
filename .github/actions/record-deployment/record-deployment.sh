#!/usr/bin/env bash
#
# Record a deployment in the shared deployment tracker (nakomis-deployments).
# Reusable across projects via the record-deployment composite action.
#
# Non-fatal by design: a tracker outage — or the tracker simply not being wired
# up for this project yet — must never fail a deployment. Failures are logged;
# the script always exits 0.
#
# Inputs (env vars, set by action.yml):
#   PROJECT       tracker project key, e.g. home-portal        [required]
#   ENVIRONMENT   sandbox | prod                               [required]
#   VERSION_FILE  path to the version.json to read             [default version.json]
#   API_BASE      tracker API base URL                         [default https://api.infra.nakomis.com]
set -uo pipefail

PROJECT="${PROJECT:?PROJECT is required}"
ENVIRONMENT="${ENVIRONMENT:?ENVIRONMENT is required}"
VERSION_FILE="${VERSION_FILE:-version.json}"
API_BASE="${API_BASE:-https://api.infra.nakomis.com}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-west-2}}"
TRACKER_URL="${API_BASE}/deployments/${PROJECT}/${ENVIRONMENT}"

VERSION="$(jq -r '.version' "$VERSION_FILE" 2>/dev/null || echo unknown)"

if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]; then
  echo "No AWS credentials — skipping deployment record" >&2
  exit 0
fi

BODY="$(jq -nc \
  --arg version "$VERSION" \
  --arg commitHash "$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
  --arg branch "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)" \
  '{version: $version, commitHash: $commitHash, branch: $branch, deployedBy: "github-actions"}')"

SIGV4=(--aws-sigv4 "aws:amz:${REGION}:execute-api"
       --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}")
if [[ -n "${AWS_SESSION_TOKEN:-}" ]]; then
  SIGV4+=(-H "x-amz-security-token: ${AWS_SESSION_TOKEN}")
fi

HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${SIGV4[@]}" \
  -X PUT -H 'Content-Type: application/json' -d "$BODY" \
  "$TRACKER_URL" 2>/dev/null || echo 000)"

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "Recorded ${PROJECT} ${VERSION} → ${ENVIRONMENT} in the deployment tracker"
else
  echo "WARNING: could not record deployment (HTTP ${HTTP_CODE}) — the tracker" \
       "may not be wired up for ${PROJECT} yet. Continuing." >&2
fi
exit 0
