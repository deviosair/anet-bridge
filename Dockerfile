FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY a2a-handler.js ./
COPY identity/ ./identity/
COPY experience-layer/ ./experience-layer/
COPY schemas/ ./schemas/

EXPOSE 3000

CMD ["node", "server.js"]
