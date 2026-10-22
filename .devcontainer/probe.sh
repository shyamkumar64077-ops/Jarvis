#!/usr/bin/env bash
# PROBE 3 - find a launch mechanism that survives the devcontainer postStartCommand
# reaper.
#
# Facts so far:
#   * over `gh cs ssh`, plain-bg / nohup / setsid / double-fork all SURVIVE
#   * inside the devcontainer exec, even setsid + double-fork children DIE
#   * a detached `docker run -d` container SURVIVES
#   * the codespace user CAN mkdir in /sys/fs/cgroup and move a pid into it
#
# So the two live candidates are:
#   V3/V4 - escape the exec cgroup into a sibling cgroup
#   V5/V6 - a detached docker container (separate cgroup / process tree)
#
# Every variant writes a START line with its own cgroup/sid/ppid, then a
# heartbeat every 3s. A variant whose heartbeat stops tells us exactly when it
# was reaped; a variant with no START at all never launched.

F=/workspaces/Jarvis/PROBE3.txt
: > "$F"

mark() { echo "$1 $(date +%s)" >> "$F" 2>/dev/null; }

# heartbeat loop: writes "<tag>-BEAT <ts>" every 3s
hb() {
  local tag="$1" n=0
  while [ "$n" -lt 40 ]; do
    echo "$tag-BEAT $(date +%s) cgroup=$(cut -d: -f3 /proc/self/cgroup) sid=$(cut -d' ' -f4 /proc/self/stat) ppid=$PPID" >> "$F" 2>/dev/null
    n=$((n+1))
    sleep 3
  done
  echo "$tag-END $(date +%s)" >> "$F" 2>/dev/null
}

# --- V1: nohup + setsid (baseline, expected to die) ------------------------
(
  mark "V1-START"
  hb V1
) >/dev/null 2>&1 &
disown 2>/dev/null || true

# --- V2: double-fork python ------------------------------------------------
python3 - "$F" <<'PY' &
import os, sys, time
F = sys.argv[1]
if os.fork() == 0:
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    def mark(t):
        with open(F,'a') as f: f.write("%s %d\n" % (t, int(time.time())))
    mark("V2-START")
    for _ in range(40):
        with open('/proc/self/cgroup') as f: cg = f.read().strip().split(':')[-1]
        with open(F,'a') as f: f.write("V2-BEAT %d cgroup=%s sid=%d ppid=%d\n" % (int(time.time()), cg, os.getsid(0), os.getppid()))
        time.sleep(3)
    mark("V2-END")
    os._exit(0)
os.wait()
PY

# --- V3: double-fork + move into a fresh sibling cgroup --------------------
python3 - "$F" <<'PY' &
import os, sys, time
F = sys.argv[1]
if os.fork() == 0:
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    def mark(t):
        with open(F,'a') as f: f.write("%s %d\n" % (t, int(time.time())))
    try:
        os.makedirs("/sys/fs/cgroup/hermes-v3", exist_ok=True)
        with open("/sys/fs/cgroup/hermes-v3/cgroup.procs","w") as f:
            f.write(str(os.getpid()))
        mark("V3-START")
    except Exception as e:
        mark("V3-ERR %r" % (e,))
    for _ in range(40):
        with open('/proc/self/cgroup') as f: cg = f.read().strip().split(':')[-1]
        with open(F,'a') as f: f.write("V3-BEAT %d cgroup=%s sid=%d ppid=%d\n" % (int(time.time()), cg, os.getsid(0), os.getppid()))
        time.sleep(3)
    mark("V3-END")
    os._exit(0)
os.wait()
PY

# --- V4: plain background child, moved into a fresh cgroup -----------------
(
  mark "V4-START"
  hb V4
) >/dev/null 2>&1 &
V4PID=$!
if mkdir -p /sys/fs/cgroup/hermes-v4 2>/dev/null; then
  if echo "$V4PID" > /sys/fs/cgroup/hermes-v4/cgroup.procs 2>/dev/null; then
    mark "V4-MOVED"
  else
    mark "V4-MOVE-FAIL"
  fi
else
  mark "V4-MKDIR-FAIL"
fi

# --- V5: detached docker container, bind-mounted workspace ------------------
docker run -d --rm --name hermes-probe-v5 \
  -v /workspaces/Jarvis:/w alpine:3.20 \
  sh -c 'echo "V5-START $(date +%s)" >> /w/PROBE3-docker.txt; for i in $(seq 1 40); do echo "V5-BEAT $(date +%s) cgroup=$(cut -d: -f3 /proc/self/cgroup)" >> /w/PROBE3-docker.txt; sleep 3; done; echo "V5-END $(date +%s)" >> /w/PROBE3-docker.txt' \
  >/dev/null 2>&1 && mark "V5-LAUNCHED" || mark "V5-DOCKER-FAIL"

# --- V6: detached docker container that nsenters into the codespace --------
# ns (pid/mount/net), so it can talk to the real codespace filesystem and
# would be able to host the real services.  `sleep infinity` keeps the
# container (and therefore its cgroup) alive after the launcher exits.
docker rm -f hermes-probe-v6 >/dev/null 2>&1
docker run -d --name hermes-probe-v6 --pid host --network host --privileged \
  alpine:3.20 \
  sh -c 'nsenter -t 1 -m -u -i -n -p -- /bin/bash -c "echo V6-START \$(date +%s) >> /workspaces/Jarvis/PROBE3-docker.txt; for i in \$(seq 1 40); do echo V6-BEAT \$(date +%s) >> /workspaces/Jarvis/PROBE3-docker.txt; sleep 3; done; echo V6-END \$(date +%s) >> /workspaces/Jarvis/PROBE3-docker.txt"' \
  >/dev/null 2>&1 && mark "V6-LAUNCHED" || mark "V6-DOCKER-FAIL"

# --- V7: detached docker container that runs the REAL startup script --------
# Best case: the real thing comes up and we save a rebuild.
docker rm -f hermes-boot >/dev/null 2>&1
docker run -d --name hermes-boot --pid host --network host --privileged \
  alpine:3.20 \
  sh -c 'nsenter -t 1 -m -u -i -n -p -- /bin/bash -c "cd /workspaces/Jarvis && nohup bash .devcontainer/start-hermes.sh > /tmp/start-hermes.log 2>&1 & sleep 86400"' \
  >/dev/null 2>&1 && mark "V7-LAUNCHED" || mark "V7-DOCKER-FAIL"

sleep 3
{
  echo "--- launcher cgroup: $(cut -d: -f3 /proc/self/cgroup) sid=$(cut -d' ' -f4 /proc/self/stat) ---"
  echo "--- cgroup dirs ---"
  ls -d /sys/fs/cgroup/*/ 2>/dev/null
  echo "--- live probe procs ---"
  ps -eo pid,ppid,sid,cmd | grep -E 'PROBE3|hermes-probe|hermes-boot' | grep -v grep
} >> "$F" 2>&1
exit 0
