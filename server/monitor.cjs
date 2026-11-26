'use strict';

/**
 * 服务器监控采集（目标机零安装）。
 *
 * 经独立 exec 通道跑一段 POSIX shell，读取 /proc、/sys、df、uname，输出 key=value 行，
 * 再由 parseMonitorOutput 解析成结构化指标。CPU（总体 + 各核）、磁盘 IO、各网卡
 * 上下行都用 0.5s 两次采样求差得到瞬时值。仅依赖 Linux 标准接口
 * （/proc、/sys、df、awk、uname、hostname、who），常见发行版均可用。
 */

const { execCommand } = require('./ssh-exec.cjs');

// 跨平台监控采集脚本：自动识别 Darwin(macOS) / FreeBSD / Linux(含 BusyBox)。
// 注意：脚本里避免出现 JS 模板字符串的 ${}（本文件本身是模板字符串），
// 因此所有 shell 变量引用都用 $name / $(...) / $(( )) 形式。
const MONITOR_SCRIPT = `
OS_NAME=$(uname -s 2>/dev/null)
if [ "$OS_NAME" = "Darwin" ]; then
  CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo 1)
  echo "core_count=$CORES"
  CPU_IDLE=$(top -l 1 -n 0 2>/dev/null | awk '/CPU usage:/{gsub(/%/,"",$7); print int($7)}')
  if [ -n "$CPU_IDLE" ]; then echo "cpu=$((100 - CPU_IDLE))"; else echo "cpu=0"; fi
  echo "cpu_model=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)"
  MT_BYTES=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
  MT_KB=$((MT_BYTES / 1024))
  PSIZE=$(pagesize 2>/dev/null || echo 4096)
  FREE_P=$(vm_stat 2>/dev/null | awk '/Pages free:/{gsub(/\\./,"",$3); print $3}')
  INACT_P=$(vm_stat 2>/dev/null | awk '/Pages inactive:/{gsub(/\\./,"",$3); print $3}')
  if [ -z "$FREE_P" ]; then FREE_P=0; fi
  if [ -z "$INACT_P" ]; then INACT_P=0; fi
  MA_KB=$(( ( FREE_P + INACT_P ) * PSIZE / 1024 ))
  MU_KB=$((MT_KB - MA_KB)); if [ "$MU_KB" -lt 0 ]; then MU_KB=0; fi
  if [ "$MT_KB" -gt 0 ]; then MP=$((100 * MU_KB / MT_KB)); else MP=0; fi
  echo "mem_total_kb=$MT_KB"; echo "mem_available_kb=$MA_KB"; echo "mem_used_kb=$MU_KB"; echo "mem_free_kb=$MA_KB"; echo "mem_percent=$MP"
  LOAD=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')
  set -- $LOAD
  echo "load1=$1"; echo "load5=$2"; echo "load15=$3"
  BOOT=$(sysctl -n kern.boottime 2>/dev/null | awk '{gsub(/,/,"",$4); print $4}')
  NOW=$(date +%s 2>/dev/null || echo 0)
  if [ -n "$BOOT" ] && [ "$NOW" -gt "$BOOT" ]; then echo "uptime_seconds=$((NOW - BOOT))"; else echo "uptime_seconds=0"; fi
  ps -axo pid,pcpu,comm 2>/dev/null | awk 'NR>1{print $1"|"$3"|"$2}' | sort -t'|' -k3 -rn | head -n 10 | while IFS='|' read p n c; do echo "process_cpu|$p|$n|$c"; done
  df -Pk / 2>/dev/null | awk 'NR==2{printf "disk_total_kb=%s\\ndisk_used_kb=%s\\ndisk_available_kb=%s\\ndisk_percent=%s\\n",$2,$3,$4,$5}'
  df -Pk 2>/dev/null | awk 'NR>1 && ($1 ~ /^\\/dev\\// || $6=="/") { cnt++; if (cnt<=8) print "disk_mount|" $6 "|" $2 "|" $3 "|" $4 "|" $5 }'
  echo "hostname=$(hostname 2>/dev/null || uname -n)"
  echo "kernel=$(uname -r 2>/dev/null)"
  echo "arch=$(uname -m 2>/dev/null)"
  echo "logged_users=$(who 2>/dev/null | wc -l | tr -d ' ')"
  echo "os=macOS $(sw_vers -productVersion 2>/dev/null)"
  exit 0
fi
if [ "$OS_NAME" = "FreeBSD" ]; then
  CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo 1)
  echo "core_count=$CORES"
  echo "cpu_model=$(sysctl -n hw.model 2>/dev/null || uname -m)"
  MT_BYTES=$(sysctl -n hw.physmem 2>/dev/null || echo 0)
  MT_KB=$((MT_BYTES / 1024))
  echo "mem_total_kb=$MT_KB"; echo "mem_available_kb=0"; echo "mem_used_kb=0"; echo "mem_percent=0"
  LOAD=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')
  set -- $LOAD
  echo "load1=$1"; echo "load5=$2"; echo "load15=$3"
  ps -axo pid,pcpu,comm 2>/dev/null | awk 'NR>1{print $1"|"$3"|"$2}' | sort -t'|' -k3 -rn | head -n 10 | while IFS='|' read p n c; do echo "process_cpu|$p|$n|$c"; done
  df -Pk / 2>/dev/null | awk 'NR==2{printf "disk_total_kb=%s\\ndisk_used_kb=%s\\ndisk_available_kb=%s\\ndisk_percent=%s\\n",$2,$3,$4,$5}'
  echo "hostname=$(hostname 2>/dev/null || uname -n)"
  echo "kernel=$(uname -r 2>/dev/null)"
  echo "arch=$(uname -m 2>/dev/null)"
  echo "logged_users=$(who 2>/dev/null | wc -l | tr -d ' ')"
  echo "os=FreeBSD $(uname -r 2>/dev/null)"
  exit 0
fi
tmp1=/tmp/.ais_mon_$$_1
tmp2=/tmp/.ais_mon_$$_2
trap 'rm -f "$tmp1" "$tmp2"' 0
snap() {
  echo '##DISKSTAT'
  for disk in /sys/block/*; do
    [ -r "$disk/stat" ] || continue
    disk_name=$(basename "$disk")
    case "$disk_name" in loop*) continue ;; esac
    if [ -d "$disk/slaves" ] && [ -n "$(ls -A "$disk/slaves" 2>/dev/null)" ]; then continue; fi
    awk -v name="$disk_name" '{ print name "|" $3 "|" $7 }' "$disk/stat"
  done
  echo '##STAT'
  cat /proc/stat 2>/dev/null
  echo '##NETDEV'
  cat /proc/net/dev 2>/dev/null
  echo '##PROC'
  awk '{
    pid=$1; comm=$0; rest=$0
    sub(/^[^(]*\\(/, "", comm)
    sub(/\\) [^)]*$/, "", comm)
    sub(/^.*\\) /, "", rest)
    n=split(rest, fields, " ")
    if (n >= 13) {
      gsub(/[|[:cntrl:]]/, "_", comm)
      print pid "|" fields[12] "|" fields[13] "|" comm
    }
  }' /proc/[0-9]*/stat 2>/dev/null
}
snap > "$tmp1"
sleep 0.5
snap > "$tmp2"
awk '
FNR==1 { phase++; section="" }
/^##DISKSTAT$/ { section="disk"; next }
/^##STAT$/ { section="stat"; next }
/^##NETDEV$/ { section="net"; next }
/^##PROC$/ { section="proc"; next }
section=="disk" {
  split($0, fields, "|")
  if (fields[1] != "") {
    if (phase==1) { r1+=fields[2]; w1+=fields[3] } else { r2+=fields[2]; w2+=fields[3] }
  }
  next
}
section=="stat" {
  if ($1 ~ /^cpu[0-9]+$/) {
    tot=$2+$3+$4+$5+$6+$7+$8+$9; idle=$5+$6
    if (phase==1) { ct[$1]=tot; ci[$1]=idle; ord[++cn]=$1 }
    else { dt=tot-ct[$1]; di=idle-ci[$1]; cp[$1]=(dt>0)?int(100*(dt-di)/dt):0 }
  } else if ($1=="cpu") {
    tot=$2+$3+$4+$5+$6+$7+$8+$9; idle=$5+$6
    if (phase==1) { at=tot; ai=idle } else { dt=tot-at; all_dt=dt; di=idle-ai; cpu=(dt>0)?int(100*(dt-di)/dt):0 }
  }
  next
}
section=="net" {
  if ($0 ~ /:/) {
    gsub(/:/, " ", $0)
    iface=$1
    if (iface!="face" && iface ~ /^[A-Za-z0-9_.@-]+$/) {
      rx=$2; tx=$10
      if (phase==1) { nrx[iface]=rx; ntx[iface]=tx }
      else { drx=rx-nrx[iface]; dtx=tx-ntx[iface]; if(drx<0)drx=0; if(dtx<0)dtx=0; print "net_rate|" iface "|" drx "|" dtx }
    }
  }
  next
}
section=="proc" {
  split($0, fields, "|")
  if (fields[1] ~ /^[0-9]+$/) {
    pid=fields[1]
    ticks=fields[2]+fields[3]
    if (phase==1) { pt1[pid]=ticks }
    else if ((pid in pt1) && ticks >= pt1[pid]) { pd[pid]=ticks-pt1[pid]; pn[pid]=fields[4] }
  }
  next
}
END {
  print "cpu=" cpu
  s=""
  for (i=1;i<=cn;i++) { nm=ord[i]; sub(/^cpu/,"",nm); if (i>1) s=s","; s=s cp[ord[i]] }
  print "cpu_cores=" s
  print "core_count=" cn
  rd=r2-r1; if (rd<0) rd=0
  wd=w2-w1; if (wd<0) wd=0
  print "disk_read_sectors=" rd
  print "disk_write_sectors=" wd
  print "disk_io_interval_ms=500"
  if (all_dt > 0) {
    for (rank=1;rank<=10;rank++) {
      best=""; bestTicks=0
      for (pid in pd) {
        if (!(pid in picked) && pd[pid] > bestTicks) { best=pid; bestTicks=pd[pid] }
      }
      if (best == "") break
      picked[best]=1
      pct=100*bestTicks*cn/all_dt
      printf "process_cpu|%s|%s|%.1f\\n", best, pn[best], pct
    }
  }
}
' "$tmp1" "$tmp2"
mt=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
mf=$(awk '/^MemFree:/{print $2}' /proc/meminfo)
ma=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
mb=$(awk '/^Buffers:/{print $2}' /proc/meminfo)
mc=$(awk '/^Cached:/{print $2}' /proc/meminfo)
st=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
sf=$(awk '/^SwapFree:/{print $2}' /proc/meminfo)
mu=$((mt-ma)); if [ "$mu" -lt 0 ]; then mu=0; fi
if [ "$mt" -gt 0 ]; then mp=$((100*mu/mt)); else mp=0; fi
su=$((st-sf)); if [ "$su" -lt 0 ]; then su=0; fi
if [ "$st" -gt 0 ]; then sp=$((100*su/st)); else sp=0; fi
echo "mem_total_kb=$mt"; echo "mem_free_kb=$mf"; echo "mem_available_kb=$ma"; echo "mem_buffers_kb=$mb"; echo "mem_cached_kb=$mc"; echo "mem_used_kb=$mu"; echo "mem_percent=$mp"
echo "swap_total_kb=$st"; echo "swap_free_kb=$sf"; echo "swap_used_kb=$su"; echo "swap_percent=$sp"
set -- $(cat /proc/loadavg)
echo "load1=$1"; echo "load5=$2"; echo "load15=$3"; echo "proc_info=$4"
echo "uptime_seconds=$(cut -d. -f1 /proc/uptime)"
df -Pk / 2>/dev/null | awk 'NR==2{printf "disk_total_kb=%s\\ndisk_used_kb=%s\\ndisk_available_kb=%s\\ndisk_percent=%s\\n",$2,$3,$4,$5}'
df -Pk 2>/dev/null | awk 'NR>1 && ($1 ~ /^\\/dev\\// || $6=="/" || ($1=="overlay" && $6 !~ /overlay2/)) { cnt++; if (cnt<=8) print "disk_mount|" $6 "|" $2 "|" $3 "|" $4 "|" $5 }'
echo "hostname=$(hostname 2>/dev/null || uname -n)"
echo "kernel=$(uname -r 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
cm=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2-); if [ -z "$cm" ]; then cm=$(uname -m); fi
echo "cpu_model=$cm"
echo "logged_users=$(who 2>/dev/null | wc -l)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "os=$PRETTY_NAME"; else echo "os=$(uname -s)"; fi
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null | awk -F', ' '{gsub(/\|/,"",$2); print "gpu|"$1"|"$2"|"$3"|"$4"|"$5"|"$6"|"$7}'
fi
`.trim();

