import streamlit as st
from aws_bedrock_token_generator import provide_token
from strands import Agent
from strands.models.anthropic import AnthropicModel

region = "us-east-1"


def create_agent():
    model = AnthropicModel(
        client_args={
            "base_url": f"https://bedrock-mantle.{region}.api.aws/anthropic",
            "api_key": provide_token(),
        },
        max_tokens=1024,
        model_id="anthropic.claude-haiku-4-5",
    )
    return Agent(model=model, callback_handler=None)


async def process_streaming(stream):
    async for event in stream:
        if "event" in event:
            text = event["event"].get("contentBlockDelta", {}).get("delta", {}).get("text", "")
            yield text


st.title("Strands Chat")

if "messages" not in st.session_state:
    st.session_state["messages"] = []

if "agent" not in st.session_state:
    st.session_state["agent"] = create_agent()

for message in st.session_state["messages"]:
    with st.chat_message(message["role"]):
        st.write(message["text"])


if prompt := st.chat_input():
    with st.chat_message("user"):
        st.write(prompt)
    st.session_state["messages"].append({"role": "user", "text": prompt})

    with st.chat_message("assistant"):
        answer = st.write_stream(process_streaming(st.session_state["agent"].stream_async(prompt)))
    st.session_state["messages"].append({"role": "assistant", "text": answer})
