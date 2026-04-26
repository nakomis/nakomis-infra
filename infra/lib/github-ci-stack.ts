import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface GithubCiStackProps extends cdk.StackProps {
  deployEnv: 'sandbox' | 'prod';
  githubOidcProviderArn: string;
}

export class GithubCiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubCiStackProps) {
    super(scope, id, props);

    const { deployEnv, githubOidcProviderArn } = props;

    const githubOidc = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this, 'GithubOidc', githubOidcProviderArn,
    );

    const role = new iam.Role(this, 'NakomisInfraCiRole', {
      roleName: `nakomis-nakomis-infra-github-ci-${deployEnv}`,
      assumedBy: new iam.WebIdentityPrincipal(
        githubOidc.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': 'repo:nakomis/nakomis-infra:*',
          },
        },
      ),
      description: `Assumed by nakomis-infra GitHub Actions CI (${deployEnv})`,
      inlinePolicies: {
        CdkDeploy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['sts:AssumeRole'],
              resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
            }),
          ],
        }),
      },
    });

    new cdk.CfnOutput(this, 'NakomisInfraCiRoleArn', {
      value: role.roleArn,
      description: `IAM role for nakomis-infra GitHub Actions CI (${deployEnv})`,
    });
  }
}
