import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BauCiStack } from '../lib/bau-ci-stack';

const OIDC_ARN = 'arn:aws:iam::975050268859:oidc-provider/token.actions.githubusercontent.com';

describe('BauCiStack', () => {
  const app = new cdk.App();
  const stack = new BauCiStack(app, 'TestBauCiStack', {
    env: { account: '975050268859', region: 'eu-west-2' },
    githubOidcProviderArn: OIDC_ARN,
  });
  const template = Template.fromStack(stack);

  test('creates exactly one role, named for the sandbox', () => {
    template.resourceCountIs('AWS::IAM::Role', 1);
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'nakomis-bau-github-ci-sandbox',
    });
  });

  test('trusts GitHub OIDC for bau by both id-form and name-form subjects', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Federated: OIDC_ARN },
            Condition: {
              StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
              StringLike: {
                'token.actions.githubusercontent.com:sub': [
                  'repo:nakomis@1488244/bau@1419292004:*',
                  'repo:nakomis/bau:*',
                ],
              },
            },
          }),
        ]),
      }),
    });
  });

  test('may only invoke the deployment tracker in the prod account', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: [
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: [
              {
                Action: 'execute-api:Invoke',
                Effect: 'Allow',
                Resource: 'arn:aws:execute-api:eu-west-2:637423226886:*/*/*/deployments/*',
              },
            ],
          }),
        }),
      ],
    });
  });
});
