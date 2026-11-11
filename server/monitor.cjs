'use strict';

/**
 * 服务器监控采集（目标机零安装）。
 *
 * 经独立 exec 通道跑一段 POSIX shell，读取 /proc 与 df，输出 key=value 行，
 * 再由 parseMonitorOutput 解析成结构化指标。CPU 用 0.5s 两次 /proc/stat 采样算瞬时占用。
 * 仅依赖 Linux 标准接口（/proc、df、awk、hostname），常见发行版均可用。
 */

// 注意：脚本里避免出现 JS 模板字符串的 ${}（uptime 用 cut 取整），以免被误插值。
// /proc/diskstats：统计整盘（不含分区/loop/dm/md）的累计读/写扇区（第 6、10 列），
// 两次采样求差得到区间吞吐。用扇区数输出，换算与除零交给 JS，避免 shell 64 位溢出。
const DISKSTAT_AWK = "$3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+|hd[a-z]+)$/ {r+=$6; w+=$10} END {print r+0, w+0}";

const MONITOR_SCRIPT = `
ds1=$(awk '${DISKSTAT_AWK}' /proc/diskstats 2>/dev/null || echo "0 0")
set -- $(head -n 1 /proc/stat)
u1=$2; n1=$3; s1=$4; i1=$5; w1=$6; q1=$7; t1=$8
sleep 0.5
ds2=$(awk '${DISKSTAT_AWK}' /proc/diskstats 2>/dev/null || echo "0 0")
set -- $(head -n 1 /proc/stat)
u2=$2; n2=$3; s2=$4; i2=$5; w2=$6; q2=$7; t2=$8
total1=$((u1+n1+s1+i1+w1+q1+t1)); total2=$((u2+n2+s2+i2+w2+q2+t2))
idle1=$((i1+w1)); idle2=$((i2+w2))
dt=$((total2-total1)); di=$((idle2-idle1))
if [ "$dt" -gt 0 ]; then cpu=$((100*(dt-di)/dt)); else cpu=0; fi
echo "cpu=$cpu"
set -- $ds1; dsr1=$1; dsw1=$2
set -- $ds2; dsr2=$1; dsw2=$2
drd=$((dsr2-dsr1)); dwd=$((dsw2-dsw1))
if [ "$drd" -lt 0 ]; then drd=0; fi
if [ "$dwd" -lt 0 ]; then dwd=0; fi
echo "disk_read_sectors=$drd"; echo "disk_write_sectors=$dwd"; echo "disk_io_interval_ms=500"
mt=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
ma=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
mu=$((mt-ma)); if [ "$mt" -gt 0 ]; then mp=$((100*mu/mt)); else mp=0; fi
echo "mem_total_kb=$mt"; echo "mem_available_kb=$ma"; echo "mem_used_kb=$mu"; echo "mem_percent=$mp"
set -- $(cat /proc/loadavg)
echo "load1=$1"; echo "load5=$2"; echo "load15=$3"
echo "uptime_seconds=$(cut -d. -f1 /proc/uptime)"
df -Pk / 2>/dev/null | awk 'NR==2{printf "disk_total_kb=%s\\ndisk_used_kb=%s\\ndisk_available_kb=%s\\ndisk_percent=%s\\n",$2,$3,$4,$5}'
echo "hostname=$(hostname 2>/dev/null || uname -n)"
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
  for (const line of String(text || '').split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) map[key] = value;
  }

  return {
    cpuPercent: toNumber(map.cpu),
    memory: {
      totalKb: toNumber(map.mem_total_kb),
      availableKb: toNumber(map.mem_available_kb),
      usedKb: toNumber(map.mem_used_kb),
      percent: toNumber(map.mem_percent),
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
    diskIo: (() => {
      const intervalMs = toNumber(map.disk_io_interval_ms, 500) || 500;
      const readSectors = Math.max(0, toNumber(map.disk_read_sectors));
      const writeSectors = Math.max(0, toNumber(map.disk_write_sectors));
      const bytesPerSector = 512;
      return {
        readBytesPerSec: Math.round((readSectors * bytesPerSector * 1000) / intervalMs),
        writeBytesPerSec: Math.round((writeSectors * bytesPerSector * 1000) / intervalMs),
      };
    })(),
    hostname: String(map.hostname || ''),
    os: String(map.os || ''),
  };
}

module.exports = { buildMonitorCommand, parseMonitorOutput, MONITOR_SCRIPT };