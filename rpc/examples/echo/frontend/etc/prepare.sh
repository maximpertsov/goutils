#!/bin/bash

rm -rf src/gen

# Ours
mkdir -p src/gen/proto/rpc/examples
cp -R ../../../../dist/js/proto/rpc/examples/echo src/gen/proto/rpc/examples

# Ours-ES
mkdir -p src/gen/proto/rpc_es/examples
cp -R ../../../../dist/es/proto/rpc/examples/echo src/gen/proto/rpc_es/examples

# Third-Party
mkdir -p src/gen/google
cp -R ../../../../dist/js/google/api src/gen/google

# Third-Party-ES
mkdir -p src/gen/google_es
cp -R ../../../../dist/es/google/api src/gen/google_es
