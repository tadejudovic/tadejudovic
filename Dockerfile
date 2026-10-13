FROM node:22-slim

# ffmpeg renders the videos; DejaVu is the fallback font if a Google Font can't be fetched.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Clips, renders, fonts and the database live here: mount a persistent volume at /data.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0 \
    FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
EXPOSE 3000
# Run node directly (not via npx) so Render's stop signal reaches the app and deploys are recorded as clean restarts.
CMD ["node", "--import", "tsx", "src/server.ts"]
