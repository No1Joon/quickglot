#!/bin/bash
# Records the outcome of a code review as a commit status, so that "was this
# reviewed?" is something GitHub can answer instead of something a person has to
# remember.
#
# The status is attached to a commit SHA, not to the pull request, which is the
# property that matters: pushing a fix invalidates the review, and the merge is
# blocked again until the new head is reviewed. A review that predates the code
# it supposedly covers is worse than no review, because it reads as approval.
#
#   scripts/review-status.sh <PR> pass "no findings"
#   scripts/review-status.sh <PR> fail "3 findings, see inline comments"
#
# Run by the reviewing session at the posting step of .agents/skills/code-review.
set -euo pipefail

CONTEXT="code-review"

usage() {
  echo "usage: $0 <pr-number> <pass|fail> [description]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
PR="$1"
RESULT="$2"
DESCRIPTION="${3:-}"

case "$RESULT" in
  pass) STATE="success"; DESCRIPTION="${DESCRIPTION:-Reviewed, no blocking findings}" ;;
  fail) STATE="failure"; DESCRIPTION="${DESCRIPTION:-Reviewed, findings to address}" ;;
  *) usage ;;
esac

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
SHA="$(gh pr view "$PR" --json headRefOid --jq .headRefOid)"

if [ -z "$SHA" ]; then
  echo "error: could not resolve the head commit of PR #$PR" >&2
  exit 1
fi

gh api "repos/$REPO/statuses/$SHA" \
  -f state="$STATE" \
  -f context="$CONTEXT" \
  -f description="$DESCRIPTION" \
  --jq '"\(.context): \(.state) — \(.description)"'

echo "attached to ${SHA:0:7}; a new commit clears it and the review must run again"
