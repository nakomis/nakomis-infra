# nakomis-infra

Shared AWS infrastructure for the nakomis project family — Cognito user pools, shared IAM, and cross-project resources managed as AWS CDK stacks.

## AWS credentials

- Sandbox: `AWS_PROFILE=nakom.is-sandbox`
- Production: `AWS_PROFILE=nakom.is-admin`

Always use `cdk` directly (via `npm run` scripts), never bare `npx cdk` — the latter can lose SSO auth context.

## Repository layout

- `infra/` — AWS CDK project (TypeScript)
- `docs/architecture/` — architecture diagram source (draw.io) and exported SVG
- `.githooks/` — git hooks (SVG auto-generation on commit)

## Testing

```bash
cd infra
npm test           # Jest unit tests
npm test -- --coverage  # with coverage report
```

CI enforces a minimum **70% line coverage** across all CDK stacks. Aim higher.

Write tests before implementation (TDD). Every stack should have a corresponding test file in `infra/test/`.

## CDK conventions

- `deployEnv: 'sandbox' | 'prod'` prop on all stacks
- Resource names include the env suffix: `nakomis-infra-{resource}-{env}`
- Sandbox: `DESTROY` removal policy; Prod: `RETAIN`
- SSM Parameter Store for cross-stack/cross-project exports (no CloudFormation exports)
- Account IDs: sandbox `975050268859`, prod `637423226886`; region `eu-west-2`

## Architecture diagrams

Source: `docs/architecture/nakomis-infra.drawio` — SVG auto-regenerated on commit by `.githooks/pre-commit`.

To activate the hook after cloning:
```bash
git config core.hooksPath .githooks
```
