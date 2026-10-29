export JAMSESH_SILENT=1
cd /Users/cheyrasmussen/jamsesh/jamsesh; S=$(date +%s); perl -e 'alarm 600; exec @ARGV' bun test hub/test/audio.bench.test.ts > /tmp/claude-501/main-audio.log 2>&1; echo "main secs $(( $(date +%s)-S ))" > /tmp/claude-501/bench-times.txt
cd /Users/cheyrasmussen/jamsesh-p1/jamsesh; S=$(date +%s); perl -e 'alarm 600; exec @ARGV' bun test hub/test/audio.bench.test.ts > /tmp/claude-501/p1-audio.log 2>&1; echo "p1 secs $(( $(date +%s)-S ))" >> /tmp/claude-501/bench-times.txt
