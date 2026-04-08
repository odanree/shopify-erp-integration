# ─── Stage 1: Install production dependencies ────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --prefer-offline 2>/dev/null || npm install --omit=dev --no-audit

# ─── Stage 2: Runtime image ───────────────────────────────────────────────
FROM node:18-alpine AS runtime

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY src/ ./src/
COPY lambda/ ./lambda/

RUN chown -R appuser:appgroup /app
USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "src/app.js"]

# ─── Optional: Lambda container image variant ────────────────────────────
# To build for Lambda, swap the base image and CMD:
#
# FROM public.ecr.aws/lambda/nodejs:18 AS lambda
# COPY --from=builder /app/node_modules ${LAMBDA_TASK_ROOT}/node_modules
# COPY src/ ${LAMBDA_TASK_ROOT}/src/
# COPY lambda/ ${LAMBDA_TASK_ROOT}/lambda/
# ENV NODE_ENV=production
# CMD ["lambda/handler.handler"]
