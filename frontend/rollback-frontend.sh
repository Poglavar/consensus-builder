#!/bin/bash

# Frontend rollback script for consensus-builder
# Rolls back to a previous backup from /var/www

set -e  # Exit on any error

# Configuration
SSHKRPA='ssh root@207.154.200.141 -i ~/.ssh/id_ed25519'
REMOTE_PATH='/var/www/urbangametheory.xyz'
BACKUP_BASE='/var/www'

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}🔄 Starting frontend rollback...${NC}"

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

# Find all backups in /var/www
echo -e "${YELLOW}📋 Searching for backups in $BACKUP_BASE...${NC}"

# Get list of backup directories (format: /var/www/urbangametheory.xyz_backup_YYYYMMDD_HHMMSS)
BACKUP_DIRS=$($SSHKRPA "ls -1d $BACKUP_BASE/urbangametheory.xyz_backup_* 2>/dev/null" || echo "")
 
# Get list of backup zip/tar files
BACKUP_ZIPS=$($SSHKRPA "ls -1 $BACKUP_BASE/*.zip $BACKUP_BASE/*.tar.gz $BACKUP_BASE/*.tar 2>/dev/null" || echo "")

# Combine, sort newest-first, and keep latest 10 entries
BACKUPS=$(echo -e "$BACKUP_DIRS\n$BACKUP_ZIPS" | grep -v '^$' | sort -r | head -10)
BACKUP_COUNT=$(echo "$BACKUPS" | grep -c . || echo "0")

if [ "$BACKUP_COUNT" -eq 0 ]; then
    echo -e "${RED}❌ No backups found in $BACKUP_BASE${NC}"
    echo -e "${YELLOW}💡 Backups should be in format: ${REMOTE_PATH}_backup_YYYYMMDD_HHMMSS or *.zip/*.tar.gz files${NC}"
    exit 1
fi

# Display available backups with numbers
echo -e "\n${BLUE}Available backups:${NC}"
echo -e "${BLUE}────────────────────────────────────────────────────────────────${NC}"
INDEX=1
declare -a BACKUP_ARRAY
while IFS= read -r backup; do
    if [ -n "$backup" ]; then
        BACKUP_ARRAY[$INDEX]="$backup"
        # Extract filename for display
        BACKUP_NAME=$(basename "$backup")
        # Get file size or directory info
        if [[ "$backup" == *.zip ]] || [[ "$backup" == *.tar.gz ]] || [[ "$backup" == *.tar ]]; then
            SIZE=$($SSHKRPA "du -h '$backup' | cut -f1" 2>/dev/null || echo "unknown")
            echo -e "${YELLOW}  [$INDEX]${NC} ${GREEN}$BACKUP_NAME${NC} (${SIZE})"
        else
            SIZE=$($SSHKRPA "du -sh '$backup' | cut -f1" 2>/dev/null || echo "unknown")
            echo -e "${YELLOW}  [$INDEX]${NC} ${GREEN}$BACKUP_NAME${NC} (${SIZE})"
        fi
        ((INDEX++))
    fi
done <<< "$BACKUPS"
echo -e "${BLUE}────────────────────────────────────────────────────────────────${NC}"

# Prompt user for selection
echo ""
read -p "$(echo -e ${YELLOW}Select backup number to rollback to [1-$((INDEX-1))]: ${NC})" SELECTION

# Validate selection
if ! [[ "$SELECTION" =~ ^[0-9]+$ ]] || [ "$SELECTION" -lt 1 ] || [ "$SELECTION" -ge "$INDEX" ]; then
    echo -e "${RED}❌ Invalid selection. Please choose a number between 1 and $((INDEX-1)).${NC}"
    exit 1
fi

SELECTED_BACKUP="${BACKUP_ARRAY[$SELECTION]}"
SELECTED_NAME=$(basename "$SELECTED_BACKUP")

echo -e "${YELLOW}📦 Selected backup: ${GREEN}$SELECTED_NAME${NC}"

# Create backup of current deployment before rollback
echo -e "${YELLOW}💾 Creating backup of current deployment before rollback...${NC}"
CURRENT_BACKUP_NAME="backup_$(date +%Y%m%d_%H%M%S)"
$SSHKRPA "if [ -d '$REMOTE_PATH' ] && [ \"\$(ls -A $REMOTE_PATH)\" ]; then cp -r $REMOTE_PATH ${REMOTE_PATH}_$CURRENT_BACKUP_NAME; echo 'Pre-rollback backup created: ${REMOTE_PATH}_$CURRENT_BACKUP_NAME'; fi"

