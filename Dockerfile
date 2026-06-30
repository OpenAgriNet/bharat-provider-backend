FROM node:20.0.0

WORKDIR /app

# Install curl for weather API calls
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY package*.json .npmrc ./

# Use only valid npm config options
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 10 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]