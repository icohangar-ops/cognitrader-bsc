# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files (include the lockfile so `npm ci` can enforce it)
COPY package.json package-lock.json tsconfig.json ./

# Install dependencies from the lockfile (reproducible, no drift)
RUN npm ci

# Copy source
COPY src/ ./src/

# Build TypeScript
RUN npx tsc

# ─── Production stage ────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create log directory
RUN mkdir -p /app/logs

# Set environment
ENV NODE_ENV=production
ENV AGENT_LOG_LEVEL=info

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD node -e "const fs = require('fs'); const log = fs.readFileSync('/app/logs/cognitrader.log', 'utf8'); const recent = log.slice(-500); process.exit(recent.includes('CYCLE') ? 0 : 1)"

# Run as non-root user
RUN addgroup -S agent && adduser -S agent -G agent
USER agent

# Entry point
EXPOSE 3000

CMD ["node", "dist/index.js"]
