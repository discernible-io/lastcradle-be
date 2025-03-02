FROM node:18

ENV TINI_VERSION v0.19.0
ENV NODE_ENV=development

ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini /tini
RUN chmod +x /tini

WORKDIR /app

# Copy package files first for caching
COPY package*.json ./

# Install dependencies
RUN npm install --production \
    && npm cache clean --force \
    && rm -rf /root/.npm/_cacache

# Copy the config directory to the root
COPY config/ ./config/

# Copy the src directory
COPY src/ ./src/

# Create necessary directories
RUN mkdir -p /app/logs /app/data

# Set entry point to app.js
ENTRYPOINT ["/tini", "--"]
CMD ["node", "src/app.js"]