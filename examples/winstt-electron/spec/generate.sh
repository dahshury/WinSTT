#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPEC="$SCRIPT_DIR/openapi.yaml"

echo "Generating TypeScript types..."
cd "$SCRIPT_DIR/../frontend"
bunx openapi-typescript "$SPEC" -o "$SCRIPT_DIR/generated/ts/schema.d.ts"

echo "Done."
