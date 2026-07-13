FROM docker.io/nginx:mainline-alpine

ARG NODE_ENV=main

RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache openssl && \
    rm /etc/nginx/conf.d/default.conf && \
    mkdir -p /app/certs

COPY nginx/nginx.${NODE_ENV}.conf /etc/nginx/nginx.conf
COPY frontend /app/frontend

RUN chown -R nginx:nginx /etc/nginx/nginx.conf /var/cache/nginx /var/log/nginx /etc/nginx/conf.d /app

USER nginx
EXPOSE 443 8443

CMD ["nginx", "-g", "daemon off;"]
