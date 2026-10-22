FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/dw-cli/package.json packages/dw-cli/package.json
RUN npm ci --omit=dev

COPY bin ./bin
COPY packages ./packages
COPY catalog ./catalog
COPY docs ./docs
COPY skills ./skills
COPY scripts ./scripts
COPY README.md AGENTS.md SECURITY.md LICENSE ./

# 入口脚本把 rc / dw / 脚本路径映射到 node 运行方式
RUN chmod +x /app/bin/docker-entrypoint.sh
ENTRYPOINT ["/app/bin/docker-entrypoint.sh"]
CMD ["packages/cli/src/index.ts"]
