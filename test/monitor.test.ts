import { describe, it, expect } from 'vitest';
import { buildMonitorCommand, parseMonitorOutput } from '../server/monitor.cjs';

describe('monitor 采集命令与解析', () => {
  it('采集命令读取 /proc 与 df，且不含会被 JS 误插值的 ${}', () => {
    const command = buildMonitorCommand();
    expect(command).toContain('/proc/stat');
    expect(command).toContain('/proc/meminfo');
    expect(command).toContain('/proc/loadavg');
    expect(command).toContain('/proc/diskstats');
    expect(command).toContain('/proc/net/dev');
    expect(command).toContain('cpu_cores=');
    expect(command).toContain('disk_mount|');
    expect(command).toContain('df -Pk /');
    expect(command).not.toContain('${');
  });

  it('解析完整输出为结构化指标', () => {
    const output = [
      'cpu=12',
      'mem_total_kb=16384000',
      'mem_available_kb=8192000',
      'mem_used_kb=8192000',
      'mem_percent=50',
      'load1=0.52',
      'load5=0.48',
      'load15=0.40',
      'uptime_seconds=123456',
      'disk_total_kb=1000000',
      'disk_used_kb=420000',
      'disk_available_kb=580000',
      'disk_percent=42%',
      'disk_read_sectors=1000',
      'disk_write_sectors=2000',
      'disk_io_interval_ms=500',
      'hostname=k8s-slave1',
      'os=CentOS Linux 7',
    ].join('\n');

    const metrics = parseMonitorOutput(output);
    expect(metrics.cpuPercent).toBe(12);
    expect(metrics.memory.totalKb).toBe(16384000);
    expect(metrics.memory.percent).toBe(50);
    expect(metrics.load.load1).toBe(0.52);
    expect(metrics.load.load15).toBe(0.4);
    expect(metrics.uptimeSeconds).toBe(123456);
    expect(metrics.disk.percent).toBe(42);
    expect(metrics.disk.usedKb).toBe(420000);
    // 1000 扇区 * 512B / 0.5s = 1,024,000 B/s；2000 扇区 * 512B / 0.5s = 2,048,000 B/s
    expect(metrics.diskIo.readBytesPerSec).toBe(1024000);
    expect(metrics.diskIo.writeBytesPerSec).toBe(2048000);
    expect(metrics.hostname).toBe('k8s-slave1');
    expect(metrics.os).toBe('CentOS Linux 7');
  });

  it('解析各核 CPU、网卡、多挂载点磁盘、Swap、进程、内核等扩展字段', () => {
    const output = [
      'cpu=9',
      'cpu_cores=12,7,3',
      'core_count=3',
      'disk_read_sectors=0',
      'disk_write_sectors=0',
      'disk_io_interval_ms=500',
      'net_rate|eth0|1000|500',
      'net_rate|docker0|0|0',
      'disk_mount|/|100|40|60|40%',
      'disk_mount|/home|200|100|100|50%',
      'mem_total_kb=1600000',
      'mem_available_kb=1100000',
      'mem_used_kb=500000',
      'mem_percent=31',
      'mem_free_kb=100',
      'mem_buffers_kb=2000',
      'mem_cached_kb=300000',
      'swap_total_kb=1000000',
      'swap_free_kb=1000000',
      'swap_used_kb=0',
      'swap_percent=0',
      'proc_info=2/345',
      'kernel=3.10.0-1160',
      'arch=x86_64',
      'cpu_model=Intel(R) Xeon(R) CPU E5-2680 v4',
      'logged_users=2',
    ].join('\n');

    const metrics = parseMonitorOutput(output);
    expect(metrics.cpuCores).toEqual([12, 7, 3]);
    expect(metrics.coreCount).toBe(3);
    expect(metrics.cpuModel).toContain('Xeon');
    // 1000 B / 0.5s = 2000 B/s；500 B / 0.5s = 1000 B/s
    expect(metrics.network).toEqual([
      { name: 'eth0', rxBytesPerSec: 2000, txBytesPerSec: 1000 },
      { name: 'docker0', rxBytesPerSec: 0, txBytesPerSec: 0 },
    ]);
    expect(metrics.disks).toEqual([
      { mount: '/', totalKb: 100, usedKb: 40, availableKb: 60, percent: 40 },
      { mount: '/home', totalKb: 200, usedKb: 100, availableKb: 100, percent: 50 },
    ]);
    expect(metrics.memory.buffersKb).toBe(2000);
    expect(metrics.memory.cachedKb).toBe(300000);
    expect(metrics.memory.swapTotalKb).toBe(1000000);
    expect(metrics.memory.swapPercent).toBe(0);
    expect(metrics.processes).toEqual({ running: 2, total: 345 });
    expect(metrics.loggedInUsers).toBe(2);
    expect(metrics.kernel).toBe('3.10.0-1160');
    expect(metrics.arch).toBe('x86_64');
  });

  it('缺失字段给安全默认值，不抛错', () => {
    const metrics = parseMonitorOutput('cpu=7\n');
    expect(metrics.cpuPercent).toBe(7);
    expect(metrics.memory.totalKb).toBe(0);
    expect(metrics.disk.percent).toBe(0);
    expect(metrics.diskIo.readBytesPerSec).toBe(0);
    expect(metrics.diskIo.writeBytesPerSec).toBe(0);
    expect(metrics.hostname).toBe('');
    expect(metrics.cpuCores).toEqual([]);
    expect(metrics.network).toEqual([]);
    expect(metrics.disks).toEqual([]);
    expect(metrics.processes).toEqual({ running: 0, total: 0 });
  });

  it('空输出/非法值不产生 NaN', () => {
    const metrics = parseMonitorOutput('');
    expect(metrics.cpuPercent).toBe(0);
    expect(Number.isNaN(metrics.memory.percent)).toBe(false);
    const bad = parseMonitorOutput('cpu=abc\nmem_percent=NaN');
    expect(bad.cpuPercent).toBe(0);
    expect(bad.memory.percent).toBe(0);
  });
});