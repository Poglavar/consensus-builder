#!/bin/bash

# Frontend deployment script for consensus-builder
# Deploys to sshkrpa server

set -e  # Exit on any error

# Configuration
SSHKRPA='ssh root@207.154.200.141 -i ~/.ssh/id_ed25519'
REMOTE_PATH='/var/www/urbangametheory.xyz'
LOCAL_FRONTEND_PATH='.'

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Starting frontend deployment...${NC}"

# Check if we're in the frontend directory
if [ ! -f "index.html" ]; then
    echo -e "${RED}❌ Error: index.html not found. Please run this script from the frontend directory.${NC}"
    exit 1
fi

# Check if SSH key exists
if [ ! -f ~/.ssh/id_ed25519 ]; then
    echo -e "${RED}❌ Error: SSH key ~/.ssh/id_ed25519 not found.${NC}"
    exit 1
fi

# Test SSH connection
echo -e "${YELLOW}🔍 Testing SSH connection...${NC}"
if ! $SSHKRPA "echo 'SSH connection successful'" > /dev/null 2>&1; then
    echo -e "${RED}❌ Error: Cannot connect to server. Check your SSH key and server details.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ SSH connection successful${NC}"

# Create remote directory if it doesn't exist
echo -e "${YELLOW}📁 Ensuring remote directory exists...${NC}"
$SSHKRPA "mkdir -p $REMOTE_PATH"

# Create backup of current deployment
echo -e "${YELLOW}💾 Creating backup of current deployment...${NC}"
BACKUP_NAME="backup_$(date +%Y%m%d_%H%M%S)"
$SSHKRPA "if [ -d '$REMOTE_PATH' ] && [ \"\$(ls -A $REMOTE_PATH)\" ]; then cp -r $REMOTE_PATH ${REMOTE_PATH}_$BACKUP_NAME; echo 'Backup created: ${REMOTE_PATH}_$BACKUP_NAME'; fi"

# Sync files to server
echo -e "${YELLOW}📤 Syncing files to server...${NC}"
rsync -avz --delete \
    --exclude='.git' \
    --exclude='.gitignore' \
    --exclude='node_modules' \
    --exclude='.DS_Store' \
    --exclude='deploy-frontend.sh' \
    --exclude='Dockerfile' \
    -e "ssh -i ~/.ssh/id_ed25519" \
    ./* root@207.154.200.141:$REMOTE_PATH/

# Set proper permissions
echo -e "${YELLOW}🔐 Setting proper permissions...${NC}"
$SSHKRPA "chown -R www-data:www-data $REMOTE_PATH && chmod -R 755 $REMOTE_PATH"

# Test if files were deployed correctly
echo -e "${YELLOW}🧪 Verifying deployment...${NC}"
if $SSHKRPA "test -f $REMOTE_PATH/index.html"; then
    echo -e "${GREEN}✅ index.html found on server${NC}"
else
    echo -e "${RED}❌ Error: index.html not found on server after deployment${NC}"
    exit 1
fi

# Check if nginx is running and reload if needed
echo -e "${YELLOW}🌐 Checking web server status...${NC}"
if $SSHKRPA "systemctl is-active --quiet nginx"; then
    echo -e "${GREEN}✅ Nginx is running${NC}"
    # Optionally reload nginx to ensure it serves the new files
    $SSHKRPA "nginx -t && systemctl reload nginx" && echo -e "${GREEN}✅ Nginx configuration reloaded${NC}"
else
    echo -e "${YELLOW}⚠️  Nginx is not running. You may need to start it manually.${NC}"
fi

echo -e "${GREEN}🎉 Frontend deployment completed successfully!${NC}"
echo -e "${GREEN}🌐 Your site should be available at: http://urbangametheory.xyz${NC}"

# Show deployment summary
echo -e "\n${YELLOW}📊 Deployment Summary:${NC}"
echo -e "  • Remote path: $REMOTE_PATH"
echo -e "  • Backup created: ${REMOTE_PATH}_$BACKUP_NAME"
echo -e "  • Files synced: $(find . -type f -not -path './.git/*' -not -path './node_modules/*' | wc -l) files"
echo -e "  • Server: 207.154.200.141"
