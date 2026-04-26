import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface DeploymentTrackerStackProps extends cdk.StackProps {
  deployEnv: 'sandbox' | 'prod';
}

// CI roles across all accounts that are permitted to record deployments.
// Add new project CI roles here as they are created.
const ALLOWED_CI_ROLE_ARNS = [
  'arn:aws:iam::975050268859:role/nakomis-nakostat-github-ci-sandbox',
  'arn:aws:iam::637423226886:role/nakomis-nakostat-github-ci-prod',
  'arn:aws:iam::975050268859:role/nakomis-nakomis-infra-github-ci-sandbox',
  'arn:aws:iam::637423226886:role/nakomis-nakomis-infra-github-ci-prod',
];

export class DeploymentTrackerStack extends cdk.Stack {
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: DeploymentTrackerStackProps) {
    super(scope, id, props);

    const { deployEnv } = props;
    const isProd = deployEnv === 'prod';
    // Sandbox stack exists for CDK consistency but is not used — prefix discourages accidental use.
    const prefix = isProd ? '' : 'do-not-use-';

    const table = new dynamodb.Table(this, 'DeploymentsTable', {
      tableName: `${prefix}nakomis-deployments`,
      partitionKey: { name: 'projectEnv', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'deployedAt',  type: dynamodb.AttributeType.STRING },
      billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    const logGroup = new logs.LogGroup(this, 'HandlerLogs', {
      logGroupName: `/aws/lambda/${prefix}nakomis-deployment-tracker`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const handler = new lambdaNode.NodejsFunction(this, 'Handler', {
      functionName: `${prefix}nakomis-deployment-tracker`,
      entry: path.join(__dirname, '../lambda/deployment-tracker/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: { TABLE_NAME: table.tableName },
      logGroup,
      bundling: {
        // Bundle @aws-sdk/lib-dynamodb (DocumentClient) since it may not be in the Lambda runtime.
        // Externalise the base client, which is always present in Node 22.
        externalModules: ['@aws-sdk/client-dynamodb'],
      },
    });

    table.grantReadWriteData(handler);

    const resourcePolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          principals: ALLOWED_CI_ROLE_ARNS.map(arn => new iam.ArnPrincipal(arn)),
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*'],
        }),
      ],
    });

    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${prefix}nakomis-deployment-tracker`,
      description: `Nakomis deployment tracker API (${deployEnv})`,
      policy: resourcePolicy,
    });

    const integration = new apigateway.LambdaIntegration(handler);
    const iamAuth = { authorizationType: apigateway.AuthorizationType.IAM };

    const projectResource     = api.root.addResource('deployments')
                                        .addResource('{project}')
                                        .addResource('{environment}');
    projectResource.addMethod('PUT', integration, iamAuth);
    projectResource.addMethod('GET', integration, iamAuth);
    projectResource.addResource('latest').addMethod('GET', integration, iamAuth);

    this.apiUrl = api.url;

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: `Deployment tracker API URL (${deployEnv})`,
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: `Deployment tracker DynamoDB table (${deployEnv})`,
    });
  }
}
