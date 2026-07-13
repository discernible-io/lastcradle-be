#!/bin/bash
# Script to start syntheticlc containers on port 8443
# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if a container is running
check_container_status() {
    local container_name=$1
    local status=$(podman inspect -f '{{.State.Status}}' "$container_name" 2>/dev/null)
    [ "$status" = "running" ] && return 0 || return 1
}

# Function to get container logs
get_container_logs() {
    local container_name=$1
    echo -e "${YELLOW}Last 10 lines of logs for $container_name:${NC}"
    podman logs --tail 10 "$container_name"
}

# Function to start a container and verify it's running
start_container() {
    local container_name=$1
    local max_retries=3
    local retry_count=0
    
    echo -e "${YELLOW}Starting $container_name...${NC}"
    
    while [ $retry_count -lt $max_retries ]; do
        podman start "$container_name" >/dev/null 2>&1
        
        # Wait for container to start (with timeout)
        local wait_count=0
        while [ $wait_count -lt 10 ]; do
            if check_container_status "$container_name"; then
                echo -e "${GREEN}✓ Successfully started $container_name${NC}"
                return 0
            fi
            sleep 1
            ((wait_count++))
        done
        
        # If container failed to start, get logs
        get_container_logs "$container_name"
        
        ((retry_count++))
        if [ $retry_count -lt $max_retries ]; then
            echo -e "${YELLOW}Retrying to start $container_name (attempt $retry_count of $max_retries)${NC}"
        fi
    done
    
    echo -e "${RED}✗ Failed to start $container_name after $max_retries attempts${NC}"
    return 1
}

# Main script
echo "Starting syntheticlc containers on port 8443..."

# Define the containers in the order they should be started
CONTAINERS=(
    "syntheticlc-container"
    "syntheticlc-nginx"
)

# Start each container in order
for container in "${CONTAINERS[@]}"; do
    if podman container exists "$container"; then
        if ! start_container "$container"; then
            echo -e "${RED}Error: Failed to start $container. Stopping script.${NC}"
            get_container_logs "$container"
            exit 1
        fi
        sleep 2  # Give containers time to initialize
    else
        echo -e "${YELLOW}Warning: Container $container does not exist, skipping...${NC}"
    fi
done

# Final status check
echo -e "\n${YELLOW}Checking final status of all containers...${NC}"
all_running=true
for container in "${CONTAINERS[@]}"; do
    if podman container exists "$container"; then
        if check_container_status "$container"; then
            echo -e "${GREEN}✓ $container is running${NC}"
        else
            echo -e "${RED}✗ $container is not running${NC}"
            get_container_logs "$container"
            all_running=false
        fi
    else
        echo -e "${YELLOW}? $container does not exist${NC}"
        all_running=false
    fi
done

if [ "$all_running" = true ]; then
    echo -e "\n${GREEN}All containers started successfully!${NC}"
    echo -e "syntheticlc service is now accessible on port 8443"
else
    echo -e "\n${YELLOW}Some containers had issues. Please check the logs above for more information.${NC}"
    exit 1
fi
