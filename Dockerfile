# No dependencies, so no install step and no lockfile to copy.
FROM node:22-alpine

# The base image already ships an unprivileged `node` user.
USER node
WORKDIR /app

COPY --chown=node:node server.mjs ./server.mjs
COPY --chown=node:node package.json ./package.json

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    UPSTREAM=https://opencode.ai/zen/go/v1

EXPOSE 8787

# Hits the unauthenticated liveness route, so no API key is needed to stay healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
