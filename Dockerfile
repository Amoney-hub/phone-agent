# Web service image for the phone-agent dashboard / webhook / trigger server.
# NOTE: this runs the HTTP server (src/webhook.js), NOT the stdio MCP server
# (src/index.js) — the MCP entrypoint is for local Claude Desktop over stdio and
# would exit immediately in a hosted environment.

FROM node:20-bookworm-slim

# Build tools for compiling the native better-sqlite3 addon when no prebuilt
# binary is available for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the application source.
COPY . .

# Railway/most PaaS inject PORT and route to it; the server prefers PORT.
EXPOSE 3117

# Start the HTTP server (dashboard + /api + /vapi/webhook + /api/trigger/call).
CMD ["node", "src/webhook.js"]
