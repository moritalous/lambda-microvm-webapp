REGION = "us-east-1"
STACK_NAME = "LambdaMicrovmStreamlitStack"
IMAGE_NAME = "streamlit-microvm"
TABLE_NAME = "microvm-streamlit-sessions"
MINIMUM_MEMORY_IN_MIB = 2048
BASE_IMAGE_ARN = f"arn:aws:lambda:{REGION}:aws:microvm-image:al2023-1"
IMAGE_DESCRIPTION = "Streamlit on Lambda MicroVM"
ARTIFACT_DIR = "artifact/base-image"
APP_PORT = 8501

EDGE = {
    "token_duration_min": 60,
    "token_refresh_threshold": 15,
    "max_duration_sec": 28800,
    "idle_sec": 300,
    "suspended_sec": 28800,
}


def ingress_connector_arn(region: str) -> str:
    return f"arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:ALL_INGRESS"


def egress_connector_arn(region: str) -> str:
    return f"arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS"
