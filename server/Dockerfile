FROM node:22-alpine
WORKDIR /app
COPY server ./server
COPY src ./src
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
