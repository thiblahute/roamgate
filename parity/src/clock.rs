//! The test clock's control socket (contract/wire/test-clock.md).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub struct Clock {
    path: PathBuf,
}

impl Clock {
    pub fn new(path: &Path) -> Clock {
        Clock {
            path: path.to_path_buf(),
        }
    }

    async fn request(&self, line: &str) -> Result<String> {
        let stream = roamgate_base::local_socket::connect(&self.path)
            .await
            .with_context(|| format!("test clock at {}", self.path.display()))?;
        let (read, mut write) = tokio::io::split(stream);
        write.write_all(format!("{line}\n").as_bytes()).await?;
        let mut reply = String::new();
        BufReader::new(read).read_line(&mut reply).await?;
        let reply = reply.trim().to_owned();
        if let Some(message) = reply.strip_prefix("error ") {
            bail!("test clock refused {line:?}: {message}");
        }
        Ok(reply)
    }

    /// The virtual time, epoch milliseconds.
    pub async fn now(&self) -> Result<i64> {
        Ok(self.request("now").await?.parse()?)
    }

    /// Moves the clock; gives the new time once the due timers ran.
    pub async fn advance(&self, ms: u64) -> Result<i64> {
        Ok(self.request(&format!("advance {ms}")).await?.parse()?)
    }
}
