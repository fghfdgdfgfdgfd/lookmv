FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STORAGE_DIR=/app/storage

WORKDIR /app

# The project has no npm dependencies; ship only the app and its movie catalog.
COPY server.js ./server.js
COPY config.json ./config.json
COPY public ./public
COPY data/movies.json ./data/movies.json

# Railway can mount a persistent volume here without hiding the read-only catalog.
RUN mkdir -p /app/storage \
    && chown -R node:node /app
VOLUME ["/app/storage"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
