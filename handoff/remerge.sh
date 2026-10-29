#!/bin/bash
# Re-merge every phase branch (and polish) into jamsesh/improvements; stop at the first conflict.
cd ~/jamsesh-final || exit 1
git status --porcelain | grep -q . && { echo "dirty worktree"; exit 1; }
for b in jamsesh/phase-1 jamsesh/phase-2 jamsesh/phase-3 jamsesh/phase-4 jamsesh/phase-5 jamsesh/phase-6 jamsesh/phase-7 jamsesh/polish; do
  git rev-parse -q --verify "refs/heads/$b" >/dev/null || { echo "skip $b"; continue; }
  if git merge --no-edit -m "JamSesh integration: merge $b" "refs/heads/$b" >/tmp/claude-501/remerge-$$.log 2>&1; then
    echo "merged $b"
  else
    echo "CONFLICT $b:"; git diff --name-only --diff-filter=U; exit 2
  fi
done
