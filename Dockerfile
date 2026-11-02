FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY agent ./agent
COPY demo ./demo
COPY public ./public
ENV PORT=80
EXPOSE 80
CMD ["node", "server.mjs"]
