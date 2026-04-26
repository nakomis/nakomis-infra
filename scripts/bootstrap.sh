#!/usr/bin/env bash
# Bootstrap CDK in sandbox and/or production accounts for nakomis-infra.
#
# Usage:
#   ./scripts/bootstrap.sh sandbox   — bootstrap sandbox only
#   ./scripts/bootstrap.sh prod      — bootstrap prod only
#   ./scripts/bootstrap.sh           — bootstrap both (default)
#
# Prerequisites:
#   1. AWS SSO profiles nakom.is-sandbox and nakom.is-admin must be logged in.
#   2. Run from the repo root (not from infra/).
#
# The sequence for each account is:
#   a) Initial bootstrap with --trust so the CDK toolchain roles exist.
#   b) Deploy GithubCiStack to create the OIDC role.
#   c) Re-bootstrap with --trust pointing at the GitHub CI role so that role
#      can deploy on subsequent runs (used by GitHub Actions).

set -euo pipefail

SANDBOX_ACCOUNT="975050268859"
PROD_ACCOUNT="637423226886"
REGION="eu-west-2"
QUALIFIER="hnb659fds"

SANDBOX_CI_ROLE="nakomis-nakomis-infra-github-ci-sandbox"
PROD_CI_ROLE="nakomis-nakomis-infra-github-ci-prod"

bootstrap_account() {
  local env="$1"
  local account="$2"
  local profile="$3"
  local ci_role="$4"

  echo ""
  echo "=========================================="
  echo "  Bootstrapping: $env ($account)"
  echo "=========================================="

  cd infra
  npm ci --silent

  echo ""
  echo "--- Step 1: Initial CDK bootstrap ---"
  npx cdk bootstrap "aws://${account}/${REGION}" \
    --profile "$profile" \
    --qualifier "$QUALIFIER" \
    --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
    --trust "$account"

  echo ""
  echo "--- Step 2: Deploy GithubCiStack to create OIDC role ---"
  NPM_ENVIRONMENT="$env" npx cdk deploy GithubCiStack \
    --profile "$profile" \
    --require-approval never

  echo ""
  echo "--- Step 3: Re-bootstrap trusting the GitHub CI role ---"
  npx cdk bootstrap "aws://${account}/${REGION}" \
    --profile "$profile" \
    --qualifier "$QUALIFIER" \
    --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
    --trust "$account" \
    --trust-for-lookup "$account"

  echo ""
  echo "Bootstrap complete for $env."
  echo "GitHub Actions can now assume: arn:aws:iam::${account}:role/${ci_role}"

  cd ..
}

TARGET="${1:-both}"

case "$TARGET" in
  sandbox)
    bootstrap_account sandbox "$SANDBOX_ACCOUNT" nakom.is-sandbox "$SANDBOX_CI_ROLE"
    ;;
  prod)
    bootstrap_account prod "$PROD_ACCOUNT" nakom.is-admin "$PROD_CI_ROLE"
    ;;
  both)
    bootstrap_account sandbox "$SANDBOX_ACCOUNT" nakom.is-sandbox "$SANDBOX_CI_ROLE"
    bootstrap_account prod    "$PROD_ACCOUNT"    nakom.is-admin    "$PROD_CI_ROLE"
    ;;
  *)
    echo "Usage: $0 [sandbox|prod|both]"
    exit 1
    ;;
esac

echo ""
echo "All done. Next step: merge the PR and let CI deploy to sandbox automatically."