function buildMonitorCommand() {
  return MONITOR_SCRIPT;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(String(value ?? '').replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 把 key=value 行解析成结构化指标；缺失字段给安全默认值。 */
function parseMonitorOutput(text) {
  const map = {};
  const netLines = [];
  const diskMountLines = [];
  const processCpuLines = [];
  const gpuLines = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith('net_rate|')) {
      netLines.push(line);
      continue;
    }
    if (line.startsWith('disk_mount|')) {
      diskMountLines.push(line);
      continue;
    }
    if (line.startsWith('process_cpu|')) {
      processCpuLines.push(line);
      continue;
    }
    if (line.startsWith('gpu|')) {
      gpuLines.push(line);
      continue;
    }
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) map[key] = value;
  }

  const intervalMs = toNumber(map.disk_io_interval_ms, 500) || 500;
  const perSec = (bytes) => Math.round((Math.max(0, bytes) * 1000) / intervalMs);

  const readSectors = Math.max(0, toNumber(map.disk_read_sectors));
  const writeSectors = Math.max(0, toNumber(map.disk_write_sectors));
  const bytesPerSector = 512;

  const cpuCores = String(map.cpu_cores || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => toNumber(part));

  const network = netLines.map((line) => {
    const [, name, rx, tx] = line.split('|');
    return {
      name: String(name || ''),
      rxBytesPerSec: perSec(toNumber(rx)),
      txBytesPerSec: perSec(toNumber(tx)),
    };
  });

  const processCpu = processCpuLines.map((line) => {
    const [, pid, name, percent] = line.split('|');
    return { pid: toNumber(pid), name: String(name || ''), percent: toNumber(percent) };
  });

  const disks = diskMountLines.map((line) => {
    const [, mount, totalKb, usedKb, availableKb, percent] = line.split('|');
    return {
      mount: String(mount || ''),
      totalKb: toNumber(totalKb),
      usedKb: toNumber(usedKb),
      availableKb: toNumber(availableKb),
      percent: toNumber(percent),
    };
  });

  const gpus = gpuLines.map((line) => {
    const [, index, name, util, memUsedMb, memTotalMb, tempC, powerW] = line.split('|');
    const used = toNumber(memUsedMb);
    const total = toNumber(memTotalMb);
    return {
      index: toNumber(index),
      name: String(name || '').trim(),
      utilizationPercent: toNumber(util),
      memoryUsedMb: used,
      memoryTotalMb: total,
      memoryPercent: total > 0 ? Math.round((100 * used) / total) : 0,
      temperatureC: toNumber(tempC),
      powerW: toNumber(powerW),
    };
  });

  const swapTotalKb = toNumber(map.swap_total_kb);
  const swapFreeKb = toNumber(map.swap_free_kb);
  const swapUsedKb = Math.max(0, toNumber(map.swap_used_kb, swapTotalKb - swapFreeKb));

  const procInfo = String(map.proc_info || '').trim();
  const procParts = procInfo.split('/');
  const procRunning = toNumber(procParts[0]);
  const procTotal = toNumber(procParts[1]);

  return {
    cpuPercent: toNumber(map.cpu),
    cpuCores,
    coreCount: toNumber(map.core_count) || cpuCores.length,
    cpuModel: String(map.cpu_model || ''),
    memory: {
      totalKb: toNumber(map.mem_total_kb),
      availableKb: toNumber(map.mem_available_kb),
      usedKb: toNumber(map.mem_used_kb),
      freeKb: toNumber(map.mem_free_kb),
      buffersKb: toNumber(map.mem_buffers_kb),
      cachedKb: toNumber(map.mem_cached_kb),
      percent: toNumber(map.mem_percent),
      swapTotalKb,
      swapFreeKb,
      swapUsedKb,
      swapPercent: toNumber(map.swap_percent, swapTotalKb > 0 ? Math.round((100 * swapUsedKb) / swapTotalKb) : 0),
    },
    load: {
      load1: toNumber(map.load1),
      load5: toNumber(map.load5),
      load15: toNumber(map.load15),
    },
    uptimeSeconds: toNumber(map.uptime_seconds),
    disk: {
      totalKb: toNumber(map.disk_total_kb),
      usedKb: toNumber(map.disk_used_kb),
      availableKb: toNumber(map.disk_available_kb),
      percent: toNumber(map.disk_percent),
    },
    disks,
    diskIo: {
      readBytesPerSec: perSec(readSectors * bytesPerSector),
      writeBytesPerSec: perSec(writeSectors * bytesPerSector),
    },
    processCpu,
    network,
    gpus,
    processes: { running: procRunning, total: procTotal },
    loggedInUsers: toNumber(map.logged_users),
    hostname: String(map.hostname || ''),
    os: String(map.os || ''),
    kernel: String(map.kernel || ''),
    arch: String(map.arch || ''),
  };
}

function quoteArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

/** 采集远端监听端口（兼容 ss / netstat / lsof）。 */
async function listListeningPorts(client) {
  const script = `
if command -v ss >/dev/null 2>&1; then
  ss -tulnp 2>/dev/null | awk 'NR>1{print $1"|"$2"|"$5"|"$7}'
elif command -v netstat >/dev/null 2>&1; then
  netstat -tulnp 2>/dev/null | awk 'NR>2{print $1"|"$6"|"$4"|"$7}'
elif command -v lsof >/dev/null 2>&1; then
  lsof -i -P -n 2>/dev/null | awk '/LISTEN/{print $8"|LISTEN|"$9"|"$1"/"$2}'
fi
`.trim();
  const result = await execCommand(client, script, { timeoutMs: 12000, maxBytes: 512 * 1024 });
  const ports = [];
  for (const line of String(result.output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('|')) continue;
    const [protocol = '', state = '', address = '', processInfo = ''] = trimmed.split('|');
    if (!address) continue;
    ports.push({
      protocol: protocol.trim(),
      state: state.trim(),
      address: address.trim(),
      process: processInfo.trim(),
    });
  }
  return { ports };
}

/** 结束远端进程（仅允许 pid > 1 且信号为 TERM/KILL/HUP）。 */
async function killRemoteProcess(client, pid, signal = 'TERM') {
  const numPid = Number(pid);
  if (!Number.isInteger(numPid) || numPid <= 1) {
    throw new Error('Invalid PID (must be integer > 1)');
  }
  const sig = String(signal || 'TERM').toUpperCase();
  if (!['TERM', 'KILL', 'HUP'].includes(sig)) {
    throw new Error(`Unsupported signal: ${sig}`);
  }
  const result = await execCommand(client, `kill -${sig} ${numPid}`, { timeoutMs: 10000 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || `kill -${sig} ${numPid} failed`).trim());
  }
  return { pid: numPid, signal: sig };
}

