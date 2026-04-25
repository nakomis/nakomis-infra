# nakomis-infra — Shared Cloud Infrastructure CDK Stacks

Shared AWS infrastructure for the nakomis project family — Cognito user pools, shared IAM roles, and cross-project resources managed as AWS CDK stacks.

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=nakomis-infra)

## Table of Contents

<!-- toc -->

- [Architecture Diagram](#architecture-diagram)
- [Repository Layout](#repository-layout)
- [Infrastructure](#infrastructure)
- [Architecture Diagrams](#architecture-diagrams)

<!-- tocstop -->

## Architecture Diagram

![Architecture](docs/architecture/nakomis-infra.svg)

## Repository Layout

- `infra/` — AWS CDK project (TypeScript)
- `docs/architecture/` — architecture diagram source (draw.io) and exported SVG
- `.githooks/` — git hooks (SVG auto-generation on commit)

## Infrastructure

Two CDK stacks per environment (sandbox + production):

| Stack | Purpose |
|-------|---------|
| `AuthStack` | Shared Cognito User Pool — one per AWS account |
| `GithubCiStack` | GitHub Actions OIDC role for CI/CD |

Pool IDs and ARNs are exported to SSM Parameter Store so consuming projects can reference them without hard-coding:

- `/nakomis-infra/{env}/cognito/user-pool-id`
- `/nakomis-infra/{env}/cognito/user-pool-arn`

### Deploying

```bash
cd infra
npm install

# Sandbox
AWS_PROFILE=nakom.is-sandbox npm run synth-sandbox
AWS_PROFILE=nakom.is-sandbox npx cdk deploy --all

# Production
AWS_PROFILE=nakom.is-admin npm run synth-prod
AWS_PROFILE=nakom.is-admin npx cdk deploy --all
```

## Architecture Diagrams

`docs/architecture/nakomis-infra.drawio` is the source for the diagram above. The SVG is auto-regenerated on commit by the pre-commit hook in `.githooks/pre-commit`.

To activate the hook after cloning:

```bash
git config core.hooksPath .githooks
```

To regenerate manually:

```bash
/Applications/draw.io.app/Contents/MacOS/draw.io -x docs/architecture/nakomis-infra.drawio -f svg -s 1 docs/architecture/nakomis-infra.svg
```

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=nakomis-infra)
