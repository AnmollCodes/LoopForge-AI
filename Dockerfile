# Production image for The Watch (Dream Job Watcher).
# No build step needed — this is plain Node.js/Express, no framework compile.

FROM node:20-slim

# PDF parsing shells out to pdftotext (poppler-utils) — install it here so
# the CV file-upload feature works out of the box in the container, not
# just when poppler happens to already be on the host.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching — only re-installs when
# package.json actually changes, not on every source edit).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# Run as a non-root user — a basic container security practice, not
# optional for anything meant to run in production.
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app
USER appuser

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