/** 列出 systemd 服务单元（附带开机自启状态）。 */
async function listSystemdServices(client) {
  const cmd = [
    'if ! command -v systemctl >/dev/null 2>&1; then echo "__NO_SYSTEMD__"; exit 0; fi',
    'systemctl list-unit-files --type=service --no-pager --no-legend --plain 2>/dev/null | awk \'{print "__UF__|" $1 "|" $2}\'',
    'systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null | head -n 200',
  ].join('\n');
  const result = await execCommand(client, cmd, { timeoutMs: 15000, maxBytes: 1024 * 1024 });
  const out = String(result.output || '');
  if (out.includes('__NO_SYSTEMD__')) {
    return { available: false, services: [] };
  }
  const enabledMap = new Map();
  const services = [];
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('__UF__|')) {
      const [, unitName, state] = line.split('|');
      if (unitName) enabledMap.set(unitName.trim(), String(state || '').trim());
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const [unit, load, active, sub, ...descParts] = parts;
    services.push({
      name: unit,
      load,
      active,
      sub,
      enabledState: enabledMap.get(unit) || '',
      description: descParts.join(' '),
    });
  }
  return { available: true, services };
}

const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable']);

/** 控制 systemd 服务（启停/重启/重载/开机自启）。 */
async function controlSystemdService(client, serviceName, action) {
  const name = String(serviceName || '').trim();
  if (!name || !/^[A-Za-z0-9@_.:-]+$/.test(name)) {
    throw new Error('Invalid systemd service name');
  }
  if (!SERVICE_ACTIONS.has(action)) {
    throw new Error(`Unsupported service action: ${action}`);
  }
  let result = await execCommand(client, `systemctl ${action} -- ${quoteArg(name)}`, { timeoutMs: 20000 });
  if (result.exitCode !== 0 && /interactive authentication|permission denied|access denied/i.test(String(result.stderr || ''))) {
    const sudoRes = await execCommand(client, `sudo -n systemctl ${action} -- ${quoteArg(name)}`, { timeoutMs: 20000 });
    if (sudoRes.exitCode === 0) result = sudoRes;
  }
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || `systemctl ${action} ${name} failed`).trim());
  }
  return { name, action };
}

