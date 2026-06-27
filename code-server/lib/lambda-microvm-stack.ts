import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { config, egressConnectorArn, ingressConnectorArn } from './config';

export class LambdaMicrovmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const region = config.region;
    const account = this.account;

    if (cdk.Token.isUnresolved(account)) {
      throw new Error('Account ID is unresolved. Specify env: { account, region }.');
    }

    const imageArn = `arn:aws:lambda:${region}:${account}:microvm-image:${config.imageName}`;

    const appPassword = new secretsmanager.Secret(this, 'AppPassword', {
      description: `Password for ${config.imageDescription}`,
      generateSecretString: {
        passwordLength: 8,
        excludePunctuation: true,
      },
    });

    const table = new dynamodb.Table(this, 'SessionsTable', {
      tableName: config.tableName,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const baseImage = new ecr_assets.DockerImageAsset(this, 'AppImage', {
      directory: path.join(__dirname, '..', config.artifactDir),
      platform: ecr_assets.Platform.LINUX_ARM64,
    });

    const qualifier = cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER;
    const baseImageUri = [
      `${account}.dkr.ecr.${region}.amazonaws.com`,
      `cdk-${qualifier}-container-assets-${account}-${region}:${baseImage.imageTag}`,
    ].join('/');

    const codeArtifact = new s3assets.Asset(this, 'CodeArtifact', {
      path: path.join(__dirname, '..', config.artifactDir),
      assetHashType: cdk.AssetHashType.CUSTOM,
      assetHash: baseImage.imageTag,
      bundling: {
        local: {
          tryBundle(outputDir: string): boolean {
            fs.writeFileSync(path.join(outputDir, 'Dockerfile'), `FROM ${baseImageUri}\n`);
            return true;
          },
        },
        image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/alpine:latest'),
        command: ['sh', '-c', 'echo "local bundling required" && exit 1'],
      },
    });

    const buildRole = new iam.Role(this, 'MicrovmBuildRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role assumed by Lambda during MicroVM image build',
    });

    const cfnBuildRole = buildRole.node.defaultChild as iam.CfnRole;
    cfnBuildRole.assumeRolePolicyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: ['sts:AssumeRole', 'sts:TagSession'],
        },
      ],
    };

    codeArtifact.grantRead(buildRole);
    baseImage.repository.grantPull(buildRole);
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }),
    );

    const microvmImage = new cdk.CfnResource(this, 'MicrovmImage', {
      type: 'AWS::Lambda::MicrovmImage',
      properties: {
        Name: config.imageName,
        Description: config.imageDescription,
        BaseImageArn: config.baseImageArn,
        BaseImageVersion: '0',
        BuildRoleArn: buildRole.roleArn,
        CodeArtifact: { Uri: codeArtifact.s3ObjectUrl },
        CpuConfigurations: [{ Architecture: 'ARM_64' }],
        AdditionalOsCapabilities: ['ALL'],
        EgressNetworkConnectors: [egressConnectorArn(region)],
        EnvironmentVariables: [{ Key: 'PASSWORD', Value: appPassword.secretValue.unsafeUnwrap() }],
        Hooks: {},
        Resources: [{ MinimumMemoryInMiB: config.minimumMemoryInMiB }],
        Logging: { Disabled: true },
      },
    });

    const edgeRole = new iam.Role(this, 'EdgeRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('edgelambda.amazonaws.com'),
      ),
    });
    edgeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:RunMicrovm', 'lambda:CreateMicrovmAuthToken', 'lambda:PassNetworkConnector'],
        resources: ['*'],
      }),
    );
    table.grant(edgeRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
    edgeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }),
    );

    const edgeAssetDir = path.join(__dirname, '..', 'artifact', 'edge');
    this.writeEdgeConfig(edgeAssetDir, {
      MVM_REGION: region,
      TABLE: config.tableName,
      IMAGE_ARN: imageArn,
      INGRESS: ingressConnectorArn(region),
      EGRESS: egressConnectorArn(region),
      TOKEN_DURATION_MIN: config.edge.tokenDurationMin,
      TOKEN_REFRESH_THRESHOLD: config.edge.tokenRefreshThreshold,
      MAX_DURATION_SEC: config.edge.maxDurationSec,
      IDLE_SEC: config.edge.idleSec,
      SUSPENDED_SEC: config.edge.suspendedSec,
    });

    const edgeFn = new cloudfront.experimental.EdgeFunction(this, 'EdgeFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(edgeAssetDir, {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: ['bash', '-c', 'cp -r /asset-input/. /asset-output && cd /asset-output && npm ci --omit=dev'],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                execSync(`cp -r "${edgeAssetDir}/." "${outputDir}" && cd "${outputDir}" && npm ci --omit=dev`, {
                  stdio: 'inherit',
                });
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      role: edgeRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    const edgeResponseRole = new iam.Role(this, 'EdgeResponseRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('edgelambda.amazonaws.com'),
      ),
    });
    edgeResponseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }),
    );

    const edgeResponseFn = new cloudfront.experimental.EdgeFunction(this, 'EdgeResponseFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'artifact', 'edge-response')),
      role: edgeResponseRole,
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: config.imageDescription,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      defaultBehavior: {
        origin: new origins.HttpOrigin('example.com', {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
          readTimeout: cdk.Duration.seconds(60),
          keepaliveTimeout: cdk.Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        edgeLambdas: [
          {
            functionVersion: edgeFn.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
            includeBody: false,
          },
          {
            functionVersion: edgeResponseFn.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
            includeBody: false,
          },
        ],
      },
    });
    distribution.node.addDependency(microvmImage);

    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'URL to open in the browser',
    });
    new cdk.CfnOutput(this, 'MicrovmImageArn', {
      value: imageArn,
      description: 'MicroVM image ARN',
    });
    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: table.tableName,
      description: 'DynamoDB session table name',
    });
    new cdk.CfnOutput(this, 'AppPasswordSecretArn', {
      value: appPassword.secretArn,
      description: 'Secrets Manager ARN of the application password',
    });
  }

  private writeEdgeConfig(dir: string, cfg: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  }
}
