# =============================================================================
# EVO-CAMPAIGN BACKEND - Optimized Multi-stage Dockerfile
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies and Build
# -----------------------------------------------------------------------------
FROM node:20-slim AS builder

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first (better cache layer)
COPY package*.json ./

# Install ALL dependencies for build (cached if package.json unchanged)
RUN npm ci --ignore-scripts && \
    npm cache clean --force

# Copy config files
COPY tsconfig*.json ./
COPY nest-cli.json ./

# Copy source code
COPY src/ ./src/

# Build the application and create production node_modules
RUN npm run build && \
    npm ci --only=production --ignore-scripts && \
    cp -R node_modules prod_node_modules

# -----------------------------------------------------------------------------
# Stage 2: Production Runtime
# -----------------------------------------------------------------------------
FROM node:20-slim AS production

# Set working directory
WORKDIR /app

# Install system dependencies for production
RUN apt-get update && apt-get install -y \
    dumb-init \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs nestjs

# Copy package files and production dependencies
COPY --from=builder --chown=nestjs:nodejs /app/package*.json ./
COPY --from=builder --chown=nestjs:nodejs /app/prod_node_modules ./node_modules

# Copy built application from builder stage
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist

# Copy only essential config files for migrations
COPY --from=builder --chown=nestjs:nodejs /app/tsconfig.json ./
COPY --from=builder --chown=nestjs:nodejs /app/nest-cli.json ./

# Copy only migration files (not entire src/)
COPY --from=builder --chown=nestjs:nodejs /app/src/database ./src/database

# Create necessary directories
RUN mkdir -p /app/logs && \
    chown -R nestjs:nodejs /app

# Switch to non-root user
USER nestjs

# Expose port (conditional based on RUN_MODE)
EXPOSE 3005

# Liveness health check for every mode that serves HTTP (EVO-1226). /health is a
# bare, un-prefixed liveness route that returns 200 whenever the process is alive
# (dependency readiness is the separate /ready probe used by k8s/Cloud Run). Modes
# without an HTTP server (legacy workers) report healthy unconditionally.
# Port default aligned with main.ts (process.env.PORT ?? 3000).
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD case "$RUN_MODE" in \
          single|api|event-receiver|campaign-packer|campaign-sender|campaign-tracker|event-process) \
            curl -f http://localhost:${PORT:-3000}/health ;; \
          *) exit 0 ;; \
        esac

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/main.js"]