# Determine backup type and handle accordingly
if [[ "$SELECTED_BACKUP" == *.zip ]] || [[ "$SELECTED_BACKUP" == *.tar.gz ]] || [[ "$SELECTED_BACKUP" == *.tar ]]; then
    # It's a zip/tar file - need to extract it
    echo -e "${YELLOW}📂 Extracting backup archive...${NC}"
    
    # Create temporary extraction directory
    TEMP_DIR="/tmp/rollback_extract_$$"
    $SSHKRPA "mkdir -p $TEMP_DIR"
    
    # Extract based on file type
    if [[ "$SELECTED_BACKUP" == *.zip ]]; then
        $SSHKRPA "cd $TEMP_DIR && unzip -q '$SELECTED_BACKUP'"
    elif [[ "$SELECTED_BACKUP" == *.tar.gz ]]; then
        $SSHKRPA "cd $TEMP_DIR && tar -xzf '$SELECTED_BACKUP'"
    elif [[ "$SELECTED_BACKUP" == *.tar ]]; then
        $SSHKRPA "cd $TEMP_DIR && tar -xf '$SELECTED_BACKUP'"
    fi
    
    # Find the extracted directory (could be in root or nested)
    # First, try to find urbangametheory.xyz directory
    EXTRACTED_DIR=$($SSHKRPA "find $TEMP_DIR -type d -name 'urbangametheory.xyz*' | head -1" || echo "")
    
    if [ -z "$EXTRACTED_DIR" ]; then
        # If no specific directory found, check if files are directly in temp dir
        if $SSHKRPA "test -f $TEMP_DIR/index.html"; then
            EXTRACTED_DIR="$TEMP_DIR"
        else
            # Look for first subdirectory with index.html
            EXTRACTED_DIR=$($SSHKRPA "find $TEMP_DIR -type f -name 'index.html' | head -1 | xargs dirname" || echo "")
            if [ -z "$EXTRACTED_DIR" ]; then
                # Fallback to first subdirectory
                EXTRACTED_DIR=$($SSHKRPA "ls -1d $TEMP_DIR/*/ 2>/dev/null | head -1" || echo "$TEMP_DIR")
            fi
        fi
    fi
    
    # Remove trailing slash if present
    EXTRACTED_DIR=$(echo "$EXTRACTED_DIR" | sed 's:/*$::')
    
    SOURCE_PATH="$EXTRACTED_DIR"
    
    # Cleanup temp dir after rollback
    CLEANUP_TEMP="rm -rf $TEMP_DIR"
else
    # It's a directory backup - use it directly
    SOURCE_PATH="$SELECTED_BACKUP"
    CLEANUP_TEMP=""
fi

# Verify source path exists and has content
echo -e "${YELLOW}🔍 Verifying backup contents...${NC}"
if ! $SSHKRPA "test -d '$SOURCE_PATH' && [ \"\$(ls -A $SOURCE_PATH)\" ]"; then
    echo -e "${RED}❌ Error: Backup directory is empty or doesn't exist: $SOURCE_PATH${NC}"
    if [ -n "$CLEANUP_TEMP" ]; then
        $SSHKRPA "$CLEANUP_TEMP"
    fi
    exit 1
fi

# Check if index.html exists in backup
if ! $SSHKRPA "test -f '$SOURCE_PATH/index.html'"; then
    echo -e "${YELLOW}⚠️  Warning: index.html not found in backup. Continuing anyway...${NC}"
fi

# Perform rollback
echo -e "${YELLOW}🔄 Rolling back to selected backup...${NC}"

# Remove current deployment (but keep it backed up)
$SSHKRPA "find $REMOTE_PATH -mindepth 1 -delete 2>/dev/null || rm -rf $REMOTE_PATH/* $REMOTE_PATH/.[^.]* $REMOTE_PATH/..?* 2>/dev/null || true"

# Copy backup contents to live site
# Copy all files including hidden ones
$SSHKRPA "cp -a $SOURCE_PATH/. $REMOTE_PATH/ 2>/dev/null || cp -r $SOURCE_PATH/* $REMOTE_PATH/ 2>/dev/null || true"

# Cleanup temp directory if we created one
if [ -n "$CLEANUP_TEMP" ]; then
    echo -e "${YELLOW}🧹 Cleaning up temporary files...${NC}"
    $SSHKRPA "$CLEANUP_TEMP"
fi

# Set proper permissions
echo -e "${YELLOW}🔐 Setting proper permissions...${NC}"
$SSHKRPA "chown -R www-data:www-data $REMOTE_PATH && chmod -R 755 $REMOTE_PATH"

# Verify rollback
echo -e "${YELLOW}🧪 Verifying rollback...${NC}"
if $SSHKRPA "test -f $REMOTE_PATH/index.html"; then
    echo -e "${GREEN}✅ index.html found on server${NC}"
else
    echo -e "${RED}❌ Warning: index.html not found on server after rollback${NC}"
fi

# Reload nginx
echo -e "${YELLOW}🌐 Reloading web server...${NC}"
if $SSHKRPA "systemctl is-active --quiet nginx"; then
    if $SSHKRPA "nginx -t && systemctl reload nginx"; then
        echo -e "${GREEN}✅ Nginx reloaded successfully${NC}"
    else
        echo -e "${YELLOW}⚠️  Warning: Nginx reload failed, but rollback completed${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Nginx is not running. You may need to start it manually.${NC}"
fi

echo -e "\n${GREEN}🎉 Rollback completed successfully!${NC}"
echo -e "${GREEN}🌐 Your site should be available at: http://urbangametheory.xyz${NC}"
echo -e "\n${YELLOW}📊 Rollback Summary:${NC}"
echo -e "  • Rolled back to: $SELECTED_NAME"
echo -e "  • Pre-rollback backup: ${REMOTE_PATH}_$CURRENT_BACKUP_NAME"
echo -e "  • Remote path: $REMOTE_PATH"
echo -e "  • Server: 207.154.200.141"
