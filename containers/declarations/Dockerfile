FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git sqlite3 python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY apps/etl/package.json ./apps/etl/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/web/wrangler.jsonc ./apps/web/wrangler.jsonc
COPY scripts ./scripts
COPY containers/declarations/server.mjs ./containers/declarations/server.mjs
COPY .gitignore ./
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts --filter @sigma/ingest... --filter sigma && git init -q
ENV PATH="/app/node_modules/.bin:$PATH"
EXPOSE 8080
CMD ["node", "containers/declarations/server.mjs"]
