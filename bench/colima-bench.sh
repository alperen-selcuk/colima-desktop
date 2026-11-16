#!/usr/bin/env bash
# Colima benchmark: cold start, container run latency, idle cost, RAM return
# after load, stop time and bind-mount read throughput.
#
# It uses its own profile (default "bench") and never touches other profiles
# or the active docker/kube context. The method mirrors Kiri's published test
# (`docker run --rm alpine true`, cached image, 2 CPUs / 8 GB) so the numbers
# are comparable.
#
#   bench/colima-bench.sh                 # full run, results in bench/results/
#   PROFILE=bench RUNS=20 COLD_RUNS=3 bench/colima-bench.sh
#   DELETE=1 bench/colima-bench.sh        # delete the bench profile at the end
set -euo pipefail

PROFILE=${PROFILE:-bench}
CPUS=${CPUS:-2}
MEMORY=${MEMORY:-8}
RUNS=${RUNS:-20}
COLD_RUNS=${COLD_RUNS:-3}
IDLE_WAIT=${IDLE_WAIT:-30}
RECLAIM_WATCH=${RECLAIM_WATCH:-120}
LOAD_MB=${LOAD_MB:-4096}
MOUNT_MB=${MOUNT_MB:-1024}
DELETE=${DELETE:-0}

