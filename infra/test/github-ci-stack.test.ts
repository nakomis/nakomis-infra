import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GithubCiStack } from '../lib/github-ci-stack';

const SANDBOX_OIDC_ARN = 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';

function makeStack(deployEnv: 'sandbox' | 'prod' = 'sandbox') {
  const app = new cdk.App();
  const stack = new GithubCiStack(app, 'TestGithubCiStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
    deployEnv,
    githubOidcProviderArn: SANDBOX_OIDC_ARN,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('GithubCiStack — sandbox', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = makeStack('sandbox'));
  });

  test('creates an IAM role', () => {
    template.resourceCountIs('AWS::IAM::Role', 1);
  });

  test('role is named nakomis-nakomis-infra-github-ci-sandbox', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'nakomis-nakomis-infra-github-ci-sandbox',
    });
  });

  test('role trusts GitHub Actions OIDC for nakomis/nakomis-infra', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Federated: SANDBOX_OIDC_ARN },
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub': 'repo:nakomis/nakomis-infra:*',
              },
            }),
          }),
        ]),
      }),
    });
  });

  test('role has CDK deploy permissions', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: 'sts:AssumeRole',
                Resource: 'arn:aws:iam::123456789012:role/cdk-hnb659fds-*',
              }),
            ]),
          }),
        }),
      ]),
    });
  });

  test('outputs the role ARN', () => {
    template.hasOutput('NakomisInfraCiRoleArn', {
      Description: Match.stringLikeRegexp('sandbox'),
    });
  });
});

describe('GithubCiStack — prod', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = makeStack('prod'));
  });

  test('role is named nakomis-nakomis-infra-github-ci-prod', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'nakomis-nakomis-infra-github-ci-prod',
    });
  });
});
