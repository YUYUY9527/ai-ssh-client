'use strict';

/**
 * 服务器监控采集（目标机零安装）。
 *
 * 经独立 exec 通道跑一段 POSIX shell，读取 /proc、df、uname，输出 key=value 行，
 * 再由 parseMonitorOutput 解析成结构化指标。CPU（总体 + 各核）、磁盘 IO、各网卡
 * 上下行都用 0.5s 两次采样求差得到瞬时值。仅依赖 Linux 标准接口
 * （/proc、df、awk、uname、hostname、who），常见发行版均可用。
 */

// 注意：脚本里避免出现 JS 模板字符串的 ${}（本文件本身是模板字符串），
// 因此所有 shell 变量引用都用 $name / $(...) / $(( )) 形式。
// /proc/diskstats：统计整盘（不含分区/loop/dm/md）的累计读/写扇区（第 6、10 列）。
const MONITOR_SCRIPT = `
tmp1=/tmp/.ais_mon_$$_1
tmp2=/tmp/.ais_mon_$$_2
trap 'rm -f "$tmp1" "$tmp2"' 0
snap() {
  echo '##DISKSTAT'
  cat /proc/diskstats 2>/dev/null
  echo '##STAT'
  cat /proc/stat 2>/dev/null
  echo '##NETDEV'
  cat /proc/net/dev 2>/dev/null
}
snap > "$tmp1"
sleep 0.5
snap > "$tmp2"
awk '
FNR==1 { phase++; section="" }
/^##DISKSTAT$/ { section="disk"; next }
/^##STAT$/ { section="stat"; next }
/^##NETDEV$/ { section="net"; next }
section=="disk" {
  if ($3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+|hd[a-z]+)$/) {
    if (phase==1) { r1+=$6; w1+=$10 } else { r2+=$6; w2+=$10 }
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
    if (phase==1) { at=tot; ai=idle } else { dt=tot-at; di=idle-ai; cpu=(dt>0)?int(100*(dt-di)/dt):0 }
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
    network,
    processes: { running: procRunning, total: procTotal },
    loggedInUsers: toNumber(map.logged_users),
    hostname: String(map.hostname || ''),
    os: String(map.os || ''),
    kernel: String(map.kernel || ''),
    arch: String(map.arch || ''),
  };
}

module.exports = { buildMonitorCommand, parseMonitorOutput, MONITOR_SCRIPT };
