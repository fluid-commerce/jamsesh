#!/bin/bash
# usage: rt.sh <limit> files...  (run from jamsesh/)
cd ~/jamsesh-final/jamsesh
export JAMSESH_SILENT=1 JAMSESH_OFFLINE=1 JAMSESH_BONJOUR_SERVICE=_jamsesh-test._tcp
lim=$1; shift
for f in "$@"; do
  H=$(mktemp -d); export JAMSESH_HOME=$H JAMSESH_DATA=$H/data
  out=$(perl -e "alarm $lim; exec @ARGV" bun test "$f" 2>&1); code=$?
  pass=$(echo "$out" | /usr/bin/grep -Eo '^ *[0-9]+ pass' | tr -d ' pass'); fail=$(echo "$out" | /usr/bin/grep -Eo '^ *[0-9]+ fail' | tr -d ' fail')
  echo "$f exit=$code pass=${pass:-?} fail=${fail:-?}"
  if [ "$code" != 0 ]; then echo "$out" | /usr/bin/grep -E "\(fail\)|error:|Expected|Received|^ +at .*test" | head -25; fi
  rm -rf "$H"
done
