#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack';
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

new AuthStack(app, 'AuthStack', {
  env: accounts[deployEnv],
  deployEnv,
});

new GithubCiStack(app, 'GithubCiStack', {
  env: accounts[deployEnv],
  deployEnv,
  githubOidcProviderArn: oidcProviderArns[deployEnv],
});
