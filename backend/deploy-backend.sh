#!/bin/bash

# Deploy files to server
echo "Deploying files to server..."
rsync -avz --exclude 'node_modules' --exclude '.DS_Store' -e "ssh -i ~/.ssh/id_ed25519" * root@207.154.200.141:/var/www/consensus-builder-api/

# Install dependencies and restart PM2 process
echo "Installing dependencies and restarting service..."
ssh -i ~/.ssh/id_ed25519 root@207.154.200.141 << 'EOF'
cd /var/www/consensus-builder-api/

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Restart the PM2 process
echo "Restarting PM2 process..."
pm2 stop consensus-builder-api || true
pm2 start ecosystem.config.cjs

echo "Service restarted successfully!"
pm2 status
EOF

echo "Deployment complete!"
