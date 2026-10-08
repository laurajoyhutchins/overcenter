FROM ubuntu:24.04

ARG GO_VERSION=1.24.13
ARG GO_SHA256=1fc94b57134d51669c72173ad5d49fd62afb0f1db9bf3f798fd98ee423f8d730
ARG RUNNER_VERSION=2.337.0
ARG RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613
ARG RUSTUP_VERSION=1.28.2
ARG RUSTUP_SHA256=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c

ENV DEBIAN_FRONTEND=noninteractive
ENV RUNNER_ALLOW_RUNASROOT=1
ENV CARGO_HOME=/opt/cargo
ENV RUSTUP_HOME=/opt/rustup
ENV PATH=/usr/local/go/bin:/opt/cargo/bin:$PATH

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

RUN curl --fail --silent --show-error --location \\
      --output /tmp/go.tar.gz \\
      "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \\
    && echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum --check --strict \\
    && tar -C /usr/local -xzf /tmp/go.tar.gz \\
    && rm /tmp/go.tar.gz \\
    && test "$(go env GOVERSION)" = "go${GO_VERSION}" \\
    && command -v go >/dev/null \\
    && command -v gofmt >/dev/null

RUN curl --fail --silent --show-error --location \
      --output /tmp/rustup-init \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
    && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum --check --strict \
    && chmod 0755 /tmp/rustup-init \
    && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none \
    && rm /tmp/rustup-init \
    && rustup --version

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
