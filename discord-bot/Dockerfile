FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bot.js setup-structure.js poll-questions.js ./
RUN mkdir -p /app/data
CMD ["node", "bot.js"]
