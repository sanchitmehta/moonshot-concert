#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/deploy-slot.sh"
temp=$(mktemp -d)
trap 'rm -f "$temp/events" "$temp/output"; rmdir "$temp"' EXIT
export RESOURCE_GROUP=test-group GITHUB_SHA=0123456789012345678901234567890123456789 RUNNER_TEMP="$temp"
export EVENTS="$temp/events"

az() {
  echo "az $*" >> "$EVENTS"
  case "$*" in
    "webapp show "*)
      if [[ "$*" == *"--slot staging"* ]]; then echo staging.example; else echo production.example; fi
      ;;
    "webapp deploy "*)
      [[ "$*" == *"--slot staging"* ]] || return 1
      [[ "$*" == *"--async false --track-status true"* ]] || return 1
      [[ "$SCENARIO" != deploy-fails ]]
      ;;
    "webapp deployment slot swap "*)
      [[ "$*" == *"--slot staging --target-slot production"* ]] || return 1
      [[ "$SCENARIO" != swap-fails ]]
      ;;
    *) return 1 ;;
  esac
}

curl() {
  local url="${!#}" commit="$GITHUB_SHA" service="$SERVICE"
  echo "curl $url" >> "$EVENTS"
  if [[ "$url" == */version ]]; then
    [[ "$SCENARIO" != wrong-commit ]] || commit=old
    [[ "$SCENARIO" != wrong-service ]] || service=other
    printf '{"service":"%s","commit":"%s"}\n' "$service" "$commit"
  elif [[ "$SCENARIO" == staging-unhealthy && "$url" == *staging.example* ]]; then
    echo 503
  elif [[ "$SCENARIO" == production-unhealthy && "$url" == *production.example* ]]; then
    echo 503
  elif [[ "$SCENARIO" == staging-redirect && "$url" == *staging.example* ]]; then
    echo 302
  else
    echo 200
  fi
}

# Keep the real JSON and equality checks without requiring jq on development machines.
jq() {
  python -c 'import json,sys; v=json.load(sys.stdin); sys.exit(0 if v.get("commit")==sys.argv[1] and v.get("service")==sys.argv[2] else 1)' "$4" "$7"
}
sleep() { :; }
seq() { printf '1\n2\n'; }
export -f az curl jq sleep seq

for service in storefront-api data-platform-api; do
  export SERVICE="$service"
  for scenario in success wrong-commit wrong-service staging-unhealthy staging-redirect deploy-fails swap-fails production-unhealthy; do
    export SCENARIO="$scenario"
    : > "$EVENTS"
    if bash "$script" test-app "$service" > "$temp/output" 2>&1; then
      [[ "$scenario" == success ]] || { cat "$temp/output"; echo "Unexpected success: $service/$scenario" >&2; exit 1; }
    else
      [[ "$scenario" != success ]] || { cat "$temp/output"; exit 1; }
    fi

    swaps=$(grep -c '^az webapp deployment slot swap ' "$EVENTS" || true)
    case "$scenario" in
      success|swap-fails|production-unhealthy) [[ "$swaps" == 1 ]] ;;
      *) [[ "$swaps" == 0 ]] ;;
    esac
    if [[ "$scenario" == success ]]; then
      staging_ready=$(grep -n '^curl https://staging.example/health/ready$' "$EVENTS" | cut -d: -f1)
      swap=$(grep -n '^az webapp deployment slot swap ' "$EVENTS" | cut -d: -f1)
      production_ready=$(grep -n '^curl https://production.example/health/ready$' "$EVENTS" | cut -d: -f1)
      [[ "$staging_ready" -lt "$swap" && "$swap" -lt "$production_ready" ]]
    fi
    echo "PASS: $service/$scenario"
  done
done
