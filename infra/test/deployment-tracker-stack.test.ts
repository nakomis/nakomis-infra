import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DeploymentTrackerStack } from '../lib/deployment-tracker-stack';

function makeStack(deployEnv: 'sandbox' | 'prod' = 'prod') {
  const app = new cdk.App();
  const stack = new DeploymentTrackerStack(app, 'TestDeploymentTrackerStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
    deployEnv,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('DeploymentTrackerStack — prod', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = makeStack('prod'));
  });

  test('creates a DynamoDB table with correct key schema', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'nakomis-deployments',
      KeySchema: Match.arrayWith([
        { AttributeName: 'projectEnv', KeyType: 'HASH' },
        { AttributeName: 'deployedAt', KeyType: 'RANGE' },
      ]),
    });
  });

  test('table uses PAY_PER_REQUEST billing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('table has TTL enabled on the ttl attribute', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });

  test('prod table uses RETAIN removal policy', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    const table = Object.values(tables)[0] as { DeletionPolicy?: string };
    expect(table.DeletionPolicy).toBe('Retain');
  });

  test('creates a Lambda function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'nakomis-deployment-tracker',
      Runtime: 'nodejs22.x',
    });
  });

  test('Lambda has TABLE_NAME environment variable', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('creates a REST API', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'nakomis-deployment-tracker',
    });
  });

  test('API resource policy allows nakostat sandbox CI role', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Policy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: Match.objectLike({
              AWS: Match.arrayWith([
                Match.stringLikeRegexp('nakomis-nakostat-github-ci-sandbox'),
              ]),
            }),
            Action: 'execute-api:Invoke',
          }),
        ]),
      }),
    });
  });

  test('API resource policy allows nakostat prod CI role', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Policy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: Match.objectLike({
              AWS: Match.arrayWith([
                Match.stringLikeRegexp('nakomis-nakostat-github-ci-prod'),
              ]),
            }),
          }),
        ]),
      }),
    });
  });

  test('PUT /deployments/{project}/{environment} uses IAM auth', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'PUT',
      AuthorizationType: 'AWS_IAM',
    });
  });

  test('GET /deployments/{project}/{environment} uses IAM auth', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'AWS_IAM',
    });
  });

  test('outputs the API URL', () => {
    template.hasOutput('ApiUrl', {
      Description: Match.stringLikeRegexp('prod'),
    });
  });

  test('outputs the table name', () => {
    template.hasOutput('TableName', {});
  });

  test('exposes apiUrl property', () => {
    const app = new cdk.App();
    const stack = new DeploymentTrackerStack(app, 'PropTestStack', {
      env: { account: '123456789012', region: 'eu-west-2' },
      deployEnv: 'prod',
    });
    expect(stack.apiUrl).toBeDefined();
  });
});

describe('DeploymentTrackerStack — sandbox', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = makeStack('sandbox'));
  });

  test('sandbox table has do-not-use- prefix', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'do-not-use-nakomis-deployments',
    });
  });

  test('sandbox Lambda has do-not-use- prefix', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'do-not-use-nakomis-deployment-tracker',
    });
  });

  test('sandbox API has do-not-use- prefix', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'do-not-use-nakomis-deployment-tracker',
    });
  });

  test('sandbox table uses DESTROY removal policy', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    const table = Object.values(tables)[0] as { DeletionPolicy?: string };
    expect(table.DeletionPolicy).toBe('Delete');
  });
});
