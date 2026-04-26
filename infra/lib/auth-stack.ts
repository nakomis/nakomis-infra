import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  deployEnv: 'sandbox' | 'prod';
  certificate: acm.ICertificate;
}

const HOSTED_ZONES = {
  sandbox: { hostedZoneId: 'Z03586633NXU18LFL0JTL', zoneName: 'sandbox.nakomis.com' },
  prod:    { hostedZoneId: 'Z019437529YGFB53BDUGR', zoneName: 'nakomis.com' },
};

export class AuthStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { deployEnv, certificate } = props;
    const isProd = deployEnv === 'prod';
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const { hostedZoneId, zoneName } = HOSTED_ZONES[deployEnv];
    const loginDomain = `login.${zoneName}`;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: isProd ? 'NakomisUserPool' : 'NakomisSandboxUserPool',
      signInAliases: { username: true, email: true },
      selfSignUpEnabled: false,
      removalPolicy,
      email: cognito.UserPoolEmail.withSES({
        fromEmail: `noreply@${zoneName}`,
        fromName: 'Nakomis',
        sesRegion: 'eu-west-2',
        sesVerifiedDomain: zoneName,
      }),
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId,
      zoneName,
    });

    const domain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool: this.userPool,
      customDomain: { domainName: loginDomain, certificate },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    new route53.ARecord(this, 'LoginAliasA', {
      recordName: loginDomain,
      zone,
      target: route53.RecordTarget.fromAlias(new route53Targets.UserPoolDomainTarget(domain)),
    });

    new route53.AaaaRecord(this, 'LoginAliasAaaa', {
      recordName: loginDomain,
      zone,
      target: route53.RecordTarget.fromAlias(new route53Targets.UserPoolDomainTarget(domain)),
    });

    // Domain-level branding (no clientId) — applies as default for all clients.
    // One Dark theme copied from sandboxsite CognitoStack.
    const branding = new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      useCognitoProvidedValues: false,
      settings: {
        components: {
          pageBackground: {
            image: { enabled: false },
            darkMode: { color: '282c34ff' },
          },
          pageHeader: {
            backgroundImage: { enabled: false },
            logo: { location: 'START', enabled: false },
            darkMode: { background: { color: '21252bff' }, borderColor: '3e4451ff' },
          },
          pageFooter: {
            backgroundImage: { enabled: false },
            logo: { location: 'START', enabled: false },
            darkMode: { background: { color: '21252bff' }, borderColor: '3e4451ff' },
          },
          form: {
            borderRadius: 8,
            backgroundImage: { enabled: false },
            logo: { location: 'CENTER', position: 'TOP', enabled: false, formInclusion: 'IN' },
            darkMode: { backgroundColor: '2c313aff', borderColor: '3e4451ff' },
          },
          pageText: {
            darkMode: { bodyColor: 'abb2bfff', headingColor: 'ffffffff', descriptionColor: '5c6370ff' },
          },
          primaryButton: {
            darkMode: {
              defaults: { backgroundColor: '2563ebff', textColor: 'ffffffff' },
              hover:    { backgroundColor: '1d4ed8ff', textColor: 'ffffffff' },
              active:   { backgroundColor: '1e40afff', textColor: 'ffffffff' },
              disabled: { backgroundColor: '2c313aff', borderColor: '3e4451ff' },
            },
          },
          secondaryButton: {
            darkMode: {
              defaults: { backgroundColor: '2c313aff', borderColor: '3e4451ff', textColor: 'abb2bfff' },
              hover:    { backgroundColor: '353b45ff', borderColor: '528bffff', textColor: 'ffffffff' },
              active:   { backgroundColor: '21252bff', borderColor: '3e4451ff', textColor: 'ffffffff' },
            },
          },
          alert: {
            borderRadius: 4,
            darkMode: { error: { backgroundColor: '3a1515ff', borderColor: 'e06c75ff' } },
          },
          idpButton: {
            standard: {
              darkMode: {
                defaults: { backgroundColor: '2c313aff', borderColor: '3e4451ff', textColor: 'abb2bfff' },
                hover:    { backgroundColor: '353b45ff', borderColor: '528bffff', textColor: 'ffffffff' },
                active:   { backgroundColor: '21252bff', borderColor: '3e4451ff', textColor: 'ffffffff' },
              },
            },
            custom: {},
          },
          phoneNumberSelector: { displayType: 'TEXT' },
          favicon: { enabledTypes: ['ICO', 'SVG'] },
        },
        componentClasses: {
          input: {
            borderRadius: 6,
            darkMode: {
              defaults: { backgroundColor: '21252bff', borderColor: '3e4451ff' },
              placeholderColor: '5c6370ff',
            },
          },
          inputLabel: {
            darkMode: { textColor: 'abb2bfff' },
          },
          inputDescription: {
            darkMode: { textColor: '5c6370ff' },
          },
          link: {
            darkMode: { defaults: { textColor: '61afefff' }, hover: { textColor: '528bffff' } },
          },
          optionControls: {
            darkMode: {
              defaults: { backgroundColor: '21252bff', borderColor: '3e4451ff' },
              selected: { backgroundColor: '2563ebff', foregroundColor: 'ffffffff' },
            },
          },
          focusState: {
            darkMode: { borderColor: '528bffff' },
          },
        },
        categories: {
          global: {
            colorSchemeMode: 'DARK',
            pageFooter: { enabled: false },
            pageHeader: { enabled: false },
            spacingDensity: 'REGULAR',
          },
        },
      },
    });
    branding.node.addDependency(domain);

    new ssm.StringParameter(this, 'UserPoolIdParam', {
      parameterName: `/nakomis-infra/${deployEnv}/cognito/user-pool-id`,
      stringValue: this.userPool.userPoolId,
      description: `Shared Cognito User Pool ID (${deployEnv})`,
    });

    new ssm.StringParameter(this, 'UserPoolArnParam', {
      parameterName: `/nakomis-infra/${deployEnv}/cognito/user-pool-arn`,
      stringValue: this.userPool.userPoolArn,
      description: `Shared Cognito User Pool ARN (${deployEnv})`,
    });

    new ssm.StringParameter(this, 'LoginDomainParam', {
      parameterName: `/nakomis-infra/${deployEnv}/cognito/login-domain`,
      stringValue: loginDomain,
      description: `Managed login domain for the shared Cognito pool (${deployEnv})`,
    });
  }
}
