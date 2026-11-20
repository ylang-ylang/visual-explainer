# syntax=docker/dockerfile:1.7-labs
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
WORKDIR /opt/bridge
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    npx --yes playwright-core@1.63.0 install --with-deps chromium-headless-shell && \
    chmod -R a+rX /opt/browsers
COPY remote-app/package.json remote-app/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
# Use the renderer and skills from this fork checkout, not a separately downloaded upstream archive.
COPY package.json LICENSE /opt/upstream/
COPY plugins/ /opt/upstream/plugins/
# Share only MCP/render dependencies; do not install unused PPTX export dependencies.
RUN ln -s /opt/bridge/node_modules /opt/upstream/node_modules
COPY remote-app/server.mjs remote-app/index.html ./
COPY remote-app/static/ ./static/
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/ylang-ylang/visual-explainer" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.title="Visual Explainer Remote"
USER 1000:1000
EXPOSE 8080
CMD ["node", "server.mjs"]
