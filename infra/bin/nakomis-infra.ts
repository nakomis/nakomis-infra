#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import { AuthCertStack } from '../lib/auth-cert-stack';
import { AuthStack } from '../lib/auth-stack';
import { DeploymentTrackerStack } from '../lib/deployment-tracker-stack';
import { GithubCiStack } from '../lib/github-ci-stack';

const app = new cdk.App();

const deployEnv = (process.env.NPM_ENVIRONMENT ?? 'sandbox') as 'sandbox' | 'prod';

const accounts = {
  sandbox: { account: '975050268859', region: 'eu-west-2' },
  prod:    { account: '637423226886', region: 'eu-west-2' },
};

const oidcProviderArns = {
  sandbox: `arn:aws:iam::${accounts.sandbox.account}:oidc-provider/token.actions.githubusercontent.com`,
  prod:    `arn:aws:iam::${accounts.prod.account}:oidc-provider/token.actions.githubusercontent.com`,
};

const authCertStack = new AuthCertStack(app, 'AuthCertStack', {
  env: { account: accounts[deployEnv].account, region: 'us-east-1' },
  deployEnv,
  crossRegionReferences: true,
});

new AuthStack(app, 'AuthStack', {
  env: accounts[deployEnv],
  deployEnv,
  certificate: authCertStack.certificate,
  crossRegionReferences: true,
});

new DeploymentTrackerStack(app, 'DeploymentTrackerStack', {
  env: accounts[deployEnv],
  deployEnv,
});

new GithubCiStack(app, 'GithubCiStack', {
  env: accounts[deployEnv],
  deployEnv,
  githubOidcProviderArn: oidcProviderArns[deployEnv],
});

const { version: infraVersion } = JSON.parse(fs.readFileSync('./version.json', 'utf-8'));
cdk.Tags.of(app).add('MH-Project', 'nakomis-infra');
cdk.Tags.of(app).add('MH-Version', infraVersion);
