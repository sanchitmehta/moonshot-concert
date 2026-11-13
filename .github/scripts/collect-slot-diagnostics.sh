#!/usr/bin/env bash
set -euo pipefail

app="${1:?App name is required}"
: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output="$RUNNER_TEMP/slot-diagnostics"
mkdir -p "$output"

# Diagnostic failures must not hide the deployment failure or trigger another swap.
if ! az webapp log download -g "$RESOURCE_GROUP" -n "$app" --slot staging \
  --log-file "$output/staging-logs.zip" >"$output/log-download.txt" 2>&1; then
  echo "::warning::Could not download staging logs; see log-download.txt."
fi

if ! az monitor activity-log list -g "$RESOURCE_GROUP" --offset 1h --max-events 100 \
  -o json >"$output/activity.json" 2>"$output/activity-error.txt"; then
  echo "::warning::Could not read Azure activity records; see activity-error.txt."
fi

if ! az webapp list-instances -g "$RESOURCE_GROUP" -n "$app" --slot staging \
  -o json >"$output/staging-instances.json" 2>"$output/instances-error.txt"; then
  echo "::warning::Could not read staging instances; see instances-error.txt."
fi
