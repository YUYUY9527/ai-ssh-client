import { createSentinelStripper } from '../src/main/utils/sentinel-stripper';

let failures = 0;

function assertEqual(label: string, actual: string, expected: string) {
  if (actual === expected) {
    console.log(`✓ ${label}`);
  } else {
    failures += 1;
    console.error(`✗ ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}

function stripChunks(chunks: string[]): string {
  const stripper = createSentinelStripper();
  let out = '';
  for (const chunk of chunks) {
    out += stripper.feed(chunk);
  }
  out += stripper.flush();
  return out;
}

// Note: sentinel format is now `(cmd); printf '\n__AGENT_DONE_<runId>__:%s\n' "$?"`

// 1. 全量一次到达:应剥掉 echo 和 marker
{
  const input = `(ls -la); printf '\\n__AGENT_DONE_run-abc__:%s\\n' "$?"\r\ntotal 0\r\ndrwx------ 2 root root 4096 .\r\n__AGENT_DONE_run-abc__:0\r\n`;
  const expected = `(ls -la\r\ntotal 0\r\ndrwx------ 2 root root 4096 .\r\n`;
  assertEqual('single chunk removes echo + marker', stripChunks([input]), expected);
}

// 2. echo 被拆到多个 chunk
{
  const chunks = [
    `(ls -la); printf '\\n__AGEN`,
    `T_DONE_run-xyz__:%s\\n' "$?"\r\n`,
    `total 0\r\n`,
    `__AGENT_DONE_run-xyz__:0\r\n`,
  ];
  assertEqual('echo split across chunks', stripChunks(chunks), `(ls -la\r\ntotal 0\r\n`);
}

// 3. marker 被拆到多个 chunk
{
  const chunks = [
    `(whoami); printf '\\n__AGENT_DONE_run1__:%s\\n' "$?"\r\n`,
    `root\r\n__AGENT_`,
    `DONE_run1__:`,
    `0\r\n`,
  ];
  assertEqual('marker split across chunks', stripChunks(chunks), `(whoami\r\nroot\r\n`);
}

// 4. 不含 sentinel 的普通输出应原样输出
{
  const chunks = [
    `hello world\r\n`,
    `another line\r\n`,
  ];
  assertEqual('plain output unchanged', stripChunks(chunks), `hello world\r\nanother line\r\n`);
}

// 5. 提示符包含 `_` 的情况不应被误留 holdback(会在 flush 时输出)
{
  const chunks = [
    `user@host:/tmp/foo_bar$ `,
  ];
  assertEqual('trailing underscore does not stuck', stripChunks(chunks), `user@host:/tmp/foo_bar$ `);
}

// 6. marker 前已经是空行的情况:marker 只吃自己这行,前面的空行被保留
{
  const input = `line1\r\n\r\n__AGENT_DONE_r__:0\r\nprompt$ `;
  assertEqual('preserve earlier blank line', stripChunks([input]), `line1\r\n\r\nprompt$ `);
}

// 7. 非零 exit code 也要吃掉
{
  const input = `(false); printf '\\n__AGENT_DONE_abc__:%s\\n' "$?"\r\n__AGENT_DONE_abc__:1\r\n`;
  assertEqual('strip non-zero exit code line', stripChunks([input]), `(false\r\n`);
}

// 8. 两条命令连续
{
  const input =
    `(pwd); printf '\\n__AGENT_DONE_a__:%s\\n' "$?"\r\n/root\r\n__AGENT_DONE_a__:0\r\n` +
    `(ls); printf '\\n__AGENT_DONE_b__:%s\\n' "$?"\r\nfile1\r\n__AGENT_DONE_b__:0\r\n`;
  assertEqual('back-to-back commands',
    stripChunks([input]),
    `(pwd\r\n/root\r\n(ls\r\nfile1\r\n`);
}

// 9. 单字符逐字节到达的极端情况
{
  const input = `(echo hi); printf '\\n__AGENT_DONE_x__:%s\\n' "$?"\r\nhi\r\n__AGENT_DONE_x__:0\r\n`;
  const chunks: string[] = [];
  for (const ch of input) chunks.push(ch);
  assertEqual('byte-by-byte delivery', stripChunks(chunks), `(echo hi\r\nhi\r\n`);
}

// 10. 只看到 marker 前半部分,还没到行尾,不能误剥
{
  const chunks = [
    `output\r\n__AGENT_DONE_run-half__:0`,
  ];
  const stripper = createSentinelStripper();
  let mid = '';
  for (const chunk of chunks) mid += stripper.feed(chunk);
  assertEqual('incomplete marker holds back mid-stream', mid, `output\r\n`);
  const tail = stripper.feed(`\r\n`);
  assertEqual('marker strips after trailing newline arrives', tail, ``);
  const flushed = stripper.flush();
  assertEqual('flush yields nothing extra', flushed, ``);
}

// 11. 用户逐字符输入的回显必须立刻吐出去
{
  const stripper = createSentinelStripper();
  const typed: string[] = [];
  for (const ch of 'ls\r') {
    typed.push(stripper.feed(ch));
  }
  typed.push(stripper.flush());
  assertEqual('keystroke echoes flush immediately', typed.join(''), 'ls\r');
}

// 12. 光标控制/提示符等短输出也要立刻吐出
{
  const stripper = createSentinelStripper();
  const out = stripper.feed('[root@host ~]# ') + stripper.feed('\x1b[K') + stripper.flush();
  assertEqual('short prompt flushes immediately', out, '[root@host ~]# \x1b[K');
}

// 13. 普通分号不会被误 holdback(新格式是 `);` 不是 `;`)
{
  const stripper = createSentinelStripper();
  const a = stripper.feed('echo a; echo b\r\n');
  assertEqual('plain semicolon passes through', a + stripper.flush(), 'echo a; echo b\r\n');
}

// 14. 子 shell 结尾 `);` 会被 holdback 直到确认不是 printf
{
  const stripper = createSentinelStripper();
  const a = stripper.feed('(cmd)');  // 不含 `;` 还不会 holdback
  const b = stripper.feed('; ');     // `);` 出现,开始 holdback
  const c = stripper.feed('echo next\r\n');  // 不是 printf,释放
  assertEqual('subshell close + non-printf recovers', a + b + c + stripper.flush(), '(cmd); echo next\r\n');
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nall tests passed');
}
