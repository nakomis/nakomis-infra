import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FirmwareStack } from '../lib/firmware-stack';

function makeTemplate(deployEnv: 'sandbox' | 'prod') {
  const app = new cdk.App();
  const stack = new FirmwareStack(app, `TestFirmwareStack-${deployEnv}`, {
    env: { account: '123456789012', region: 'eu-west-2' },
    deployEnv,
  });
  return Template.fromStack(stack);
}

describe.each(['sandbox', 'prod'] as const)('FirmwareStack — %s', deployEnv => {
  let template: Template;

  beforeAll(() => {
    template = makeTemplate(deployEnv);
  });

  test('creates a versioned, encrypted bucket named for the env', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: `nakomis-firmware-${deployEnv}`,
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: Match.objectLike({}),
    });
  });

  test('bucket blocks all public access (downloads use presigned URLs)', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('bucket policy denies non-TLS access', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  test('bucket is retained on stack deletion', () => {
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  });

  test('expires noncurrent versions and aborts incomplete uploads', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 }, Status: 'Enabled' }),
          Match.objectLike({ ExpiredObjectDeleteMarker: true, Status: 'Enabled' }),
          Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }, Status: 'Enabled' }),
        ]),
      },
    });
  });

  test('CORS allows GET/HEAD from the Fleet UI origins', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [Match.objectLike({
          AllowedMethods: ['GET', 'HEAD'],
          AllowedOrigins: Match.arrayWith([
            deployEnv === 'prod' ? 'https://app.nakomis.com' : 'https://app.sandbox.nakomis.com',
          ]),
        })],
      },
    });
  });

  test('manifest Lambda runs on Node 22 and retains 10 versions', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `nakomis-firmware-manifest-${deployEnv}`,
      Runtime: 'nodejs22.x',
      Environment: { Variables: { RETAIN_VERSIONS: '10' } },
      ReservedConcurrentExecutions: 1,
    });
  });

  test('bucket notifies the Lambda for firmware.bin uploads', () => {
    template.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [Match.objectLike({
          Events: ['s3:ObjectCreated:*'],
          Filter: { Key: { FilterRules: [{ Name: 'suffix', Value: 'firmware.bin' }] } },
        })],
      },
    });
  });

  test('exports bucket name and ARN via SSM', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/nakomis-infra/${deployEnv}/firmware/bucket-name`,
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/nakomis-infra/${deployEnv}/firmware/bucket-arn`,
    });
  });
});

test('only the sandbox bucket lets the prod Fleet role read builds for promotion', () => {
  const policy = (env: 'sandbox' | 'prod') => JSON.stringify(makeTemplate(env).findResources('AWS::S3::BucketPolicy'));
  expect(policy('sandbox')).toContain('arn:aws:iam::637423226886:role/nakomis-fleet-api-prod');
  expect(policy('prod')).not.toContain('nakomis-fleet-api-prod');
});
