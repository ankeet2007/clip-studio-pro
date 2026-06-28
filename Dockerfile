FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Deno
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

# Install yt-dlp and Python packages
RUN pip3 install yt-dlp Pillow pilmoji --break-system-packages

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app
COPY . .

# Install dependencies
RUN pnpm install

# Build libs
RUN cd lib/db && npx -y -p typescript@5.9.2 tsc --build
RUN cd lib/api-zod && npx -y -p typescript@5.9.2 tsc --build

# Build backend
RUN cd artifacts/api-server && pnpm run build

# Build frontend
RUN cd artifacts/clip-studio && PORT=3000 BASE_PATH=/ pnpm run build

EXPOSE 3000

CMD ["node", "artifacts/api-server/dist/index.mjs"]
