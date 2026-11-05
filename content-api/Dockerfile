FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Verifications de la regle des sorties (fenetre de 3 ans, tests/fenetre.test.mjs) : un echec arrete la construction,
# l'image d'avant reste et l'API en service ne change pas (patch d'entretien, novembre 2026).
COPY tests ./tests
RUN node --test --test-reporter=tap tests/fenetre.test.mjs
COPY src/gamenime/dashboard.html ./dist/gamenime/dashboard.html

FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","dist/index.js"]
