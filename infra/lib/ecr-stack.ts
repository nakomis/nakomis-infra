import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface EcrStackProps extends cdk.StackProps {
  deployEnv: 'sandbox' | 'prod';
}

// Shared container-image registry for the account's Lambda functions.
//
// Container Lambdas (e.g. recipator's mxbai embed function — torch + a 1.3GB model,
// far over the 250MB ZIP limit) need their image in ECR. Rather than each project
// leaning on the CDK bootstrap container-assets repo, projects build + push to this
// one explicit repo and reference it with `lambda.DockerImageCode.fromEcr(...)`.
//
// Tagging convention: `<project>-<function>-<contenthash>`, e.g. `recipator-embed-ab12cd34ef56`.
// The content hash makes pushes idempotent (same inputs -> same tag -> skip) and lets
// the lifecycle policy prune per-project by tag prefix.
export class EcrStack extends cdk.Stack {
  readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);

    const { deployEnv } = props;
    const isProd = deployEnv === 'prod';

    this.repository = new ecr.Repository(this, 'LambdaImagesRepo', {
      repositoryName: 'nakomis-lambda-images',
      imageScanOnPush: true,
      // Sandbox is disposable: let `cdk destroy` clear it out. Prod is retained.
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: !isProd,
      lifecycleRules: [
        // Untagged layers are orphaned by re-pushes — bin them quickly.
        {
          rulePriority: 1,
          description: 'Expire untagged images after 1 day',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(1),
        },
        // Keep only the current image per project — old ones are rebuildable from git
        // (content-hashed tag), and nothing here is production. Add a rule per prefix.
        {
          rulePriority: 10,
          description: 'Keep only the latest recipator-embed image',
          tagStatus: ecr.TagStatus.TAGGED,
          tagPrefixList: ['recipator-embed'],
          maxImageCount: 1,
        },
      ],
    });

    // Container-image Lambdas are pulled by the Lambda service, not the function role,
    // so the repo itself must allow the Lambda service principal to pull. CDK's
    // `fromEcr` tries to add this grant, but it's a no-op on a repo imported read-only
    // into another stack/project — so we grant it here, where the repo is concrete.
    // Scoped to this account so only our own functions can pull.
    this.repository.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowLambdaPull',
      principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      actions: [
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchCheckLayerAvailability',
      ],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
      },
    }));

    // Projects publish their images here from CI. As the owner of this shared repo,
    // nakomis-infra controls who may write to it (rather than each project granting
    // itself push) — the consumer's CI role only needs ecr:GetAuthorizationToken, which
    // is account-global and can't be granted by a repository policy.
    //
    // Principal is the account root + a condition on the role ARN pattern, not the role
    // ARN itself: a named principal must exist when the policy is set, but recipator's
    // CI role is created *after* this repo. Recipator is the only publisher today — add
    // a pattern per project as others need to push, rather than admitting all up front.
    this.repository.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCiPublish',
      principals: [new iam.AccountRootPrincipal()],
      actions: [
        'ecr:DescribeImages',
        'ecr:BatchCheckLayerAvailability',
        'ecr:InitiateLayerUpload',
        'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload',
        'ecr:PutImage',
      ],
      conditions: {
        StringLike: {
          'aws:PrincipalArn': `arn:aws:iam::${this.account}:role/nakomis-recipator-github-ci-*`,
        },
      },
    }));

    new ssm.StringParameter(this, 'LambdaImagesRepoParam', {
      parameterName: `/nakomis-infra/${deployEnv}/ecr/lambda-images-repo`,
      stringValue: this.repository.repositoryName,
      description: `Shared Lambda container-image ECR repository name (${deployEnv})`,
    });
  }
}
