#!/usr/bin/env bash
# `bun audit` fails the build when it cannot reach the advisory service, and that
# is the correct behaviour: an audit that did not run must never read as a clean
# result. This repository closed a defect of exactly that shape in 1.0.7, where a
# daemon version gate that could not verify exited zero and passed the artifact it
# existed to reject.
#
# What is not correct is spending a release on a blip. On 2026-09-19 the service
# returned 503 for twenty-four minutes and killed three consecutive runs.
#
# So the request is retried, and only the request. A real answer - a vulnerability,
# a malformed lockfile, a missing binary - is not retried and fails on the first
# attempt. If every attempt fails to reach the service, this still exits non-zero:
# the retry widens the window, it does not soften the verdict. An outage longer
# than that window is a genuine unavailability and is meant to fail.
set -uo pipefail

# Overridable so the behaviour can be tested without waiting out the backoff.
# CI passes neither.
attempts="${AUDIT_RETRY_ATTEMPTS:-5}"
delay="${AUDIT_RETRY_INITIAL_DELAY:-15}"

for attempt in $(seq 1 "$attempts"); do
  output="$(bun audit --production 2>&1)"
  status=$?
  printf '%s\n' "$output"
  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  if ! printf '%s' "$output" | grep -qiE \
    'audit request failed \(status 5[0-9][0-9]\)|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up'; then
    exit "$status"
  fi

  if [ "$attempt" -lt "$attempts" ]; then
    printf 'advisory service unreachable; retrying in %ss (attempt %s of %s)\n' \
      "$delay" "$attempt" "$attempts" >&2
    sleep "$delay"
    delay=$((delay * 2))
  fi
done

printf 'dependency audit could not reach the advisory service in %s attempts; refusing to report a clean result\n' \
  "$attempts" >&2
exit 1
