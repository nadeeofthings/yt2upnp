FROM node:18-alpine

# Install system dependencies (python3 and ffmpeg are required by yt-dlp)
RUN apk add --no-cache \
    python3 \
    ffmpeg \
    curl \
    ca-certificates

# Download and install the latest yt-dlp binary directly from GitHub
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Verify installations
RUN node -v && npm -v && python3 --version && ffmpeg -version && yt-dlp --version

WORKDIR /usr/src/app

# Copy dependency definitions and install production packages
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY index.js renderer.js dashboard.html ./

# Create directory for persistent token data (Lounge configurations)
RUN mkdir -p data

# Define default environment variables
ENV NODE_ENV=production
ENV PROXY_PORT=8085
ENV RECEIVER_PORT_START=8090

# Since network_mode: host is required, EXPOSE is informational but good for documentation
EXPOSE 8085 8090 8091 8092 8093 8094 8095

CMD ["npm", "start"]
