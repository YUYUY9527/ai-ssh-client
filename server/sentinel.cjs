const SENTINEL_PREFIX = '__AGENT_DONE_';
const MULTILINE_HELPER_PREFIX = '__ais_ec=$?; printf';
const WRAPPED_PRINTF_PREFIX = "printf '\\n";

function makeSentinelMarker(runId) {
  return `${SENTINEL_PREFIX}${runId}__`;
}

function wrapCommandWithSentinel(command, runId) {
  const marker = makeSentinelMarker(runId);
  const trimmed = command.trimEnd();

  if (trimmed.includes('\n') || trimmed.includes('<<')) {
    return `\r${trimmed}\n__ais_ec=$?; printf '\\n${marker}:%s\\n' "$__ais_ec"\n`;
  }

  return `\r(${trimmed}); printf '\\n${marker}:%s\\n' "$?"\n`;
}

function formatAgentCommandEcho(command) {
  return `\r\n${command.trimEnd()}\r\n`;
}

function parseSentinel(buffer, marker) {
  let markerIndex = buffer.indexOf(marker);
  while (markerIndex !== -1) {
    const afterMarker = buffer.slice(markerIndex + marker.length);
    if (afterMarker.startsWith(':')) {
      const exitCodeText = afterMarker.slice(1).split(/\r?\n/)[0].trim();
      const exitCode = Number.parseInt(exitCodeText, 10);
      if (Number.isInteger(exitCode)) {
        return { output: buffer.slice(0, markerIndex), exitCode };
      }
    }
    markerIndex = buffer.indexOf(marker, markerIndex + marker.length);
  }

  return null;
}

function createSentinelStripper() {
  let buffer = '';

  const drainReady = (flushing) => {
    let output = '';
    let newlineIndex = buffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex + 1);
      buffer = buffer.slice(newlineIndex + 1);
      if (!isSentinelArtifactLine(line)) {
        output += line;
      }
      newlineIndex = buffer.indexOf('\n');
    }

    if (!buffer) {
      return output;
    }

    if (flushing) {
      if (!shouldDropIncompleteTail(buffer)) {
        output += buffer;
      }
      buffer = '';
      return output;
    }

    if (!shouldHoldTail(buffer)) {
      output += buffer;
      buffer = '';
    }

    return output;
  };

  return {
    feed(chunk) {
      buffer += chunk;
      return drainReady(false);
    },
    flush() {
      return drainReady(true);
    },
  };
}

function stripCompleteSentinelArtifacts(input) {
  const stripper = createSentinelStripper();
  return stripper.feed(input) + stripper.flush();
}

function stripVisibleAgentArtifacts(session, text) {
  let nextText = text;
  if (session.agentEchoPending) {
    const lineEnd = nextText.search(/[\r\n]/);
    if (lineEnd === -1) {
      return '';
    }
    nextText = nextText.slice(lineEnd + 1).replace(/^\n/, '');
    session.agentEchoPending = false;
  }

  session.sentinelStripper ||= createSentinelStripper();
  return session.sentinelStripper.feed(nextText);
}

function isSentinelArtifactLine(line) {
  return line.includes(SENTINEL_PREFIX) || line.includes(MULTILINE_HELPER_PREFIX);
}

function shouldHoldTail(tail) {
  if (tail === '\r') {
    return true;
  }

  const nextTail = trimLineStart(tail);
  if (!nextTail) {
    return false;
  }

  return isSentinelArtifactLine(nextTail)
    || startsWithArtifactPrefix(nextTail)
    || isPossibleWrappedCommandTail(tail);
}

function shouldDropIncompleteTail(tail) {
  const nextTail = trimLineStart(tail);
  if (!nextTail) {
    return false;
  }

  return isSentinelArtifactLine(nextTail)
    || startsWithArtifactPrefix(nextTail)
    || isIncompleteWrappedPrintfTail(tail);
}

function trimLineStart(value) {
  return value.replace(/^[\r\n]+/, '');
}

function startsWithArtifactPrefix(line) {
  return SENTINEL_PREFIX.startsWith(line) || MULTILINE_HELPER_PREFIX.startsWith(line);
}

function isPossibleWrappedCommandTail(line) {
  if (line === '\r') {
    return true;
  }
  if (!line.startsWith('\r')) {
    return false;
  }

  const nextLine = line.slice(1);
  if (!nextLine.startsWith('(')) {
    return false;
  }

  const closeIndex = nextLine.indexOf(');');
  if (closeIndex === -1) {
    return true;
  }

  const after = nextLine.slice(closeIndex + 2).trimStart();
  return !after
    || WRAPPED_PRINTF_PREFIX.startsWith(after)
    || after.startsWith(WRAPPED_PRINTF_PREFIX);
}

function isIncompleteWrappedPrintfTail(line) {
  if (!line.startsWith('\r')) {
    return false;
  }

  const nextLine = line.slice(1);
  const closeIndex = nextLine.indexOf(');');
  if (closeIndex === -1) {
    return false;
  }

  const after = nextLine.slice(closeIndex + 2).trimStart();
  return Boolean(after)
    && (WRAPPED_PRINTF_PREFIX.startsWith(after)
      || after.startsWith(WRAPPED_PRINTF_PREFIX));
}

module.exports = {
  createSentinelStripper,
  formatAgentCommandEcho,
  makeSentinelMarker,
  parseSentinel,
  stripCompleteSentinelArtifacts,
  stripVisibleAgentArtifacts,
  wrapCommandWithSentinel,
};
