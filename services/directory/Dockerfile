# NodeDesk directory service. No npm dependencies. The process listens on
# 127.0.0.1 inside the host network namespace (see docker-compose.yml).
# Do not publish 8081, and never publish Sunshine ports 47984, 47989, 47990, 48010.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    BIND=127.0.0.1 \
    PORT=8081 \
    DB_PATH=/var/lib/nodedesk/directory.db \
    GOOGLE_CLIENT_ID_FILE=/etc/nodedesk/google-client-id

# Root so a mode-600 root-owned client-id file under /etc/nodedesk can be read.
# The port is bound to loopback; it is not a public listener.
USER root

EXPOSE 8081
CMD ["node", "src/server.js"]
