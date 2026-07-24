# Shared deployment-tracker actions

Two composite actions that let any nakomis project use the shared
**deployment-version tracker** (the `nakomis-deployments` table + the
`api.infra.nakomis.com` REST API defined by `infra/lib/deployment-tracker-stack.ts`)
without copy-pasting the CI logic.

| Action | What it does |
|--------|--------------|
| [`compute-version`](compute-version/action.yml) | Reads the current version from the tracker, bumps it from the commit / PR-description keyword, writes `version.json`, and outputs the new version. |
| [`record-deployment`](record-deployment/action.yml) | Records a successful deploy (`version`, `commitHash`, `branch`, `deployedBy`) against `<project>#<environment>`. Non-fatal — a tracker outage never fails a deploy. |

The **prod** tracker (`https://api.infra.nakomis.com`) is the single source of
truth; the environment (`sandbox`/`prod`) lives in the request path, not the
host. Compute the version **once** and deploy that same value to every
environment so a release never changes version between sandbox and prod.

## Bump keywords

The next version is derived from the merged commit message — which, on a squash
merge, carries the PR title and description. The keyword must sit **alone on its
own line** (put it on its own line in the PR description):

- a line that is exactly `--bump-major` → `X.0.0`
- a line that is exactly `--bump-minor` → `0.X.0`
- _(neither)_ → `0.0.X` (patch)

The own-line rule is deliberate: it means a PR that merely *mentions*
`--bump-major` in prose — for instance one documenting this mechanism — does not
accidentally bump the major version.

## Prerequisites (one-off, per adopting project)

1. **Allow-list the project's CI role ARNs** in `ALLOWED_CI_ROLE_ARNS` in
   `infra/lib/deployment-tracker-stack.ts` (sandbox **and** prod), then redeploy
   the tracker. The naming convention is
   `arn:aws:iam::<account>:role/nakomis-<project>-github-ci-<env>`.
2. **Grant the CI role `execute-api:Invoke`** on the tracker in the role's own
   identity policy — the tracker is a REST API in the **prod** account, so the
   **sandbox** role calls it cross-account, and cross-account API Gateway access
   needs *both* the resource-policy allow-list (step 1) *and* this identity
   grant. Same-account (the prod role) works on the resource policy alone, so a
   missing grant looks like "prod records, sandbox 403s". Scope it to the
   tracker: `arn:aws:execute-api:<region>:<tracker-account>:*/*/*/deployments/*`.
3. In the calling job, **configure AWS credentials first**
   (`aws-actions/configure-aws-credentials`) using that role — the actions read
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` from the
   environment and sign the request with SigV4.
4. **Check out the repo** (`actions/checkout`) before `compute-version` — it
   reads the commit message and writes `version.json` into the workspace.

## Inputs

### `compute-version`
| Input | Required | Default | |
|-------|----------|---------|-|
| `project` | yes | — | Tracker project key, e.g. `home-portal`. |
| `version-file` | no | `version.json` | Where to write the computed version, relative to the workspace. |
| `environment` | no | `sandbox` | Which env's `/latest` is the high-water mark to bump from. |
| `api-base` | no | `https://api.infra.nakomis.com` | Tracker API base URL. |

Output: `version` — the computed semver (also written to `version-file`).

### `record-deployment`
| Input | Required | Default | |
|-------|----------|---------|-|
| `project` | yes | — | Tracker project key. |
| `environment` | yes | — | `sandbox` or `prod`. |
| `version-file` | no | `version.json` | The `version.json` to read the version from. |
| `api-base` | no | `https://api.infra.nakomis.com` | Tracker API base URL. |

## Usage

Compute the version once in its own job, pass `version.json` to the deploy jobs
as an artifact, and record after each environment deploys:

```yaml
jobs:
  version:
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read }
    outputs:
      version: ${{ steps.v.outputs.version }}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::975050268859:role/nakomis-home-infra-github-ci-sandbox
          aws-region: eu-west-2
      - id: v
        uses: nakomis/nakomis-infra/.github/actions/compute-version@main
        with:
          project: home-portal
          version-file: web/src/version.json
      - uses: actions/upload-artifact@v4
        with: { name: version, path: web/src/version.json }

  deploy-sandbox:
    needs: version
    runs-on: ubuntu-latest
    environment: sandbox
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: version, path: web/src }
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::975050268859:role/nakomis-home-infra-github-ci-sandbox
          aws-region: eu-west-2
      # ... build + deploy using web/src/version.json ...
      - uses: nakomis/nakomis-infra/.github/actions/record-deployment@main
        with:
          project: home-portal
          environment: sandbox
          version-file: web/src/version.json
```

The `deploy-prod` job follows the same shape: download the **same** `version`
artifact (never recompute), deploy, then `record-deployment` with
`environment: prod`.

Reference implementation: **blog-pipeline** (`.github/workflows/ci.yml`), the
first adopter and the source these actions were generalised from.
