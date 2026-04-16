FROM node:22-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY prisma ./prisma/
RUN npx prisma generate

COPY src ./src/
COPY public ./public/

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push --skip-generate && node src/start.js"]
