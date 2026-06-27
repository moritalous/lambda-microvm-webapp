import aws_cdk as core
import aws_cdk.assertions as assertions

from app.stack import LambdaMicrovmStack


def test_stack_synthesizes():
    app = core.App()
    stack = LambdaMicrovmStack(
        app,
        "TestStack",
        env=core.Environment(account="123456789012", region="us-east-1"),
    )
    template = assertions.Template.from_stack(stack)
    template.resource_count_is("AWS::DynamoDB::Table", 1)
