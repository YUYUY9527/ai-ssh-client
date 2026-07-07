const SENTINEL_PREFIX: &str = "__AGENT_DONE_";
const MULTILINE_HELPER_PREFIX: &str = "__ais_ec=$?; printf";
const WRAPPED_PRINTF_PREFIX: &str = "printf '\\n";

#[derive(Default)]
pub struct SentinelStripper {
    buffer: String,
}

impl SentinelStripper {
    pub fn feed(&mut self, chunk: &str) -> String {
        self.buffer.push_str(chunk);
        self.drain_ready(false)
    }

    pub fn flush(&mut self) -> String {
        self.drain_ready(true)
    }

    fn drain_ready(&mut self, flushing: bool) -> String {
        let mut output = String::new();

        while let Some(newline_index) = self.buffer.find('\n') {
            let line: String = self.buffer.drain(..=newline_index).collect();
            if !is_sentinel_artifact_line(&line) {
                output.push_str(&line);
            }
        }

        if self.buffer.is_empty() {
            return output;
        }

        if flushing {
            if !should_drop_incomplete_tail(&self.buffer) {
                output.push_str(&self.buffer);
            }
            self.buffer.clear();
            return output;
        }

        if !should_hold_tail(&self.buffer) {
            output.push_str(&self.buffer);
            self.buffer.clear();
        }

        output
    }
}

pub fn make_sentinel_marker(run_id: &str) -> String {
    format!("{SENTINEL_PREFIX}{run_id}__")
}

pub fn wrap_command_with_sentinel(command: &str, run_id: &str) -> String {
    let marker = make_sentinel_marker(run_id);
    let trimmed = command.trim_end_matches(['\r', '\n']);

    if trimmed.contains('\n') || trimmed.contains("<<") {
        return format!("\r{trimmed}\n__ais_ec=$?; printf '\\n{marker}:%s\\n' \"$__ais_ec\"\n");
    }

    format!("\r({trimmed}); printf '\\n{marker}:%s\\n' \"$?\"\n")
}

pub fn format_agent_command_echo(command: &str) -> String {
    let trimmed = command.trim_end_matches(['\r', '\n']);
    format!("\r\n{trimmed}\r\n")
}

pub fn parse_sentinel(buffer: &str, marker: &str) -> Option<(String, i32)> {
    for (marker_index, _) in buffer.match_indices(marker) {
        let after_marker = &buffer[marker_index + marker.len()..];
        let Some(exit_code_text) = after_marker.strip_prefix(':') else {
            continue;
        };
        let exit_code_line = exit_code_text
            .split(['\r', '\n'])
            .next()
            .unwrap_or_default()
            .trim();
        let Ok(exit_code) = exit_code_line.parse::<i32>() else {
            continue;
        };
        return Some((buffer[..marker_index].to_string(), exit_code));
    }

    None
}

pub fn strip_complete_sentinel_artifacts(input: &str) -> String {
    let mut stripper = SentinelStripper::default();
    let mut output = stripper.feed(input);
    output.push_str(&stripper.flush());
    output
}

fn is_sentinel_artifact_line(line: &str) -> bool {
    line.contains(SENTINEL_PREFIX) || line.contains(MULTILINE_HELPER_PREFIX)
}

fn should_hold_tail(tail: &str) -> bool {
    if tail == "\r" {
        return true;
    }

    let trimmed_tail = trim_line_start(tail);
    if trimmed_tail.is_empty() {
        return false;
    }

    is_sentinel_artifact_line(trimmed_tail)
        || starts_with_artifact_prefix(trimmed_tail)
        || is_possible_wrapped_command_tail(tail)
}

fn should_drop_incomplete_tail(tail: &str) -> bool {
    let trimmed_tail = trim_line_start(tail);
    if trimmed_tail.is_empty() {
        return false;
    }

    is_sentinel_artifact_line(trimmed_tail)
        || starts_with_artifact_prefix(trimmed_tail)
        || is_incomplete_wrapped_printf_tail(tail)
}

