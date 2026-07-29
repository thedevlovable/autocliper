---
name: GitHub remote setup
description: How the GitHub remote is configured for this project
---

## Repo
`https://github.com/xbhiblackbox/autoacliper`

## Push method
Replit's `gitPush()` callback does NOT work — no GitHub account linked to this Replit.
Push is done via: `git remote set-url origin https://{TOKEN}@github.com/xbhiblackbox/autoacliper.git && git push && git remote set-url origin https://github.com/...` (token removed after push).

**Why:** The user's GitHub account is not connected to Replit's git integration. Manual token-in-URL is the workaround.
**How to apply:** Always remove token from remote URL immediately after push. Warn user that tokens shared in chat should be revoked.
