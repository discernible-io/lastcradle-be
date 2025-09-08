# Deployment Troubleshooting Guide

## Pre-Deployment Setup (One-Time Only)

### 1. Database Initialization
**CRITICAL**: Run this once before first deployment:

```bash
# On the target server, after first file sync
cd ~/servertest-app
node scripts/init-database.js
```

This creates the required `data/` and `logs/` directories and initializes the SQLite database with necessary tables.

## Common Deployment Issues

### Issue 1: SQLITE_CANTOPEN Error
**Symptom**: Application fails to start with database connection errors
**Cause**: Database not initialized or missing directories
**Solution**: 
```bash
ssh user@174.138.10.2
cd ~/servertest-app
node scripts/init-database.js
```

### Issue 2: Container Port Mismatch
**Symptom**: Service unreachable, nginx proxy errors
**Current Configuration**:
- API container exposes: 8080, 9443
- GitHub Actions API_PORT: 9443
- Nginx proxies to: `servertest-container:8080`
- App default port: 8080 (configurable)

**Verification**:
```bash
# Check if containers are running on expected ports
podman ps -a
podman port servertest-container
```

### Issue 3: Environment Variables Missing
**Required Variables** (from GitHub Actions):
- `LOKI_URL` - Loki logging endpoint
- `LOKI_BASIC_AUTH` - Loki authentication
- `LOKI_TLS_SKIP_VERIFY` - TLS verification setting
- `RODIT_NEAR_CREDENTIALS_SOURCE` - RODiT credentials source
- `SERVICE_NAME` - Service identifier
- `SERVERPORT` - Server port override
- `NEAR_CONTRACT_ID` - NEAR blockchain contract
- `VAULT_ENDPOINT` - Vault service endpoint
- `VAULT_ROLE_ID` - Vault authentication
- `VAULT_SECRET_ID` - Vault authentication
- `VAULT_TOKEN_TTL` - Vault token lifetime

**Verification**:
```bash
# Check environment variables in running container
podman exec servertest-container env | grep -E "(LOKI_|RODIT_|SERVICE_|VAULT_|NEAR_)"
```

### Issue 4: Volume Mount Permissions
**Symptom**: Nginx fails to start, permission denied errors
**Solution**:
```bash
# Ensure proper permissions for nginx logs
mkdir -p ~/servertest-app/logs/nginx
chmod 0775 ~/servertest-app/logs/nginx
podman unshare chown -R 101:101 ~/servertest-app/logs/nginx
```

### Issue 5: Pod Networking Issues
**Symptom**: Nginx can't reach API container
**Verification**:
```bash
# Check pod status
podman pod ps
podman pod inspect servertest-pod

# Test container connectivity
podman exec servertest-nginx curl -f http://servertest-container:8080/ || echo "Connection failed"
```

## Deployment Verification Steps

### 1. Check Container Status
```bash
ssh user@174.138.10.2
podman ps -a
podman pod ps
```

### 2. Check Application Logs
```bash
# API container logs
podman logs servertest-container

# Nginx logs
podman logs servertest-nginx

# Promtail logs
podman logs servertest-promtail
```

### 3. Test API Endpoints
```bash
# Test health endpoint
curl -k https://api.discernible.io:9443/

# Test API documentation
curl -k https://api.discernible.io:9443/api-docs/swagger.json
```

### 4. Check Loki Integration
```bash
# Verify Loki connectivity from container
podman exec servertest-container curl -sS -k "$LOKI_URL/loki/api/v1/status/buildinfo"
```

## Manual Deployment Steps

If automated deployment fails, use these manual steps:

### 1. Prepare Environment
```bash
ssh user@174.138.10.2
mkdir -p ~/servertest-app/{certs,logs,data,nginx,promtail}
mkdir -p ~/servertest-app/logs/nginx
chmod 0775 ~/servertest-app/logs/nginx
```

### 2. Sync Files
```bash
# From local machine
rsync -avz --delete \
  --exclude '.git' \
  --exclude '.github' \
  --exclude 'node_modules' \
  --exclude 'certs' \
  --exclude 'logs' \
  --exclude 'data' \
  ./ user@174.138.10.2:~/servertest-app/
```

### 3. Initialize Database (First Time Only)
```bash
ssh user@174.138.10.2
cd ~/servertest-app
node scripts/init-database.js
```

### 4. Build and Deploy Containers
```bash
# Clean up existing resources
podman pod exists servertest-pod && podman pod rm -f servertest-pod
podman image exists servertest-image:latest && podman rmi -f servertest-image:latest

# Create pod
podman pod create --name servertest-pod -p 9443:9443

# Build and run API container
podman build -t servertest-image:latest -f api.Dockerfile .
podman run -d \
  --pod servertest-pod \
  --name servertest-container \
  --restart=unless-stopped \
  -e LOKI_URL='$LOKI_URL' \
  -e SERVICE_NAME='$SERVICE_NAME' \
  # ... (add all required environment variables)
  -v ~/servertest-app/logs:/app/logs:Z \
  -v ~/servertest-app/data:/app/data:Z \
  -v ~/servertest-app/certs:/app/certs:ro,Z \
  servertest-image:latest

# Build and run nginx
podman build -t localhost/servertest-nginx:latest -f nginx.Dockerfile .
podman run -d \
  --pod servertest-pod \
  --name servertest-nginx \
  --restart=unless-stopped \
  -v ~/servertest-app/certs:/app/certs:ro,Z \
  -v ~/servertest-app/logs/nginx:/var/log/nginx:Z,U \
  localhost/servertest-nginx:latest
```

## Debugging Commands

### Container Inspection
```bash
# Inspect running containers
podman inspect servertest-container
podman inspect servertest-nginx

# Check resource usage
podman stats

# Access container shell
podman exec -it servertest-container sh
```

### Network Debugging
```bash
# Test internal connectivity
podman exec servertest-nginx ping servertest-container
podman exec servertest-container netstat -tlnp
```

### Log Analysis
```bash
# Follow logs in real-time
podman logs -f servertest-container

# Search for specific errors
podman logs servertest-container 2>&1 | grep -i error
podman logs servertest-container 2>&1 | grep -i "sqlite\|database"
```

## Recovery Procedures

### Complete Reset
```bash
# Stop and remove everything
podman pod stop servertest-pod
podman pod rm -f servertest-pod
podman image prune -f

# Preserve data but reset containers
# (Database and logs are preserved in host volumes)
```

### Database Reset (Use with Caution)
```bash
# Backup existing data
cp ~/servertest-app/data/database.sqlite ~/servertest-app/data/database.sqlite.backup

# Reinitialize database
cd ~/servertest-app
node scripts/init-database.js
```

## Monitoring and Alerts

### Key Metrics to Monitor
- Container health status
- API response times
- Database connection status
- Loki log ingestion
- SSL certificate expiration

### Health Check Endpoints
- `GET /` - Basic health check
- `GET /api-docs` - API documentation availability
- `GET /api/rodit/info` - RODiT configuration status (requires auth)

## Contact Information

For deployment issues:
- Check GitHub Actions logs first
- Review container logs on target server
- Verify all environment variables are set
- Ensure database initialization was completed

Remember: Database initialization is a **one-time manual step** that must be completed before the first deployment.
