#!/usr/bin/env python3
import os

import aws_cdk as cdk

from app.config import REGION, STACK_NAME
from app.stack import LambdaMicrovmStack

app = cdk.App()
LambdaMicrovmStack(
    app,
    STACK_NAME,
    env=cdk.Environment(
        account=os.getenv("CDK_DEFAULT_ACCOUNT"),
        region=REGION,
    ),
)

app.synth()
