import { describe, it, expect } from 'vitest';
import { buildMonitorCommand, parseMonitorOutput } from '../server/monitor.cjs';

describe('monitor 采集命令与解析', () => {
  it('采集命令读取 /proc 与 df，且不含会被 JS 误插值的 ${}', () => {
    const command = buildMonitorCommand();
    expect(command).toContain('/proc/stat');
    expect(command).toContain('/proc/meminfo');
    expect(command).toContain('/proc/loadavg');
    expect(command).toContain('/proc/diskstats');
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

  it('缺失字段给安全默认值，不抛错', () => {
    const metrics = parseMonitorOutput('cpu=7\n');
    expect(metrics.cpuPercent).toBe(7);
    expect(metrics.memory.totalKb).toBe(0);
    expect(metrics.disk.percent).toBe(0);
    expect(metrics.diskIo.readBytesPerSec).toBe(0);
    expect(metrics.diskIo.writeBytesPerSec).toBe(0);
    expect(metrics.hostname).toBe('');
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