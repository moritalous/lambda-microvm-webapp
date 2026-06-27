import json
import os
import subprocess
from typing import Any

import jsii
from aws_cdk import (
    AssetHashType,
    BundlingOptions,
    CfnOutput,
    CfnResource,
    DefaultStackSynthesizer,
    DockerImage,
    Duration,
    ILocalBundling,
    RemovalPolicy,
    Stack,
    Token,
)
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_ecr_assets as ecr_assets
from aws_cdk import aws_iam as iam
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_s3_assets as s3_assets
from constructs import Construct

from app import config


@jsii.implements(ILocalBundling)
class _CodeArtifactBundler:
    def __init__(self, base_image_uri: str) -> None:
        self._base_image_uri = base_image_uri

    def try_bundle(self, output_dir: str, *, options: Any = None) -> bool:
        try:
            with open(os.path.join(output_dir, "Dockerfile"), "w") as f:
                f.write(f"FROM {self._base_image_uri}\n")
            return True
        except Exception:
            return False


@jsii.implements(ILocalBundling)
class _EdgeLocalBundler:
    def __init__(self, source_dir: str) -> None:
        self._source_dir = source_dir

    def try_bundle(self, output_dir: str, *, options: Any = None) -> bool:
        try:
            subprocess.run(
                f'cp -r "{self._source_dir}/." "{output_dir}" && cd "{output_dir}" && npm ci --omit=dev',
                shell=True,
                check=True,
            )
            return True
        except Exception:
            return False


class LambdaMicrovmStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs: Any) -> None:
        super().__init__(scope, construct_id, **kwargs)

        region = config.REGION
        account = self.account

        if Token.is_unresolved(account):
            raise ValueError("Account ID is unresolved. Specify env with account and region.")

        image_arn = f"arn:aws:lambda:{region}:{account}:microvm-image:{config.IMAGE_NAME}"

        table = dynamodb.Table(
            self,
            "SessionsTable",
            table_name=config.TABLE_NAME,
            partition_key=dynamodb.Attribute(
                name="sessionId",
                type=dynamodb.AttributeType.STRING,
            ),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            time_to_live_attribute="ttl",
            removal_policy=RemovalPolicy.DESTROY,
        )

        base_image = ecr_assets.DockerImageAsset(
            self,
            "AppImage",
            directory=os.path.join(os.path.dirname(__file__), "..", config.ARTIFACT_DIR),
            platform=ecr_assets.Platform.LINUX_ARM64,
        )

        qualifier = DefaultStackSynthesizer.DEFAULT_QUALIFIER
        base_image_uri = (
            f"{account}.dkr.ecr.{region}.amazonaws.com/"
            f"cdk-{qualifier}-container-assets-{account}-{region}:{base_image.image_tag}"
        )

        code_artifact = s3_assets.Asset(
            self,
            "CodeArtifact",
            path=os.path.join(os.path.dirname(__file__), "..", config.ARTIFACT_DIR),
            asset_hash_type=AssetHashType.CUSTOM,
            asset_hash=base_image.image_tag,
            bundling=BundlingOptions(
                image=DockerImage.from_registry("public.ecr.aws/docker/library/alpine:latest"),
                command=["sh", "-c", 'echo "local bundling required" && exit 1'],
                local=_CodeArtifactBundler(base_image_uri),
            ),
        )

        build_role = iam.Role(
            self,
            "MicrovmBuildRole",
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
            description="Role assumed by Lambda during MicroVM image build",
        )
        cfn_build_role = build_role.node.default_child  # type: ignore
        cfn_build_role.assume_role_policy_document = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {"Service": "lambda.amazonaws.com"},
                    "Action": ["sts:AssumeRole", "sts:TagSession"],
                },
            ],
        }

        code_artifact.grant_read(build_role)
        base_image.repository.grant_pull(build_role)
        build_role.add_to_policy(
            iam.PolicyStatement(
                actions=["ecr:GetAuthorizationToken"],
                resources=["*"],
            ),
        )
        build_role.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                ],
                resources=["*"],
            ),
        )

        microvm_image = CfnResource(
            self,
            "MicrovmImage",
            type="AWS::Lambda::MicrovmImage",
            properties={
                "Name": config.IMAGE_NAME,
                "Description": config.IMAGE_DESCRIPTION,
                "BaseImageArn": config.BASE_IMAGE_ARN,
                "BaseImageVersion": "0",
                "BuildRoleArn": build_role.role_arn,
                "CodeArtifact": {"Uri": code_artifact.s3_object_url},
                "CpuConfigurations": [{"Architecture": "ARM_64"}],
                "AdditionalOsCapabilities": ["ALL"],
                "EgressNetworkConnectors": [config.egress_connector_arn(region)],
                "EnvironmentVariables": [],
                "Hooks": {},
                "Resources": [{"MinimumMemoryInMiB": config.MINIMUM_MEMORY_IN_MIB}],
                "Logging": {"Disabled": False},
            },
        )

        execution_role_name = f"{config.IMAGE_NAME}-execution-role"
        execution_role_arn = f"arn:aws:iam::{account}:role/{execution_role_name}"
        microvm_execution_role = iam.Role(
            self,
            "MicrovmExecutionRole",
            role_name=execution_role_name,
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
            description="IAM role for MicroVM runtime - grants access to Bedrock and CloudWatch",
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name("AmazonBedrockMantleInferenceAccess"),
            ],
        )
        microvm_execution_role.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                ],
                resources=["*"],
            ),
        )

        edge_role = iam.Role(
            self,
            "EdgeRole",
            assumed_by=iam.CompositePrincipal(
                iam.ServicePrincipal("lambda.amazonaws.com"),
                iam.ServicePrincipal("edgelambda.amazonaws.com"),
            ),
        )
        edge_role.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "lambda:RunMicrovm",
                    "lambda:CreateMicrovmAuthToken",
                    "lambda:PassNetworkConnector",
                ],
                resources=["*"],
            ),
        )
        edge_role.add_to_policy(
            iam.PolicyStatement(
                actions=["iam:PassRole"],
                resources=[execution_role_arn],
            ),
        )
        table.grant(edge_role, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem")
        edge_role.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                ],
                resources=["*"],
            ),
        )

        edge_asset_dir = os.path.join(os.path.dirname(__file__), "..", "artifact", "edge")
        self._write_edge_config(
            edge_asset_dir,
            {
                "MVM_REGION": region,
                "TABLE": config.TABLE_NAME,
                "IMAGE_ARN": image_arn,
                "INGRESS": config.ingress_connector_arn(region),
                "EGRESS": config.egress_connector_arn(region),
                "EXECUTION_ROLE_ARN": execution_role_arn,
                "APP_PORT": config.APP_PORT,
                "TOKEN_DURATION_MIN": config.EDGE["token_duration_min"],
                "TOKEN_REFRESH_THRESHOLD": config.EDGE["token_refresh_threshold"],
                "MAX_DURATION_SEC": config.EDGE["max_duration_sec"],
                "IDLE_SEC": config.EDGE["idle_sec"],
                "SUSPENDED_SEC": config.EDGE["suspended_sec"],
            },
        )

        edge_fn = cloudfront.experimental.EdgeFunction(
            self,
            "EdgeFunction",
            runtime=lambda_.Runtime.NODEJS_20_X,
            handler="index.handler",
            code=lambda_.Code.from_asset(
                edge_asset_dir,
                bundling=BundlingOptions(
                    image=lambda_.Runtime.NODEJS_20_X.bundling_image,
                    command=[
                        "bash",
                        "-c",
                        "cp -r /asset-input/. /asset-output && cd /asset-output && npm ci --omit=dev",
                    ],
                    local=_EdgeLocalBundler(edge_asset_dir),
                ),
            ),
            role=edge_role,
            timeout=Duration.seconds(30),
            memory_size=256,
        )

        edge_response_role = iam.Role(
            self,
            "EdgeResponseRole",
            assumed_by=iam.CompositePrincipal(
                iam.ServicePrincipal("lambda.amazonaws.com"),
                iam.ServicePrincipal("edgelambda.amazonaws.com"),
            ),
        )
        edge_response_role.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                ],
                resources=["*"],
            ),
        )

        edge_response_fn = cloudfront.experimental.EdgeFunction(
            self,
            "EdgeResponseFunction",
            runtime=lambda_.Runtime.NODEJS_20_X,
            handler="index.handler",
            code=lambda_.Code.from_asset(
                os.path.join(os.path.dirname(__file__), "..", "artifact", "edge-response"),
            ),
            role=edge_response_role,
            timeout=Duration.seconds(5),
            memory_size=128,
        )

        distribution = cloudfront.Distribution(
            self,
            "Distribution",
            comment=config.IMAGE_DESCRIPTION,
            http_version=cloudfront.HttpVersion.HTTP2_AND_3,
            price_class=cloudfront.PriceClass.PRICE_CLASS_ALL,
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.HttpOrigin(
                    "example.com",
                    protocol_policy=cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
                    origin_ssl_protocols=[cloudfront.OriginSslPolicy.TLS_V1_2],
                    read_timeout=Duration.seconds(60),
                    keepalive_timeout=Duration.seconds(60),
                ),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowed_methods=cloudfront.AllowedMethods.ALLOW_ALL,
                cache_policy=cloudfront.CachePolicy.CACHING_DISABLED,
                origin_request_policy=cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                edge_lambdas=[
                    cloudfront.EdgeLambda(
                        function_version=edge_fn.current_version,
                        event_type=cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
                        include_body=False,
                    ),
                    cloudfront.EdgeLambda(
                        function_version=edge_response_fn.current_version,
                        event_type=cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
                        include_body=False,
                    ),
                ],
            ),
        )
        distribution.node.add_dependency(microvm_image)

        CfnOutput(
            self,
            "DistributionUrl",
            value=f"https://{distribution.distribution_domain_name}",
            description="URL to open in the browser",
        )
        CfnOutput(
            self,
            "MicrovmImageArn",
            value=image_arn,
            description="MicroVM image ARN",
        )
        CfnOutput(
            self,
            "SessionsTableName",
            value=table.table_name,
            description="DynamoDB session table name",
        )

    def _write_edge_config(self, directory: str, cfg: dict) -> None:
        with open(os.path.join(directory, "config.json"), "w") as f:
            f.write(json.dumps(cfg, indent=2) + "\n")
