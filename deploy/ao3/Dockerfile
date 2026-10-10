FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node deploy/ao3/package.json package.json
COPY --chown=node:node scripts/ao3-companion.mjs scripts/ao3-companion.mjs
COPY --chown=node:node packages/integrations/companion/ packages/integrations/companion/
USER node
CMD ["node", "scripts/ao3-companion.mjs"]
