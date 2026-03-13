#!/bin/bash
set -e

npm install --prefer-offline --no-audit --no-fund 2>&1 | tail -5

npx drizzle-kit push --force 2>&1 | tail -10

echo "Post-merge setup complete"
