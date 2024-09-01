# Server Dockerfile
FROM node:18

# Install tini
ENV TINI_VERSION v0.19.0
ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini /tini
RUN chmod +x /tini

WORKDIR /app

# Copy configuration files
COPY 9cf2d3a9d4caa4f269e9ccdddfdb3026dab1d5a085afee0b57e85622e6c4a500.json /home/icarus35/.near-credentials/testnet/9cf2d3a9d4caa4f269e9ccdddfdb3026dab1d5a085afee0b57e85622e6c4a500.json
COPY roditconfig.server /etc/rodit/roditconfig.server

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Expose port
EXPOSE 8080

# Use tini as entrypoint
ENTRYPOINT ["/tini", "--"]

# Run the application
CMD ["node", "app.js"]
