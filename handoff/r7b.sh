#!/bin/zsh
cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 7: the project wiki" --diff jamsesh/phase-4...jamsesh/phase-7 --repo "$HOME/jamsesh-p7" --context @/tmp/claude-501/p7-context.md \
 --focus "Path safety and file integrity in the vault: traversal, symlinks, concurrent writes, git usage, crash mid-write" \
 --focus "Prompt injection: can source text make ingest change anything beyond proposed wiki pages, or leak data?" \
 --focus "XSS and rendering safety in the Wiki tab and graph" \
 --focus "Approval semantics: can unapproved model output reach agents (jam_join, jam_wiki_*) or the pages?" \
 --focus "Confirm each finding in /tmp/claude-501/p7-review.md is fixed" --focus "Test quality and what to delete" > /tmp/claude-501/p7-review2.log 2>&1
echo "exit $?" >> /tmp/claude-501/p7-review2.log
