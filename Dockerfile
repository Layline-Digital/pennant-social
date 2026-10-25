# ==============================================================================
# PENNANT HOIST - SOVEREIGN BROADCAST DECK
# Multi-Stage Alpine Container (Production SKU)
# ==============================================================================
FROM node:24-alpine AS builder

WORKDIR /build
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# ==============================================================================
# RUNTIME CONTAINER
# ==============================================================================
FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7420
ENV HOST=0.0.0.0

# Install dumb-init for proper process reaping & signal handling in containers
RUN apk add --no-cache dumb-init

# Create unprivileged pennant user & persistence directory
RUN addgroup -g 1001 pennant && \
    adduser -u 1001 -G pennant -s /bin/sh -D pennant && \
    mkdir -p /home/pennant/.pennant && \
    chown -R pennant:pennant /home/pennant /app

COPY --from=builder --chown=pennant:pennant /build /app

USER pennant
EXPOSE 7420

VOLUME ["/home/pennant/.pennant"]

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "pennant-launcher.js", "--daemon", "--no-browser", "--host=0.0.0.0"]
