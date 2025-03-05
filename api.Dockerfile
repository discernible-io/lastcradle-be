FROM node:18

# Install tini
ENV TINI_VERSION v0.19.0
ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini /tini
RUN chmod +x /tini

WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install dependencies with extra error handling
RUN npm install --production \
    && npm cache clean --force \
    && rm -rf /root/.npm/_cacache

# Copy application files
COPY . .

# Create non-root user for better security
RUN adduser --disabled-password --gecos "" nodeuser && \
    chown -R nodeuser:nodeuser /app

USER nodeuser

# Update the port to match your application (3443 from your GitHub workflow)
EXPOSE 8080

ENTRYPOINT ["/tini", "--"]

# Fix the path to point to src/app.js
CMD ["node", "src/app.js"]