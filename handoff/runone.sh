#!/bin/zsh
cd ~/jamsesh-p6/jamsesh; set -a; . ~/.claude/api-keys.env; set +a; export JAMSESH_SILENT=1 JAMSESH_OFFLINE=1
perl -e 'alarm 180; exec @ARGV' bun test "$@" 2>&1 | /usr/bin/tail -30
