FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y python3 python3-pip && dnf clean all
RUN pip3 install uv

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --python 3.13

COPY main.py .

EXPOSE 8501

CMD ["uv", "run", "streamlit", "run", "main.py", \
     "--server.headless=true", \
     "--server.port=8501", \
     "--server.address=0.0.0.0"]