/** 读取指定 systemd 服务的 journalctl 日志。 */
async function getSystemdServiceLogs(client, serviceName, lines = 200) {
  const name = String(serviceName || '').trim();
  if (!name || !/^[A-Za-z0-9@_.:-]+$/.test(name)) {
    throw new Error('Invalid systemd service name');
  }
  const safeLines = Number.isInteger(Number(lines)) && Number(lines) > 0 ? Math.min(Number(lines), 2000) : 200;
  let result = await execCommand(
    client,
    `journalctl -u ${quoteArg(name)} -n ${safeLines} --no-pager -o short-iso 2>&1`,
    { timeoutMs: 15000, maxBytes: 1024 * 1024 },
  );
  if (
    result.exitCode !== 0
    || /No journal files were found|not seeing messages|permission denied/i.test(String(result.output || result.stderr || ''))
  ) {
    const sudoRes = await execCommand(
      client,
      `sudo -n journalctl -u ${quoteArg(name)} -n ${safeLines} --no-pager -o short-iso 2>&1`,
      { timeoutMs: 15000, maxBytes: 1024 * 1024 },
    );
    if (sudoRes.exitCode === 0 && sudoRes.output) result = sudoRes;
  }
  return {
    name,
    logs: String(result.output || result.stderr || '').trim(),
  };
}

