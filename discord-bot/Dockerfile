FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bot.js setup-structure.js ./
CMD ["node", "bot.js"]
