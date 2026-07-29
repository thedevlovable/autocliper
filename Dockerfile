FROM node:20-slim

# System deps: ffmpeg + curl
RUN apt-get update && apt-get install -y ffmpeg curl --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm@latest

# Install yt-dlp
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Install dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/ytdlp-ui/package.json ./artifacts/ytdlp-ui/
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm --filter @workspace/ytdlp-ui run build
RUN pnpm --filter @workspace/api-server run build

EXPOSE 8080

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