/** 读取当前用户的 Crontab 内容。 */
async function getCrontab(client) {
  const check = await execCommand(client, 'command -v crontab >/dev/null 2>&1 && echo __OK__ || echo __NO__', { timeoutMs: 8000 });
  if (!String(check.output || '').includes('__OK__')) {
    return { available: false, raw: '', entries: [] };
  }
  const result = await execCommand(client, 'crontab -l 2>&1', { timeoutMs: 10000, maxBytes: 512 * 1024 });
  const text = String(result.output || '');
  if (result.exitCode !== 0 && /no crontab for/i.test(text)) {
    return { available: true, raw: '', entries: [] };
  }
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || text || 'crontab -l failed').trim());
  }
  const entries = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue;
    if (line.startsWith('@')) {
      const m = line.match(/^(@\S+)\s+(.+)$/);
      if (m) entries.push({ schedule: m[1], command: m[2] });
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length >= 6) {
      entries.push({
        schedule: parts.slice(0, 5).join(' '),
        command: parts.slice(5).join(' '),
      });
    }
  }
  return { available: true, raw: text, entries };
}

/** 保存当前用户的 Crontab 内容（保留注释与环境变量）。 */
async function saveCrontab(client, rawContent) {
  const normalized = String(rawContent ?? '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) {
    const res = await execCommand(client, 'crontab -r 2>&1 || true', { timeoutMs: 10000 });
    return { saved: true, cleared: true, output: String(res.output || '').trim() };
  }
  const withNewline = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  const b64 = Buffer.from(withNewline, 'utf8').toString('base64');
  const res = await execCommand(
    client,
    `printf '%s' '${b64}' | base64 -d | crontab -`,
    { timeoutMs: 12000 },
  );
  if (res.exitCode !== 0) {
    throw new Error(String(res.stderr || res.output || 'Failed to save crontab').trim());
  }
  return { saved: true, cleared: false, output: String(res.output || '').trim() };
}

