#!/usr/bin/env bash
set -euo pipefail

app="${1:?App name is required}"
service="${2:?Service name is required}"
: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

wait_ready() {
  local hostname="$1" body status
  for attempt in $(seq 1 90); do
    body=$(curl -fsS --connect-timeout 5 --max-time 10 "https://$hostname/version" || true)
    if echo "$body" | jq -e --arg sha "$GITHUB_SHA" --arg service "$service" \
      '.service == $service and .commit == $sha' >/dev/null; then
      status=$(curl -sS --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' \
        "https://$hostname/health/ready" || true)
      if [[ "$status" == "200" ]]; then
        echo "$body"
        return 0
      fi
    fi
    sleep 10
  done
  echo "Expected commit $GITHUB_SHA is not ready on $hostname; inspect the slot logs and dependencies." >&2
  return 1
}

staging_hostname=$(az webapp show -g "$RESOURCE_GROUP" -n "$app" --slot staging --query defaultHostName -o tsv)
production_hostname=$(az webapp show -g "$RESOURCE_GROUP" -n "$app" --query defaultHostName -o tsv)

az webapp deploy -g "$RESOURCE_GROUP" -n "$app" --slot staging \
  --src-path "$RUNNER_TEMP/app.zip" --type zip --restart true \
  --async false --track-status true --timeout 1200000

# Failed staging checks leave production untouched. Never redeploy to production as a fallback.
wait_ready "$staging_hostname"
az webapp deployment slot swap -g "$RESOURCE_GROUP" -n "$app" \
  --slot staging --target-slot production

# A failed or uncertain swap needs inspection, not an automatic second swap.
wait_ready "$production_hostname"
