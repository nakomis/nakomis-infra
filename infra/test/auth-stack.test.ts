import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AuthStack } from '../lib/auth-stack';

function makeStack(deployEnv: 'sandbox' | 'prod' = 'sandbox') {
  const app = new cdk.App();
  const stack = new AuthStack(app, 'TestAuthStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
    deployEnv,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('AuthStack — sandbox', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = makeStack('sandbox'));
  });

  test('creates a Cognito User Pool', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  test('user pool allows sign-in by username and email', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: Match.absent(),
      AliasAttributes: Match.arrayWith(['email']),
    });
  });

  test('self-registration is disabled', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: true,
      },
    });
  });

  test('sandbox pool uses DESTROY removal policy', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    const pool = Object.values(pools)[0] as { DeletionPolicy?: string; UpdateReplacePolicy?: string };
    expect(pool.DeletionPolicy).toBe('Delete');
    expect(pool.UpdateReplacePolicy).toBe('Delete');
  });

  test('creates a Cognito User Pool domain with sandbox prefix', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'nakomis-sandbox',
    });
  });

  test('exports user pool ID to SSM', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/nakomis-infra/sandbox/cognito/user-pool-id',
      Type: 'String',
    });
  });

  test('exports user pool ARN to SSM', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/nakomis-infra/sandbox/cognito/user-pool-arn',
      Type: 'String',
    });
  });

  test('exposes userPool property', () => {
    const app = new cdk.App();
    const stack = new AuthStack(app, 'TestAuthStackProp', {
      env: { account: '123456789012', region: 'eu-west-2' },
      deployEnv: 'sandbox',
    });
    expect(stack.userPool).toBeDefined();
  });
});

describe('AuthStack — prod', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = makeStack('prod'));
  });

  test('prod pool uses RETAIN removal policy', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    const pool = Object.values(pools)[0] as { DeletionPolicy?: string; UpdateReplacePolicy?: string };
    expect(pool.DeletionPolicy).toBe('Retain');
    expect(pool.UpdateReplacePolicy).toBe('Retain');
  });

  test('creates a Cognito User Pool domain with prod prefix', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'nakomis-prod',
    });
  });

  test('exports user pool ID to SSM with prod path', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/nakomis-infra/prod/cognito/user-pool-id',
      Type: 'String',
    });
  });

  test('exports user pool ARN to SSM with prod path', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/nakomis-infra/prod/cognito/user-pool-arn',
      Type: 'String',
    });
  });
});
