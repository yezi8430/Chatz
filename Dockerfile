FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /app/data
ENV DB_PATH=/app/data/app.db
ENV NODE_ENV=production
ENV PORT=20010
EXPOSE 20010

CMD ["node", "src/index.js"]
