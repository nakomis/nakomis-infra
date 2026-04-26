import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AuthStack } from '../lib/auth-stack';

const MOCK_CERT_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000';

function makeStack(deployEnv: 'sandbox' | 'prod' = 'sandbox') {
  const app = new cdk.App();
  const certStack = new cdk.Stack(app, 'CertStack', { env: { account: '123456789012', region: 'us-east-1' } });
  const mockCert = acm.Certificate.fromCertificateArn(certStack, 'MockCert', MOCK_CERT_ARN);
  const stack = new AuthStack(app, 'TestAuthStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
    deployEnv,
    certificate: mockCert,
    crossRegionReferences: true,
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

  test('user pool has explicit name', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'NakomisSandboxUserPool',
    });
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

  test('user pool uses SES for email', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      EmailConfiguration: {
        EmailSendingAccount: 'DEVELOPER',
        From: 'Nakomis <noreply@sandbox.nakomis.com>',
        SourceArn: Match.anyValue(),
      },
    });
  });

  test('sandbox pool uses DESTROY removal policy', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    const pool = Object.values(pools)[0] as { DeletionPolicy?: string; UpdateReplacePolicy?: string };
    expect(pool.DeletionPolicy).toBe('Delete');
    expect(pool.UpdateReplacePolicy).toBe('Delete');
  });

  test('creates a custom domain for login.sandbox.nakomis.com', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'login.sandbox.nakomis.com',
      CustomDomainConfig: {
        CertificateArn: MOCK_CERT_ARN,
      },
    });
  });

  test('creates Route53 A alias record for login domain', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'login.sandbox.nakomis.com.',
      Type: 'A',
    });
  });

  test('creates Route53 AAAA alias record for login domain', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'login.sandbox.nakomis.com.',
      Type: 'AAAA',
    });
  });

  test('creates domain-level managed login branding', () => {
    template.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', {
      UseCognitoProvidedValues: false,
    });
    // No ClientId property — domain-level default
    const brandings = template.findResources('AWS::Cognito::ManagedLoginBranding');
    const branding = Object.values(brandings)[0] as { Properties: Record<string, unknown> };
    expect(branding.Properties['ClientId']).toBeUndefined();
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

  test('exports login domain to SSM', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/nakomis-infra/sandbox/cognito/login-domain',
      Value: 'login.sandbox.nakomis.com',
    });
  });

  test('exposes userPool property', () => {
    const app = new cdk.App();
    const certStack = new cdk.Stack(app, 'CertStack2', { env: { account: '123456789012', region: 'us-east-1' } });
    const mockCert = acm.Certificate.fromCertificateArn(certStack, 'MockCert', MOCK_CERT_ARN);
    const stack = new AuthStack(app, 'TestAuthStackProp', {
      env: { account: '123456789012', region: 'eu-west-2' },
      deployEnv: 'sandbox',
      certificate: mockCert,
      crossRegionReferences: true,
    });
    expect(stack.userPool).toBeDefined();
  });
});

describe('AuthStack — prod', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = makeStack('prod'));
  });

  test('prod pool has explicit name', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'NakomisUserPool',
    });
  });

  test('prod pool uses SES from nakomis.com', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      EmailConfiguration: {
        EmailSendingAccount: 'DEVELOPER',
        From: 'Nakomis <noreply@nakomis.com>',
        SourceArn: Match.anyValue(),
      },
    });
  });

  test('prod pool uses RETAIN removal policy', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    const pool = Object.values(pools)[0] as { DeletionPolicy?: string; UpdateReplacePolicy?: string };
    expect(pool.DeletionPolicy).toBe('Retain');
    expect(pool.UpdateReplacePolicy).toBe('Retain');
  });

  test('creates a custom domain for login.nakomis.com', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'login.nakomis.com',
      CustomDomainConfig: {
        CertificateArn: MOCK_CERT_ARN,
      },
    });
  });

  test('creates Route53 A alias record for prod login domain', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'login.nakomis.com.',
      Type: 'A',
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

  test('exports login domain to SSM with prod path', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/nakomis-infra/prod/cognito/login-domain',
      Value: 'login.nakomis.com',
    });
  });
});
