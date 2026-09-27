#!/usr/bin/env bash
# Fail if any service image still defaults to the root user.
# k8s sets runAsNonRoot: true with runAsUser: 1001, so an image without a
# non-root USER is rejected by the kubelet at boot.
set -euo pipefail

fail=0
for df in services/*/Dockerfile frontend/Dockerfile; do
  [ -f "$df" ] || continue
  # Last USER instruction wins in Docker.
  user=$(grep -Ei '^USER[[:space:]]+' "$df" | tail -n 1 | awk '{print $2}' || true)
  if [ -z "$user" ]; then
    echo "FAIL: $df declares no USER (runs as root)"
    fail=1
  elif [ "$user" = "root" ] || [ "$user" = "0" ] || [ "$user" = "0:0" ]; then
    echo "FAIL: $df sets USER to root ($user)"
    fail=1
  else
    echo "OK: $df USER $user"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "One or more images run as root. Add a UID 1001 user and a trailing USER instruction."
  exit 1
fi
echo "All images declare a non-root USER."
