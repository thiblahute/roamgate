//! What a command prints: its lines as console.log and console.error write
//! them, and its exit code.

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Printed {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Printed {
    /// A line of stdout (console.log: the text, then a newline).
    pub fn log(&mut self, line: &str) {
        self.stdout.push_str(line);
        self.stdout.push('\n');
    }

    /// A line of stderr.
    pub fn error(&mut self, line: &str) {
        self.stderr.push_str(line);
        self.stderr.push('\n');
    }

    pub fn exit(mut self, code: i32) -> Self {
        self.code = code;
        self
    }
}
