FROM node:20-alpine
WORKDIR /app
# Copy package manifests and install all deps (including dev) for nodemon
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]


