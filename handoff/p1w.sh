parent=$1; shift
"$@" <&0 &
child=$!
stop() { kill $child 2>/dev/null; i=0; while kill -0 $child 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done; kill -9 $child 2>/dev/null; wait $child 2>/dev/null; }
trap 'stop; exit 0' TERM INT HUP
while kill -0 $child 2>/dev/null && [ "$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')" = "$parent" ]; do
  sleep 1 & wait $!
done
if kill -0 $child 2>/dev/null; then stop; exit 0; fi
wait $child; exit $?