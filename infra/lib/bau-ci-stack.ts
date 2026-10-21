import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** Account hosting the shared deployment tracker (the nakomis prod account). */
const DEPLOYMENT_TRACKER_ACCOUNT = '637423226886';

export interface BauCiStackProps extends cdk.StackProps {
  githubOidcProviderArn: string;
}

/**
 * CI role for nakomis/bau, which has no CDK of its own. It exists only so bau's
 * workflows can use the shared compute-version and record-deployment actions,
 * so its sole permission is calling the deployment tracker. Sandbox account only.
 */
export class BauCiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BauCiStackProps) {
    super(scope, id, props);

    const githubOidc = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this, 'GithubOidc', props.githubOidcProviderArn,
    );

    const role = new iam.Role(this, 'BauCiRole', {
      roleName: 'nakomis-bau-github-ci-sandbox',
      assumedBy: new iam.WebIdentityPrincipal(githubOidc.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        // GitHub issues either repo:OWNER@OWNER_ID/REPO@REPO_ID:CONTEXT (immutable
        // ids) or the older repo:OWNER/REPO:CONTEXT. A list is an OR, so accept both.
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            'repo:nakomis@1488244/bau@1419292004:*',
            'repo:nakomis/bau:*',
          ],
        },
      }),
      description: 'Assumed by nakomis/bau GitHub Actions CI (sandbox)',
      inlinePolicies: {
        // The tracker is a REST API in the prod account, so this sandbox role calls
        // it cross-account and needs this identity grant as well as the tracker's
        // resource-policy allow-list.
        DeploymentTracker: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['execute-api:Invoke'],
              resources: [
                `arn:aws:execute-api:eu-west-2:${DEPLOYMENT_TRACKER_ACCOUNT}:*/*/*/deployments/*`,
              ],
            }),
          ],
        }),
      },
    });

    new cdk.CfnOutput(this, 'BauCiRoleArn', {
      value: role.roleArn,
      description: 'IAM role for nakomis/bau GitHub Actions CI (sandbox)',
    });
  }
}
