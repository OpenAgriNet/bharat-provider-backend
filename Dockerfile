FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --legacy-peer-deps --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --legacy-peer-deps --no-audit --no-fund

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/views ./src/views
COPY --from=builder /app/course.json ./course.json

EXPOSE 3000

CMD ["node", "dist/src/main.js"]