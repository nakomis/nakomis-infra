import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
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

    // SES custom MAIL FROM domain — improves DMARC alignment by matching the sending domain.
    const mailFromDomain = `bounce.${zoneName}`;

    new route53.MxRecord(this, 'MailFromMx', {
      recordName: mailFromDomain,
      zone,
      values: [{ priority: 10, hostName: `feedback-smtp.${this.region}.amazonses.com` }],
      ttl: cdk.Duration.minutes(5),
    });

    new route53.TxtRecord(this, 'MailFromSpf', {
      recordName: mailFromDomain,
      zone,
      values: ['v=spf1 include:amazonses.com ~all'],
      ttl: cdk.Duration.minutes(5),
    });

    new cr.AwsCustomResource(this, 'SesMailFrom', {
      onCreate: {
        service: 'SESV2',
        action: 'PutEmailIdentityMailFromAttributes',
        parameters: {
          EmailIdentity: zoneName,
          MailFromDomain: mailFromDomain,
          BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`ses-mail-from-${zoneName}`),
      },
      onUpdate: {
        service: 'SESV2',
        action: 'PutEmailIdentityMailFromAttributes',
        parameters: {
          EmailIdentity: zoneName,
          MailFromDomain: mailFromDomain,
          BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`ses-mail-from-${zoneName}`),
      },
      onDelete: {
        service: 'SESV2',
        action: 'PutEmailIdentityMailFromAttributes',
        parameters: {
          EmailIdentity: zoneName,
          BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`ses-mail-from-${zoneName}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['ses:PutEmailIdentityMailFromAttributes'],
          resources: [`arn:aws:ses:${this.region}:${this.account}:identity/${zoneName}`],
        }),
      ]),
    });

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
