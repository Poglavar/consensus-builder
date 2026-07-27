FROM node:20-alpine
WORKDIR /app
# node-canvas (renders the proposal thumbnails server-side) publishes no prebuilt binary for musl, so
# it compiles from source here and needs the cairo/pango/jpeg/gif headers plus a toolchain. They stay
# in the image because docker-compose runs `npm install` at container start against a mounted volume.
# font-noto-emoji draws the goal badge on each thumbnail; without an emoji font the glyph comes out blank.
# (Production is glibc and installs a prebuilt canvas binary, so it needs none of this.)
RUN apk add --no-cache \
    build-base \
    g++ \
    python3 \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev \
    librsvg-dev \
    font-noto-emoji
# Copy package manifests and install all deps (including dev) for nodemon
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]