fn trim_line_start(value: &str) -> &str {
    value.trim_start_matches(['\r', '\n'])
}

fn starts_with_artifact_prefix(line: &str) -> bool {
    SENTINEL_PREFIX.starts_with(line) || MULTILINE_HELPER_PREFIX.starts_with(line)
}

fn is_possible_wrapped_command_tail(line: &str) -> bool {
    if line == "\r" {
        return true;
    }

    let Some(line) = line.strip_prefix('\r') else {
        return false;
    };
    if !line.starts_with('(') {
        return false;
    }

    let Some(close_index) = line.find(");") else {
        return true;
    };
    let after = line[close_index + 2..].trim_start();
    after.is_empty()
        || WRAPPED_PRINTF_PREFIX.starts_with(after)
        || after.starts_with(WRAPPED_PRINTF_PREFIX)
}

fn is_incomplete_wrapped_printf_tail(line: &str) -> bool {
    let Some(line) = line.strip_prefix('\r') else {
        return false;
    };

    let Some(close_index) = line.find(");") else {
        return false;
    };
    let after = line[close_index + 2..].trim_start();
    !after.is_empty()
        && (WRAPPED_PRINTF_PREFIX.starts_with(after) || after.starts_with(WRAPPED_PRINTF_PREFIX))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip_chunks(chunks: &[&str]) -> String {
        let mut stripper = SentinelStripper::default();
        let mut output = String::new();
        for chunk in chunks {
            output.push_str(&stripper.feed(chunk));
        }
        output.push_str(&stripper.flush());
        output
    }

    #[test]
    fn plain_output_passes_through() {
        assert_eq!(
            strip_chunks(&["hello world\r\n", "another line\r\n"]),
            "hello world\r\nanother line\r\n"
        );
    }

    #[test]
    fn split_marker_line_is_removed() {
        assert_eq!(
            strip_chunks(&["root\r\n__AGENT_", "DONE_run1__:", "0\r\nprompt$ ",]),
            "root\r\nprompt$ "
        );
    }

    #[test]
    fn split_multiline_helper_line_is_removed() {
        assert_eq!(
            strip_chunks(&[
                "output\r\n__ais_",
                "ec=$?; printf '\\n__AGENT_DONE_run__:%s\\n' \"$__ais_ec\"\r\n",
                "prompt$ ",
            ]),
            "output\r\nprompt$ "
        );
    }

    #[test]
    fn incomplete_marker_waits_for_newline() {
        let mut stripper = SentinelStripper::default();
        assert_eq!(
            stripper.feed("output\r\n__AGENT_DONE_run__:0"),
            "output\r\n"
        );
        assert_eq!(stripper.feed("\r\n"), "");
        assert_eq!(stripper.flush(), "");
    }

    #[test]
    fn prompt_and_keystrokes_pass_immediately() {
        assert_eq!(
            strip_chunks(&["user@host:/tmp/foo_bar$ "]),
            "user@host:/tmp/foo_bar$ "
        );
        assert_eq!(strip_chunks(&["l", "s", "\r"]), "ls\r");
        assert_eq!(strip_chunks(&["("]), "(");
    }

    #[test]
    fn wrapped_command_echo_can_arrive_byte_by_byte() {
        let input = "\r(echo hi); printf '\\n__AGENT_DONE_x__:%s\\n' \"$?\"\r\nhi\r\n__AGENT_DONE_x__:0\r\n";
        let chunks = input.chars().map(|ch| ch.to_string()).collect::<Vec<_>>();
        let chunk_refs = chunks.iter().map(String::as_str).collect::<Vec<_>>();
        assert_eq!(strip_chunks(&chunk_refs), "hi\r\n");
    }

    #[test]
    fn non_sentinel_subshell_line_recovers() {
        assert_eq!(
            strip_chunks(&["(cmd)", "; ", "echo next\r\n"]),
            "(cmd); echo next\r\n"
        );
    }
}
