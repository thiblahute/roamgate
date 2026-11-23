//! The front's HTTPS listener (`--tls-cert`/`--tls-key`, as the Bun
//! server's `Bun.serve({tls})`): TCP accepted at once, each TLS handshake
//! run on its own task so a slow client never holds the others back.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;

/// How long a client gets to finish its handshake.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The server configuration from PEM bytes (a chain, then its key).
pub fn server_config(cert: &[u8], key: &[u8]) -> Result<rustls::ServerConfig, String> {
    let chain = CertificateDer::pem_slice_iter(cert)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("invalid TLS certificate: {error}"))?;
    let key =
        PrivateKeyDer::from_pem_slice(key).map_err(|error| format!("invalid TLS key: {error}"))?;
    rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|error| format!("invalid TLS certificate or key: {error}"))
}

/// Accepted, handshaken connections.
pub struct TlsListener {
    accepted: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
    address: SocketAddr,
    accepting: tokio::task::JoinHandle<()>,
}

impl TlsListener {
    pub fn new(listener: TcpListener, config: rustls::ServerConfig) -> io::Result<Self> {
        let address = listener.local_addr()?;
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let (send, accepted) = mpsc::channel(64);
        let accepting = tokio::spawn(async move {
            loop {
                let (stream, peer) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    Err(_) => {
                        // Out of descriptors and the like: try again soon.
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let acceptor = acceptor.clone();
                let send = send.clone();
                tokio::spawn(async move {
                    let handshake =
                        tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await;
                    if let Ok(Ok(stream)) = handshake {
                        let _ = send.send((stream, peer)).await;
                    }
                });
            }
        });
        Ok(Self {
            accepted,
            address,
            accepting,
        })
    }
}

impl Drop for TlsListener {
    fn drop(&mut self) {
        self.accepting.abort();
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.accepted.recv().await {
            Some(accepted) => accepted,
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(self.address)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_key_that_is_not_pem() {
        let error = server_config(b"", b"nope").unwrap_err();
        assert!(error.starts_with("invalid TLS"), "{error}");
    }
}
