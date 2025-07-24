![cableguard logo banner](./banner.png)

# RODiT Authentication API Server

This repository contains a sample API server that demonstrates the implementation of RODiT-based authentication using the RODiT Authentication SDK. The project is structured with a reusable SDK for Discernible Authentication and a sample Express.js API that showcases its usage.

## Repository Structure

- `/sdk` - The RODiT Authentication SDK (can be used in other projects)
- `/src` - Sample API implementation using the SDK
- `/config` - Configuration files for the API server
- `/certs` - SSL certificates for secure connections
- `/nginx` - Nginx configuration for production deployment

## About RODiT Authentication

RODiT (Record of Digital Trust) authentication leverages blockchain-based tokens for secure authentication. This system uses Public Key Cryptography with ownership verification through the NEAR Protocol in real-time. The PKC pair used for authentication is tied directly to the RODiT tokens themselves.

Learn more about this approach in our [technical article](https://vaceituno.medium.com/unleashing-the-power-of-public-key-cryptography-with-non-fungible-tokens-513286d47524).

## Prerequisites

- Node.js (v16 or higher)
- npm (v7 or higher)
- Access to NEAR Protocol testnet (for RODiT verification)
- Vault server (for credential management)

## Getting Started

### Installation

```bash
# Install dependencies for the API server
npm install

# Install dependencies for the SDK
cd sdk && npm install && cd ..
```

### Configuration

1. Set up your environment configuration in the `/config` directory
2. Configure Vault credentials for secure storage
3. Set up your NEAR Protocol connection details

### Running the API Server

```bash
# Start the API server with nodemon for development
npm start

# Or start as a background process
setsid npm start >/dev/null 2>&1 < /dev/null &
```

## Using the SDK in Your Own Projects

The SDK located in the `/sdk` directory can be used independently in other projects. See the [SDK README](/sdk/README.md) for detailed documentation on how to integrate Discernible Authentication into your own applications.

## API Documentation

The API server includes Swagger documentation accessible at `/api-docs` when the server is running.

## Docker Deployment

This repository includes Docker configuration for easy deployment:

```bash
# Build and run the API container
docker build -f api.Dockerfile -t rodit-api .
docker run -p 3000:3000 rodit-api

# For production with Nginx
docker-compose up -d
```

## Security Considerations
- All authentication tokens are transmitted via HTTP headers, not cookies
- Permissions are validated for each protected route
- Vault is used for secure credential storage
- Token expiry and renewal is handled automatically

## 5. Jump start your server account

Install near and create an implicit account ID and a key pair with the command:
near generate-key

Output example:
- Key pair with ed25519:BNcExLS7k84HswwFHpB49jZnh1y6bsRS7P51FVmeBBxs public key for an ACCOUNT "9a1de9b4aa4ddd4a3091f43f1de680a9f5405d70e8ca69c3fb5daa96b5cd1270"
- Resulting in the key pair stored in: ~/.near-credentials/testnet/9a1de9b4aa4ddd4a3091f43f1de680a9f5405d70e8ca69c3fb5daa96b5cd1270.json
- From your NEAR wallet send some 0.01 Near to the newly generated implicit account ID to activate it