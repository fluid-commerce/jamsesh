cd ~/jamsesh-p4/jamsesh; set -a; . ~/.claude/api-keys.env; set +a; export JAMSESH_SILENT=1
perl -e 'alarm 180; exec @ARGV' bun test "$@" 2>&1 | tail -${TAILN:-60}
