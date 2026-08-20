use std::{io, time::Duration};

use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};

pub type LocalStream = NamedPipeClient;

pub struct LocalListener {
    path: String,
    pending: Option<NamedPipeServer>,
}

impl LocalListener {
    pub fn bind(endpoint_id: &str) -> io::Result<Self> {
        let path = named_pipe_path(endpoint_id)?;
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(true)
            .reject_remote_clients(true);
        Ok(Self {
            pending: Some(options.create(&path)?),
            path,
        })
    }

    pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
        let server = match self.pending.take() {
            Some(server) => server,
            None => ServerOptions::new().create(&self.path)?,
        };
        let mut options = ServerOptions::new();
        options.reject_remote_clients(true);
        self.pending = Some(options.create(&self.path)?);
        server.connect().await?;
        Ok(server)
    }

    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }
}

pub async fn connect(endpoint_id: &str) -> io::Result<LocalStream> {
    let path = named_pipe_path(endpoint_id)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match ClientOptions::new().open(&path) {
            Ok(client) => return Ok(client),
            Err(error)
                if matches!(error.raw_os_error(), Some(2 | 231))
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

pub fn named_pipe_path(endpoint_id: &str) -> io::Result<String> {
    if endpoint_id.len() != 32
        || endpoint_id
            .bytes()
            .any(|byte| !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid IPC endpoint identifier",
        ));
    }
    Ok(format!(r"\\.\pipe\zcode-cycle-{endpoint_id}"))
}

#[cfg(test)]
mod tests {
    use super::named_pipe_path;

    #[test]
    fn names_pipe_in_zcode_cycle_namespace() {
        assert_eq!(
            named_pipe_path("0123456789abcdef0123456789abcdef").unwrap(),
            r"\\.\pipe\zcode-cycle-0123456789abcdef0123456789abcdef"
        );
    }
}
