#!/usr/bin/env bash
# Auto-push all changes to GitHub origin.
# Token is stored in .git/config (never committed).

set -e

cd "$(git rev-parse --show-toplevel)"

# Stage everything
git add -A

# Check if there's anything to commit
if git diff --cached --quiet; then
  echo "[push-github] Nothing to commit — already up to date."
else
  MSG="${1:-"chore: auto-sync $(date '+%Y-%m-%d %H:%M')"}"
  git commit -m "$MSG"
  echo "[push-github] Committed: $MSG"
fi

# Push
echo "[push-github] Pushing to GitHub..."
git push origin main
echo "[push-github] ✓ Pushed to https://github.com/thedevlovable/autocliper"
