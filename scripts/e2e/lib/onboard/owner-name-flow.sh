#!/usr/bin/env bash

# Onboarding's first question is the owner's own name; there is no agent-naming
# prompt and no one-agent-or-team menu to acknowledge first.
# Callers provide their log predicate and existing send function/input custody.
wait_for_owner_name_prompt() {
  local contains_fn="${1:?missing log predicate}"
  local timeout_s="${2:?missing prompt timeout}"
  local started_s="$SECONDS"
  if [[ ! "$timeout_s" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid owner-name prompt timeout" >&2
    return 2
  fi
  while true; do
    if "$contains_fn" "What's your name?"; then
      return 0
    fi
    if (( SECONDS - started_s >= timeout_s )); then
      echo "Timeout waiting for owner-name prompt" >&2
      return 1
    fi
    sleep 0.2
  done
}
