FROM node:25-alpine

WORKDIR /app
COPY ./ /app

RUN apk add --no-cache curl \
    && npm ci

CMD ["npm", "run", "start"]
