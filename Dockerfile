FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# The build has to know the app's public address, or the admin's forms are
# refused behind HTTPS (see react-router.config.ts). It reads it from
# application_url in shopify.app.toml; a host can pass it instead with
# --build-arg SHOPIFY_APP_URL=https://your-app.example.com
ARG SHOPIFY_APP_URL
RUN npm run build

CMD ["npm", "run", "docker-start"]
