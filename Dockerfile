FROM node:26.13.1-slim

WORKDIR /opt/caais-middleware/
COPY ./package*.json ./
RUN npm ci --omit=dev

COPY ./ ./

# Run as non-root user for least-privilege execution.
USER node

CMD ["npm", "run", "start"]
