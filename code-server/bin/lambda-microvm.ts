#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { config } from '../lib/config';
import { LambdaMicrovmStack } from '../lib/lambda-microvm-stack';

const app = new cdk.App();
new LambdaMicrovmStack(app, config.stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: config.region,
  },
});
