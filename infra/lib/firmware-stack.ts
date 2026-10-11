import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface FirmwareStackProps extends cdk.StackProps {
  deployEnv: 'sandbox' | 'prod';
}

// Browser origins that read manifests and presign downloads.
const UI_ORIGINS = {
  sandbox: ['https://app.sandbox.nakomis.com', 'https://sandbox.nakomis.com', 'http://localhost:3000', 'http://localhost:5173'],
  prod:    ['https://app.nakomis.com'],
};

const RETAIN_VERSIONS = 10;
const PROD_ACCOUNT = '637423226886';

/**
 * Per-env firmware artefact bucket for Fleet: s3://nakomis-firmware-{env}/{Project}/{semver}/firmware.bin
 * (ESP32) or …/artefact.tar.gz (Raspberry Pi releases for the Fleet agent).
 * An S3-triggered Lambda maintains {Project}/manifest.json and prunes old builds.
 */
export class FirmwareStack extends cdk.Stack {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FirmwareStackProps) {
    super(scope, id, props);

    const { deployEnv } = props;

    // Private: devices download via short-lived presigned URLs, so images (which may embed config) aren't public.
    // Retained in both envs because sandbox holds real device builds too.
    this.bucket = new s3.Bucket(this, 'FirmwareBucket', {
      bucketName: `nakomis-firmware-${deployEnv}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
        allowedOrigins: UI_ORIGINS[deployEnv],
        allowedHeaders: ['*'],
        maxAge: 3600,
      }],
      lifecycleRules: [
        { id: 'ExpireNoncurrentVersions', noncurrentVersionExpiration: cdk.Duration.days(30) },
        { id: 'RemoveExpiredDeleteMarkers', expiredObjectDeleteMarker: true },
        { id: 'AbortIncompleteUploads', abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
      ],
    });

    if (deployEnv === 'sandbox') {
      // Fleet's prod API promotes builds by copying them from here into nakomis-firmware-prod.
      const promoter = new iam.ArnPrincipal(`arn:aws:iam::${PROD_ACCOUNT}:role/nakomis-fleet-api-prod`);
      this.bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'FleetProdPromotionRead',
        principals: [promoter],
        actions: ['s3:GetObject', 's3:GetObjectTagging'],
        resources: [this.bucket.arnForObjects('*')],
      }));
      this.bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'FleetProdPromotionList',
        principals: [promoter],
        actions: ['s3:ListBucket'],
        resources: [this.bucket.bucketArn],
      }));
    }

    const logGroup = new logs.LogGroup(this, 'ManifestLogs', {
      logGroupName: `/aws/lambda/nakomis-firmware-manifest-${deployEnv}`,
      retention: logs.RetentionDays.SIX_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const manifestFn = new lambdaNode.NodejsFunction(this, 'ManifestFunction', {
      functionName: `nakomis-firmware-manifest-${deployEnv}`,
      entry: path.join(__dirname, '../lambda/firmware-manifest/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      // One writer at a time: concurrent uploads would otherwise race on manifest.json (last writer wins).
      reservedConcurrentExecutions: 1,
      logGroup,
      environment: { RETAIN_VERSIONS: String(RETAIN_VERSIONS) },
      bundling: { externalModules: ['@aws-sdk/client-s3'] },
    });

    this.bucket.grantReadWrite(manifestFn);
    for (const suffix of ['firmware.bin', 'artefact.tar.gz']) {
      this.bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(manifestFn), { suffix });
    }

    new ssm.StringParameter(this, 'BucketNameParam', {
      parameterName: `/nakomis-infra/${deployEnv}/firmware/bucket-name`,
      stringValue: this.bucket.bucketName,
      description: `Fleet firmware bucket name (${deployEnv})`,
    });

    new ssm.StringParameter(this, 'BucketArnParam', {
      parameterName: `/nakomis-infra/${deployEnv}/firmware/bucket-arn`,
      stringValue: this.bucket.bucketArn,
      description: `Fleet firmware bucket ARN (${deployEnv})`,
    });

    new cdk.CfnOutput(this, 'FirmwareBucketName', {
      value: this.bucket.bucketName,
      description: `Fleet firmware bucket (${deployEnv})`,
    });
  }
}
