#!/bin/bash

# System Information MOTD Script
# This script displays system statistics similar to Ubuntu's default MOTD

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get system information
HOSTNAME=$(hostname)
KERNEL=$(uname -r)
UPTIME=$(uptime -p | sed 's/up //')
LOAD=$(uptime | awk -F'load average:' '{ print $2 }' | awk '{ print $1 }' | sed 's/,//')
MEMORY_USAGE=$(free | grep Mem | awk '{printf("%.0f%%", $3/$2 * 100.0)}')
DISK_USAGE=$(df -h / | awk 'NR==2{printf "%s of %s", $3, $2}')
DISK_PERCENT=$(df / | awk 'NR==2{print $5}')
SWAP_USAGE=$(free | grep Swap | awk '{if($2>0) printf("%.0f%%", $3/$2 * 100.0); else print "0%"}')
PROCESSES=$(ps aux | wc -l)
USERS=$(who | wc -l)

# Get IP addresses
ETH0_IP=$(ip addr show eth0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1 | head -1)
if [ -z "$ETH0_IP" ]; then
    ETH0_IP=$(ip addr show $(ip route | grep default | awk '{print $5}' | head -1) 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1 | head -1)
fi

# Get additional network interfaces
ADDITIONAL_IPS=$(ip addr show | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | cut -d/ -f1 | grep -v "$ETH0_IP" | head -1)

# Get OS information
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_NAME="$NAME"
    OS_VERSION="$VERSION"
else
    OS_NAME=$(uname -s)
    OS_VERSION=$(uname -r)
fi

# Get architecture
ARCH=$(uname -m)

# Check for updates (if apt is available)
UPDATES=""
if command -v apt &> /dev/null; then
    # This is a simplified check - in production you might want to cache this
    UPDATES_COUNT=$(apt list --upgradable 2>/dev/null | grep -c upgradable)
    if [ "$UPDATES_COUNT" -gt 0 ]; then
        UPDATES="$UPDATES_COUNT updates can be applied immediately."
    else
        UPDATES="0 updates can be applied immediately."
    fi
fi

# Display the information
echo ""
echo -e "${GREEN}Welcome to $OS_NAME $OS_VERSION (GNU/Linux $KERNEL $ARCH)${NC}"
echo ""
echo " * Documentation:  https://help.ubuntu.com"
echo " * Management:     https://landscape.canonical.com"
echo " * Support:        https://ubuntu.com/pro"
echo ""
echo -e "${BLUE} System information as of $(date)${NC}"
echo ""

# Format the output in two columns
printf "  %-25s %s\n" "System load:" "$LOAD" "Processes:" "$PROCESSES"
printf "  %-25s %s\n" "Usage of /:" "$DISK_PERCENT of $DISK_USAGE" "Users logged in:" "$USERS"
printf "  %-25s %s\n" "Memory usage:" "$MEMORY_USAGE" "IPv4 address for eth0:" "${ETH0_IP:-N/A}"
printf "  %-25s %s\n" "Swap usage:" "$SWAP_USAGE" "IPv4 address for eth0:" "${ADDITIONAL_IPS:-N/A}"

echo ""
if [ -n "$UPDATES" ]; then
    echo "$UPDATES"
    echo ""
fi