/** 探测远端防火墙状态与规则（自动识别 ufw / firewalld，带 sudo -n 降级）。 */
async function getFirewallStatus(client) {
  const script = `
if command -v ufw >/dev/null 2>&1; then
  echo "__FW_BACKEND__=ufw"
  OUT=$(ufw status numbered 2>&1)
  if echo "$OUT" | grep -qiE "need to be root|permission denied"; then
    OUT=$(sudo -n ufw status numbered 2>&1)
  fi
  printf '%s\\n' "$OUT"
elif command -v firewall-cmd >/dev/null 2>&1; then
  echo "__FW_BACKEND__=firewalld"
  ST=$(firewall-cmd --state 2>&1)
  if echo "$ST" | grep -qiE "authorization|permission|not authorized"; then
    ST=$(sudo -n firewall-cmd --state 2>&1)
    LIST=$(sudo -n firewall-cmd --list-all 2>&1)
  else
    LIST=$(firewall-cmd --list-all 2>&1)
  fi
  echo "__FW_STATE__=$ST"
  printf '%s\\n' "$LIST"
else
  echo "__FW_BACKEND__=none"
fi
`.trim();
  const result = await execCommand(client, script, { timeoutMs: 15000, maxBytes: 512 * 1024 });
  const lines = String(result.output || '').split('\n').map((l) => l.replace(/\r$/, ''));
  const backendLine = lines.find((l) => l.startsWith('__FW_BACKEND__='));
  const backend = backendLine ? backendLine.split('=')[1].trim() : 'none';
  if (backend === 'none') {
    return { backend: 'none', active: false, rules: [], raw: '' };
  }
  const bodyLines = lines.filter((l) => !l.startsWith('__FW_BACKEND__=') && !l.startsWith('__FW_STATE__='));
  const raw = bodyLines.join('\n').trim();
  const rules = [];
  let active = false;

  if (backend === 'ufw') {
    active = /Status:\s*active/i.test(raw);
    for (const line of bodyLines) {
      const m = line.match(/^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT|FWD))?\s+(.*)$/i);
      if (m) {
        rules.push({
          id: m[1],
          target: m[2].trim(),
          action: m[3].toUpperCase(),
          direction: (m[4] || 'IN').toUpperCase(),
          from: m[5].trim() || 'Anywhere',
        });
      }
    }
  } else if (backend === 'firewalld') {
    const stateLine = lines.find((l) => l.startsWith('__FW_STATE__='));
    active = /running/i.test(stateLine || '');
    for (const line of bodyLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('ports:')) {
        const items = trimmed.slice(6).trim().split(/\s+/).filter(Boolean);
        for (const item of items) {
          rules.push({ id: `port:${item}`, target: item, action: 'ALLOW', direction: 'IN', from: 'zone' });
        }
      } else if (trimmed.startsWith('services:')) {
        const items = trimmed.slice(9).trim().split(/\s+/).filter(Boolean);
        for (const item of items) {
          rules.push({ id: `service:${item}`, target: `service:${item}`, action: 'ALLOW', direction: 'IN', from: 'zone' });
        }
      }
    }
  }
  return { backend, active, rules, raw };
}

