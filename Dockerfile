FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data WEB_DIST=/app/apps/web/dist APP_RUNTIME_DIST=/app/packages/app-runtime/dist AGENTS_CONFIG=/config/agents.config.yaml PORT=8080
COPY --from=build /app /app
VOLUME /data
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/dist/index.js"]
