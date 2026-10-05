FROM ubuntu:24.04

ARG RUNNER_VERSION=2.337.0
ARG RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613

ENV DEBIAN_FRONTEND=noninteractive
ENV RUNNER_ALLOW_RUNASROOT=1

RUN apt-get update -qq \
    && apt-get install -y -qq \
      ca-certificates \
      curl \
      git \
      gzip \
      jq \
      python3 \
      sudo \
      tar \
      unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /actions-runner

RUN curl -fsSLo actions-runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    && echo "${RUNNER_SHA256}  actions-runner.tar.gz" | sha256sum -c - \
    && tar xzf actions-runner.tar.gz \
    && rm actions-runner.tar.gz \
    && ./bin/installdependencies.sh >/dev/null

COPY entrypoint.sh /usr/local/bin/overcenter-gcp-runner
RUN chmod +x /usr/local/bin/overcenter-gcp-runner

ENTRYPOINT ["/usr/local/bin/overcenter-gcp-runner"]