/** 管理防火墙端口规则（ufw / firewalld，支持 allow / deny / delete）。 */
async function manageFirewallRule(client, options = {}) {
  const backend = String(options.backend || '').trim().toLowerCase();
  const action = String(options.action || '').trim().toLowerCase();
  const port = String(options.port || '').trim();
  const protocol = String(options.protocol || 'tcp').trim().toLowerCase();
  const ruleId = String(options.ruleId || '').trim();

  if (!['ufw', 'firewalld'].includes(backend)) {
    throw new Error('Unsupported firewall backend');
  }
  if (!['allow', 'deny', 'delete'].includes(action)) {
    throw new Error('Unsupported firewall action');
  }
  if (!['tcp', 'udp', 'any'].includes(protocol)) {
    throw new Error('Unsupported protocol');
  }

  let cmd = '';
  if (backend === 'ufw') {
    if (action === 'delete') {
      if (!/^\d+$/.test(ruleId)) throw new Error('Invalid UFW rule number');
      cmd = `yes | ufw delete ${ruleId}`;
    } else {
      if (!/^[0-9]{1,5}(:[0-9]{1,5})?$/.test(port)) throw new Error('Invalid port specification');
      const spec = protocol === 'any' ? port : `${port}/${protocol}`;
      cmd = `ufw ${action} ${spec}`;
    }
  } else {
    if (action === 'delete') {
      if (ruleId.startsWith('port:')) {
        const portSpec = ruleId.slice(5);
        if (!/^[0-9]{1,5}(-[0-9]{1,5})?\/(tcp|udp)$/.test(portSpec)) throw new Error('Invalid firewalld port rule');
        cmd = `firewall-cmd --permanent --remove-port=${portSpec} && firewall-cmd --reload`;
      } else if (ruleId.startsWith('service:')) {
        const svc = ruleId.slice(8);
        if (!/^[A-Za-z0-9_.-]+$/.test(svc)) throw new Error('Invalid firewalld service rule');
        cmd = `firewall-cmd --permanent --remove-service=${svc} && firewall-cmd --reload`;
      } else {
        throw new Error('Unsupported firewalld rule id');
      }
    } else {
      if (!/^[0-9]{1,5}(-[0-9]{1,5})?$/.test(port)) throw new Error('Invalid port specification');
      const proto = protocol === 'any' ? 'tcp' : protocol;
      if (action === 'allow') {
        cmd = `firewall-cmd --permanent --add-port=${port}/${proto} && firewall-cmd --reload`;
      } else {
        cmd = `firewall-cmd --permanent --remove-port=${port}/${proto} && firewall-cmd --reload`;
      }
    }
  }

  let res = await execCommand(client, cmd, { timeoutMs: 20000 });
  if (res.exitCode !== 0 && /need to be root|permission denied|authorization|not authorized/i.test(String(res.stderr || res.output || ''))) {
    const sudoCmd = cmd.includes('yes |')
      ? cmd.replace('yes | ufw', 'yes | sudo -n ufw')
      : cmd.split(' && ').map((part) => `sudo -n ${part}`).join(' && ');
    const sudoRes = await execCommand(client, sudoCmd, { timeoutMs: 20000 });
    if (sudoRes.exitCode === 0) res = sudoRes;
  }
  if (res.exitCode !== 0) {
    throw new Error(String(res.stderr || res.output || 'Firewall command failed').trim());
  }
  return { backend, action, output: String(res.output || '').trim() };
}

module.exports = {
  buildMonitorCommand,
  parseMonitorOutput,
  MONITOR_SCRIPT,
  listListeningPorts,
  killRemoteProcess,
  listSystemdServices,
  controlSystemdService,
  getSystemdServiceLogs,
  getCrontab,
  saveCrontab,
  getFirewallStatus,
  manageFirewallRule,
};
