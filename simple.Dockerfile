FROM node:18

WORKDIR /app

# Copy everything
COPY . .

# Install dependencies
RUN npm install --production

# Create app directories with proper permissions
RUN mkdir -p /app/data /app/logs && chmod 777 /app/data /app/logs

EXPOSE 8080

CMD ["node", "src/app.js"]
