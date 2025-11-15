#!/bin/bash

# Start Hardhat node in the background
echo "🚀 Starting Hardhat node..."
hardhat node --network hardhat --no-deploy > /dev/null 2>&1 &
NODE_PID=$!

# Wait for the node to be ready
echo "⏳ Waiting for Hardhat node to be ready..."
sleep 5

# Try to connect to the node (retry up to 10 times)
for i in {1..10}; do
  if curl -s http://127.0.0.1:8545 > /dev/null 2>&1; then
    echo "✅ Hardhat node is ready!"
    break
  fi
  if [ $i -eq 10 ]; then
    echo "❌ Failed to connect to Hardhat node"
    kill $NODE_PID 2>/dev/null
    exit 1
  fi
  sleep 2
done

# Fund the account
echo "💰 Funding account 0xfcf94dd41b2b5d6c887a30273f995d01baca1a45 with 99 ETH..."
npx hardhat run scripts/fund-account.ts --network localhost

# Keep the node running
echo "✅ Hardhat node is running with funded account"
echo "📝 Node PID: $NODE_PID"
echo "🛑 Press Ctrl+C to stop the node"

# Wait for the node process
wait $NODE_PID






