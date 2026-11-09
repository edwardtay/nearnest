FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY agent ./agent
COPY demo ./demo
COPY public ./public
# The hosted agent (NEARNEST_AGENT=1) needs near-api-js; keys arrive by environment only.
COPY scripts/package.json scripts/package-lock.json ./scripts/
RUN cd scripts && npm ci --omit=dev --no-audit --no-fund
COPY scripts/*.mjs ./scripts/
ENV PORT=80
EXPOSE 80
CMD ["node", "server.mjs"]
