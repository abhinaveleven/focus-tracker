# Use a slim Node.js image for smaller footprint
FROM node:18-slim

# Install OpenSSL (needed for Prisma and Postgres)
RUN apt-get update && apt-get install -y openssl

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# Generate the Prisma client
RUN npx prisma generate

# Expose the internal port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]