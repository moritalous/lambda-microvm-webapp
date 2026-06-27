FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN curl -fL https://github.com/coder/code-server/releases/download/v4.126.0/code-server-4.126.0-arm64.rpm \
        -o /tmp/code-server.rpm && \
    rpm -U /tmp/code-server.rpm && \
    rm /tmp/code-server.rpm

RUN dnf install -y \
      shadow-utils \
      tar zip unzip gzip bzip2 xz \
      git \
      wget \
      findutils which file \
      procps-ng \
      less \
      jq \
      tree \
      diffutils \
      libatomic \
    && dnf clean all

RUN groupadd --gid 1000 vscode \
  && useradd -o -u 0 -g 1000 -m -d /home/vscode -s /bin/bash vscode \
  && { grep '^vscode:' /etc/passwd; grep -v '^vscode:' /etc/passwd; } > /etc/passwd.tmp \
  && cat /etc/passwd.tmp > /etc/passwd \
  && rm -f /etc/passwd.tmp

ENV HOME=/home/vscode
ENV USER_DATA_DIR=${HOME}/.vscode
ENV EXTENSIONS_DIR=${HOME}/.local/share/code-server/extensions

RUN mkdir -p ${HOME}/workspace ${EXTENSIONS_DIR} ${USER_DATA_DIR}/User

COPY settings.json ${USER_DATA_DIR}/User/settings.json

COPY extensions.txt /tmp/extensions.txt
RUN while IFS= read -r ext || [ -n "$ext" ]; do \
      case "$ext" in ''|\#*) continue ;; esac; \
      code-server --install-extension "$ext" --extensions-dir "${EXTENSIONS_DIR}" || true; \
    done < /tmp/extensions.txt

RUN echo '{"locale":"ja"}' > ${USER_DATA_DIR}/User/argv.json

RUN chown -R vscode:vscode ${HOME}

EXPOSE 8080

USER vscode

CMD ["code-server", "--bind-addr", "0.0.0.0:8080", "--auth", "password", \
     "--disable-telemetry", \
     "--user-data-dir", "/home/vscode/.vscode", \
     "--extensions-dir", "/home/vscode/.local/share/code-server/extensions", \
     "/home/vscode/workspace"]
