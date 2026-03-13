#!/bin/bash
set -e

npm install --prefer-offline --no-audit --no-fund 2>&1 | tail -5

npx tsx scripts/push-schema.ts 2>&1

echo "Post-merge setup complete"
