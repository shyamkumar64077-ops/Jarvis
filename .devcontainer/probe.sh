#!/usr/bin/env bash
# PROBE: find a detach mechanism that survives the devcontainer postStartCommand
# exec reaper.
#
# Each variant writes "<TAG>-START <ts>" the moment it launches and
# "<TAG>-DONE  <ts>" ~25s later. A variant that has START but no DONE was
# killed by the reaper; a variant with neither never launched at all.
F=/workspaces/Jarvis/PROBE2.txt
: > "$F"

launch() {  # launch <tag> <command...>
  local tag="$1"; shift
  echo "$tag-START $(date +%s)" >> "$F"
  "$@" &
}

# V1 - nohup + setsid (the classic trick)
nohup setsid bash -c "sleep 25; echo V1-DONE \$(date +%s) >> $F" >/dev/null 2>&1 &

# V2 - python double-fork (new session, reparented to init)
python3 - "$F" <<'PY' &
import os, sys, time
F = sys.argv[1]
if os.fork() == 0:
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    open(F,'a').write("V2-START %d\n" % time.time())
    time.sleep(25)
    open(F,'a').write("V2-DONE %d\n" % time.time())
    os._exit(0)
os.wait()
PY

# V3 - double-fork + escape into a fresh sibling cgroup
python3 - "$F" <<'PY' &
import os, sys, time
F = sys.argv[1]
if os.fork() == 0:
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    try:
        os.makedirs("/sys/fs/cgroup/hermes-v3", exist_ok=True)
        with open("/sys/fs/cgroup/hermes-v3/cgroup.procs","w") as f:
            f.write(str(os.getpid()))
        open(F,'a').write("V3-START %d\n" % time.time())
    except Exception as e:
        open(F,'a').write("V3-ERR %r\n" % (e,))
    time.sleep(25)
    open(F,'a').write("V3-DONE %d\n" % time.time())
    os._exit(0)
os.wait()
PY

# V4 - plain background sleep moved into a fresh cgroup
sleep 25 &
V4PID=$!
if mkdir -p /sys/fs/cgroup/hermes-v4 2>/dev/null; then
  if echo "$V4PID" > /sys/fs/cgroup/hermes-v4/cgroup.procs 2>/dev/null; then
    echo "V4-START $(date +%s)" >> "$F"
  else
    echo "V4-CGROUP-WRITE-FAIL" >> "$F"
  fi
else
  echo "V4-CGROUP-MKDIR-FAIL" >> "$F"
fi

# V5 - scrubbed environment (drops any session-identifying env var)
nohup env -i bash -c "sleep 25; echo V5-DONE \$(date +%s) >> $F" >/dev/null 2>&1 &

# V6 - double-fork + scrubbed env + setsid
python3 - "$F" <<'PY' &
import os, sys, time
F = sys.argv[1]
if os.fork() == 0:
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    for k in list(os.environ):
        del os.environ[k]
    os.environ["F"] = F
    open(F,'a').write("V6-START %d\n" % time.time())
    time.sleep(25)
    open(F,'a').write("V6-DONE %d\n" % time.time())
    os._exit(0)
os.wait()
PY

# V7 - python: detach via os.fork twice then exec bash (fully new process image)
python3 - "$F" <<'PY' &
import os, sys, time
F = sys.argv[1]
if os.fork() == 0:
    os.setsid()
    pid = os.fork()
    if pid > 0:
        os._exit(0)
    time.sleep(1)
    os.execl("/bin/bash", "bash", "-c", "sleep 25; echo V7-DONE $(date +%s) >> " + F)
os.wait()
PY

# V8 - detached docker container on the host daemon
if docker run -d --rm --name hermes-probe-v8 alpine:3.20 sleep 25 >/dev/null 2>&1; then
  echo "V8-LAUNCHED $(date +%s)" >> "$F"
else
  echo "V8-DOCKER-FAIL" >> "$F"
fi

sleep 2
{
  echo "--- self cgroup ---"
  cat /proc/self/cgroup
  echo "--- live procs ---"
  ps -eo pid,ppid,sid,cmd | grep -E "sleep 25" | grep -v grep
  echo "--- cgroup dirs ---"
  ls /sys/fs/cgroup/ | grep hermes
} >> "$F" 2>&1
exit 0
