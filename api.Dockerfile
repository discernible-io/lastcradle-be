FROM node:20.20.2-alpine3.23@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

FROM node:20.20.2-alpine3.23@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS production

ARG NODE_ENV=main
ENV NODE_ENV=${NODE_ENV}

RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache tini 'libcrypto3>=3.5.8-r0' 'libssl3>=3.5.8-r0' \
    && adduser -D -H -s /sbin/nologin nodeuser \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY --from=builder --chown=nodeuser:nodeuser /app ./

USER nodeuser
EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/app.js"]
