import { describe, expect, it } from 'vitest';

import {
  MAX_LOGICAL_LINE_ROWS,
  isPromptLineReady,
  isShellPromptOnlyLine,
  readLogicalBufferLine,
  resolveAgentPromptEraseSequence,
  resolveSubmittedInput,
  stripPromptPrefix,
  type TerminalBufferLineLike,
} from '../src/renderer/session/terminal/terminal-input-line';

function buffer(rows: Array<string | { text: string; wrapped?: boolean }>) {
  const lines: TerminalBufferLineLike[] = rows.map((row) => (
    typeof row === 'string'
      ? { isWrapped: false, translateToString: () => row }
      : { isWrapped: row.wrapped === true, translateToString: () => row.text }
  ));
  return (index: number) => lines[index];
}

describe('readLogicalBufferLine — 折行必须拼回完整逻辑行', () => {
  it('单行直接返回', () => {
    expect(readLogicalBufferLine(buffer(['[root@h ~]# ls']), 0)).toBe('[root@h ~]# ls');
  });

  it('把软折行的续行拼回（真实回归：长输入只提交了第一段）', () => {
    const getLine = buffer([
      '[root@k8s-slave1 ~]# 还能查询到其他虚拟',
      { text: '机吗', wrapped: true },
    ]);
    expect(readLogicalBufferLine(getLine, 1)).toBe('[root@k8s-slave1 ~]# 还能查询到其他虚拟机吗');
  });

  it('多段折行全部拼回', () => {
    const getLine = buffer([
      'prompt: aaaa',
      { text: 'bbbb', wrapped: true },
      { text: 'cccc', wrapped: true },
    ]);
    expect(readLogicalBufferLine(getLine, 2)).toBe('prompt: aaaabbbbcccc');
  });

  it('不以 isWrapped 开头时只读当前行，不吞掉上一条命令', () => {
    const getLine = buffer([
      '[root@h ~]# previous-command',
      '[root@h ~]# new',
    ]);
    expect(readLogicalBufferLine(getLine, 1)).toBe('[root@h ~]# new');
  });

  it('向上回溯有上限，异常 buffer 不会死循环', () => {
    const rows = Array.from({ length: MAX_LOGICAL_LINE_ROWS + 20 }, (_value, index) => (
      { text: index === 0 ? 'start' : 'x', wrapped: true }
    ));
    const joined = readLogicalBufferLine(buffer(rows), rows.length - 1);
    expect(joined.length).toBeGreaterThan(0);
    expect(joined.length).toBeLessThanOrEqual(MAX_LOGICAL_LINE_ROWS + 1);
  });

  it('buffer 行缺失时安全截断', () => {
    expect(readLogicalBufferLine(() => undefined, 5)).toBe('');
  });
});

describe('stripPromptPrefix / isPromptLineReady', () => {
  it('识别常见提示符并剥掉前缀', () => {
    expect(stripPromptPrefix('[root@k8s-slave1 ~]# docker ps'))
      .toEqual({ text: 'docker ps', matched: true });
    expect(stripPromptPrefix('user@host:~$ ls'))
      .toEqual({ text: 'ls', matched: true });
    expect(stripPromptPrefix('bash-4.2# id'))
      .toEqual({ text: 'id', matched: true });
    expect(stripPromptPrefix('❯ git status'))
      .toEqual({ text: 'git status', matched: true });
  });

  it('heredoc / 续行 / 普通文本不算提示符行', () => {
    expect(stripPromptPrefix('> heredoc body').matched).toBe(false);
    expect(stripPromptPrefix('随便一段文字').matched).toBe(false);
    expect(isPromptLineReady('> @ai literal heredoc')).toBe(false);
    expect(isPromptLineReady('# @ai literal continuation')).toBe(false);
    expect(isPromptLineReady('')).toBe(false);
    expect(isPromptLineReady('#')).toBe(false);
  });

  it('提示符行（含折行拼回后）判定为就绪', () => {
    expect(isPromptLineReady('[root@h ~]# ')).toBe(true);
    expect(isPromptLineReady('[root@h ~]# 还能查询到其他虚拟机吗')).toBe(true);
    expect(isPromptLineReady('custom-prompt without marker')).toBe(false);
  });
});

describe('isShellPromptOnlyLine — 只认裸提示符', () => {
  it('裸提示符命中（含常见格式）', () => {
    expect(isShellPromptOnlyLine('[root@k8s-slave2 ~]#')).toBe(true);
    expect(isShellPromptOnlyLine('[root@k8s-slave2 ~]# ')).toBe(true);
    expect(isShellPromptOnlyLine('user@host:~$')).toBe(true);
    expect(isShellPromptOnlyLine('bash-4.2# ')).toBe(true);
    expect(isShellPromptOnlyLine('❯ ')).toBe(true);
  });

  it('带输入内容 / 普通输出 / 空行不命中', () => {
    expect(isShellPromptOnlyLine('[root@h ~]# ls -l')).toBe(false);
    expect(isShellPromptOnlyLine('docker inspect xxx')).toBe(false);
    expect(isShellPromptOnlyLine('')).toBe(false);
    expect(isShellPromptOnlyLine('#')).toBe(false);
  });
});

describe('resolveAgentPromptEraseSequence — 擦掉 Agent 期间的裸提示符', () => {
  it('光标在提示符行时直接清当前行', () => {
    expect(resolveAgentPromptEraseSequence('[root@h ~]# ', '上一行输出'))
      .toBe('\r\x1b[2K');
  });

  it('光标在提示符下方空行时上移一行清掉再回来', () => {
    expect(resolveAgentPromptEraseSequence('', '[root@h ~]# '))
      .toBe('\x1b[1A\r\x1b[2K\x1b[1B');
  });

  it('当前行有内容时不误擦', () => {
    expect(resolveAgentPromptEraseSequence('Agent · 思考中', '[root@h ~]# ')).toBeNull();
    expect(resolveAgentPromptEraseSequence('普通输出', null)).toBeNull();
  });
});

describe('resolveSubmittedInput — 提交内容取更完整的一方', () => {
  it('两者相同', () => {
    expect(resolveSubmittedInput('docker ps', 'docker ps')).toBe('docker ps');
  });

  it('屏幕更完整（追踪被截断/漏记）时以屏幕为准', () => {
    // 真实回归：追踪只有折行前第一段，屏幕上是完整问题
    expect(resolveSubmittedInput('还能查询到其他虚拟', '还能查询到其他虚拟机吗'))
      .toBe('还能查询到其他虚拟机吗');
    // 粘贴未进追踪：屏幕内容以追踪内容结尾
    expect(resolveSubmittedInput('是什么', 'Portainer Agent是什么'))
      .toBe('Portainer Agent是什么');
  });

  it('两者都不互为前后缀时以屏幕为准（本地追踪漂移）', () => {
    // 真实回归：光标编辑/删除键/输入法候选让本地追踪多出/错位了「其他」
    expect(resolveSubmittedInput('还能查询到其他虚拟其他', '还能查询到其他虚拟机吗'))
      .toBe('还能查询到其他虚拟机吗');
  });

  it('回显滞后（追踪是屏幕的超集）时以追踪为准', () => {
    expect(resolveSubmittedInput('docker ps -a', 'docker ps'))
      .toBe('docker ps -a');
  });

  it('单侧为空时取另一侧', () => {
    expect(resolveSubmittedInput('', 'docker ps')).toBe('docker ps');
    expect(resolveSubmittedInput('docker ps', '')).toBe('docker ps');
    expect(resolveSubmittedInput('  ', '  ')).toBe('');
  });
});
