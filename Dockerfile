FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
COPY tests ./tests
COPY server ./server
COPY migrations ./migrations
COPY templates ./templates
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 PUBLIC_DIR=dist/public
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY templates ./templates
USER node
EXPOSE 3000
CMD ["node", "dist/server/server/index.js"]
