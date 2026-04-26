import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  deployEnv: 'sandbox' | 'prod';
}

export class AuthStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { deployEnv } = props;
    const removalPolicy = deployEnv === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      signInAliases: {
        username: true,
        email: true,
      },
      selfSignUpEnabled: false,
      removalPolicy,
    });

    new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool: this.userPool,
      cognitoDomain: {
        domainPrefix: `nakomis-${deployEnv}`,
      },
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
  }
}
