FROM node:22.16.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY src/transport/gcp-runner-autoscaler.ts src/transport/gcp-runner-launcher.ts src/transport/gce-runner-agent.ts ./src/transport/
COPY config/gcp-runner-autoscaler.json ./config/

USER node

CMD ["node", "--experimental-strip-types", "src/transport/gcp-runner-autoscaler.ts"]