[[ $PROFILE =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || { echo "bad PROFILE" >&2; exit 2; }
[[ $PROFILE != default ]] || { echo "refusing to benchmark the default profile" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
stamp=$(date +%Y%m%d-%H%M%S)
out_dir="$here/results"
mkdir -p "$out_dir"
report="$out_dir/$stamp.md"
raw="$out_dir/$stamp.tsv"
unset DOCKER_HOST DOCKER_CONTEXT

now_ms() { perl -MTime::HiRes=time -e 'printf "%.0f\n", time*1000'; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
record() { printf '%s\t%s\n' "$1" "$2" >>"$raw"; }

# median / p95 / min / max of numbers on stdin
stats() { sort -n | awk '{a[NR]=$1} END {
  if (NR == 0) { print "n/a"; exit }
  m = (NR % 2) ? a[(NR+1)/2] : (a[NR/2] + a[NR/2+1]) / 2
  p = a[int(NR*0.95 + 0.999)]; if (p == "") p = a[NR]
  printf "median %.0f · p95 %.0f · min %.0f · max %.0f (n=%d)", m, p, a[1], a[NR], NR }'; }

os=$(uname -s)
start_flags=(--cpu "$CPUS" --memory "$MEMORY")
if [[ $os == Darwin ]]; then
  start_flags+=(--vm-type vz --mount-type virtiofs)
fi
# colima switches the docker context on start unless told not to.
if colima start --help 2>&1 | grep -q -- '--activate'; then
  start_flags+=(--activate=false)
fi

# --- host-side VM process discovery -----------------------------------------
# macOS vz: each VM is a com.apple.Virtualization.VirtualMachine XPC process;
# Linux/qemu: a qemu-system-* process. The bench VM's pid is the one that
# appears after `colima start` and was not there before.
vm_pids() {
  if [[ $os == Darwin ]]; then
    pgrep -f com.apple.Virtualization.VirtualMachine || true
  else
    pgrep -f "qemu-system.*$PROFILE" || true
  fi
}

VM_PID=""
find_vm_pid() {
  local before=$1 p
  for p in $(vm_pids); do
    grep -qx "$p" <<<"$before" || { VM_PID=$p; return 0; }
  done
  VM_PID=""
}

# Resident memory of the VM process in MB (top MEM = phys_footprint on macOS)
# and CPU % over a 1 s sample.
vm_mem_mb() {
  [[ -n $VM_PID ]] || { echo 0; return; }
  if [[ $os == Darwin ]]; then
    top -l 1 -pid "$VM_PID" -stats mem 2>/dev/null | tail -1 | awk '
      /G/ { sub(/[G+-]+$/, ""); printf "%.0f\n", $1*1024; next }
      /M/ { sub(/[M+-]+$/, ""); printf "%.0f\n", $1; next }
      /K/ { sub(/[K+-]+$/, ""); printf "%.0f\n", $1/1024; next }
      { print 0 }'
  else
    ps -o rss= -p "$VM_PID" | awk '{printf "%.0f\n", $1/1024}'
  fi
}
vm_cpu_pct() {
  [[ -n $VM_PID ]] || { echo 0; return; }
  if [[ $os == Darwin ]]; then
    top -l 2 -s 1 -pid "$VM_PID" -stats cpu 2>/dev/null | tail -1 | awk '{print $1+0}'
  else
    ps -o %cpu= -p "$VM_PID" | awk '{print $1+0}'
  fi
}

docker_sock() { colima status -p "$PROFILE" --json 2>/dev/null | perl -ne 'print $1 if /"docker_socket"\s*:\s*"([^"]+)"/'; }
d() { docker -H "$SOCK" "$@"; }

wait_docker() {
  local t0=$1
  until d info >/dev/null 2>&1; do sleep 0.05; done
  echo $(( $(now_ms) - t0 ))
}

# --- 0. prepare --------------------------------------------------------------
log "colima $(colima version 2>/dev/null | awk 'NR==1{print $3}') · profile $PROFILE · ${CPUS} CPU / ${MEMORY} GB"
if colima status -p "$PROFILE" >/dev/null 2>&1; then
  log "stopping existing $PROFILE profile first"
  colima stop -p "$PROFILE" >/dev/null 2>&1
fi
log "first start (creates the VM if needed; not counted as cold start)"
colima start -p "$PROFILE" "${start_flags[@]}" >/dev/null 2>&1
SOCK="unix://$(docker_sock)"
d pull -q alpine >/dev/null
colima stop -p "$PROFILE" >/dev/null 2>&1

# --- 1. cold start (stopped VM -> docker answers) ----------------------------
cold=() ; ready=() ; stops=()
for i in $(seq "$COLD_RUNS"); do
  before=$(vm_pids)
  t0=$(now_ms)
  colima start -p "$PROFILE" "${start_flags[@]}" >/dev/null 2>&1
  t1=$(now_ms)
  r=$(wait_docker "$t0")
  cold+=($(( t1 - t0 ))); ready+=("$r")
  record cold_start_ms $(( t1 - t0 )); record docker_ready_ms "$r"
  log "cold start $i: colima start $(( t1 - t0 )) ms, docker ready $r ms"
  if (( i < COLD_RUNS )); then
    t0=$(now_ms); colima stop -p "$PROFILE" >/dev/null 2>&1; s=$(( $(now_ms) - t0 ))
    stops+=("$s"); record stop_ms "$s"
  fi
done
find_vm_pid "$before"
[[ -n $VM_PID ]] || log "warning: could not identify the VM process; memory/CPU columns will read 0"

# --- 2. container run latency (cached image) ---------------------------------
d run --rm alpine true >/dev/null   # warm-up, not counted
runs=()
for i in $(seq "$RUNS"); do
  t0=$(now_ms); d run --rm alpine true; ms=$(( $(now_ms) - t0 ))
  runs+=("$ms"); record run_ms "$ms"
done
log "docker run --rm alpine true: $(printf '%s\n' "${runs[@]}" | stats) ms"

# --- 3. idle cost --------------------------------------------------------------
log "idle ${IDLE_WAIT}s"
sleep "$IDLE_WAIT"
idle_mem=$(vm_mem_mb); idle_cpu=$(vm_cpu_pct)
record idle_mem_mb "$idle_mem"; record idle_cpu_pct "$idle_cpu"
log "idle: VM ${idle_mem} MB, CPU ${idle_cpu}%"

# --- 4. RAM return after load --------------------------------------------------
# Fill a tmpfs inside a container, then exit: the guest frees the pages, the
# question is whether the host gets them back.
log "load: ${LOAD_MB} MB in a tmpfs"
d run --rm --tmpfs "/m:size=$(( LOAD_MB + 256 ))m" alpine \
  dd if=/dev/zero of=/m/fill bs=1M count="$LOAD_MB" >/dev/null 2>&1
peak_mem=$(vm_mem_mb); record peak_mem_mb "$peak_mem"
log "after load: VM ${peak_mem} MB"
reclaim_series=""
for (( t = 10; t <= RECLAIM_WATCH; t += 10 )); do
  sleep 10
  m=$(vm_mem_mb); reclaim_series+="${t}s=${m} "
  record "reclaim_${t}s_mb" "$m"
done
log "reclaim: $reclaim_series"

# --- 5. bind-mount read throughput -------------------------------------------
# colima mounts $HOME by default, so the test file lives under it.
mdir="$HOME/.cache/colima-bench"; mkdir -p "$mdir"
dd if=/dev/urandom of="$mdir/blob" bs=1048576 count="$MOUNT_MB" 2>/dev/null
mounts=()
for i in 1 2 3; do
  t0=$(now_ms)
  d run --rm -v "$mdir:/data:ro" alpine dd if=/data/blob of=/dev/null bs=1M 2>/dev/null
  ms=$(( $(now_ms) - t0 ))
  mbps=$(( MOUNT_MB * 1000 / (ms > 0 ? ms : 1) ))
  mounts+=("$mbps"); record mount_read_mbps "$mbps"
done
rm -rf "$mdir"
log "bind-mount read (incl. container start): $(printf '%s\n' "${mounts[@]}" | stats) MB/s"

# --- 6. stop -------------------------------------------------------------------
t0=$(now_ms); colima stop -p "$PROFILE" >/dev/null 2>&1; s=$(( $(now_ms) - t0 ))
stops+=("$s"); record stop_ms "$s"
gone="yes"; [[ -n $VM_PID ]] && kill -0 "$VM_PID" 2>/dev/null && gone="no"
record vm_process_gone_after_stop "$gone"
log "stop: $s ms, VM process gone: $gone"

if [[ $DELETE == 1 ]]; then colima delete -p "$PROFILE" -f >/dev/null 2>&1; fi

# --- report ----------------------------------------------------------------------
{
  echo "# Colima benchmark · $stamp"
  echo
  echo "- Host: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m), $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 )) GB, $(sw_vers -productVersion 2>/dev/null || uname -r)"
  echo "- $(colima version 2>/dev/null | head -1) · profile \`$PROFILE\` · ${CPUS} CPU / ${MEMORY} GB · flags: ${start_flags[*]}"
  echo
  echo "| Metric | Result |"
  echo "|---|---|"
  echo "| Cold start (\`colima start\` returns) | $(printf '%s\n' "${cold[@]}" | stats) ms |"
  echo "| Cold start → docker answers | $(printf '%s\n' "${ready[@]}" | stats) ms |"
  echo "| \`docker run --rm alpine true\` | $(printf '%s\n' "${runs[@]}" | stats) ms |"
  echo "| Idle VM memory (after ${IDLE_WAIT}s) | ${idle_mem} MB |"
  echo "| Idle VM CPU | ${idle_cpu}% |"
  echo "| VM memory right after ${LOAD_MB} MB load | ${peak_mem} MB |"
  echo "| VM memory while idle after load | ${reclaim_series} |"
  echo "| Bind-mount read, ${MOUNT_MB} MB (virtiofs, incl. container start) | $(printf '%s\n' "${mounts[@]}" | stats) MB/s |"
  echo "| \`colima stop\` | $(printf '%s\n' "${stops[@]}" | stats) ms |"
  echo "| VM process gone after stop | ${gone} |"
  echo
  echo "Raw samples: \`$(basename "$raw")\`"
} >"$report"
log "report: $report"
cat "$report"
