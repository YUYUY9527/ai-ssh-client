const assert = require('node:assert/strict');
const {
  createSentinelStripper,
  makeSentinelMarker,
  parseSentinel,
  stripCompleteSentinelArtifacts,
  stripVisibleAgentArtifacts,
  wrapCommandWithSentinel,
} = require('../server/sentinel.cjs');

function stripChunks(chunks) {
  const stripper = createSentinelStripper();
  let output = '';
  for (const chunk of chunks) {
    output += stripper.feed(chunk);
  }
  return output + stripper.flush();
}

assert.equal(makeSentinelMarker('run-1'), '__AGENT_DONE_run-1__');
assert.equal(
  wrapCommandWithSentinel('pwd', 'run-1'),
  "\r(pwd); printf '\\n__AGENT_DONE_run-1__:%s\\n' \"$?\"\n",
);
assert.deepEqual(
  parseSentinel('output\r\n__AGENT_DONE_run-1__:7\r\n', '__AGENT_DONE_run-1__'),
  { output: 'output\r\n', exitCode: 7 },
);

assert.equal(
  stripChunks(['hello world\r\n', 'another line\r\n']),
  'hello world\r\nanother line\r\n',
);

assert.equal(
  stripChunks(['root\r\n__AGENT_', 'DONE_run1__:', '0\r\nprompt$ ']),
  'root\r\nprompt$ ',
);

assert.equal(
  stripChunks([
    'output\r\n__ais_',
    'ec=$?; printf \'\\n__AGENT_DONE_run__:%s\\n\' "$__ais_ec"\r\n',
    'prompt$ ',
  ]),
  'output\r\nprompt$ ',
);

{
  const stripper = createSentinelStripper();
  assert.equal(stripper.feed('output\r\n__AGENT_DONE_run-half__:0'), 'output\r\n');
  assert.equal(stripper.feed('\r\n'), '');
  assert.equal(stripper.flush(), '');
}

assert.equal(stripChunks(['user@host:/tmp/foo_bar$ ']), 'user@host:/tmp/foo_bar$ ');
assert.equal(stripChunks(['l', 's', '\r']), 'ls\r');
assert.equal(stripChunks(['(']), '(');

{
  const input = '\r(echo hi); printf \'\\n__AGENT_DONE_x__:%s\\n\' "$?"\r\nhi\r\n__AGENT_DONE_x__:0\r\n';
  assert.equal(stripChunks([...input]), 'hi\r\n');
}

assert.equal(stripChunks(['(cmd)', '; ', 'echo next\r\n']), '(cmd); echo next\r\n');
assert.equal(
  stripCompleteSentinelArtifacts('line1\r\n\r\n__AGENT_DONE_r__:0\r\nprompt$ '),
  'line1\r\n\r\nprompt$ ',
);

{
  const session = { agentEchoPending: true };
  let output = stripVisibleAgentArtifacts(session, '(echo hi); printf \'\\n__AGEN');
  output += stripVisibleAgentArtifacts(session, 'T_DONE_x__:%s\\n\' "$?"\r\nhi\r\n__AGENT_DONE_x__:0\r\n');
  assert.equal(output, 'hi\r\n');
}

console.log('sentinel tests passed');
