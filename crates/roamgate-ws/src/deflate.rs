//! The permessage-deflate extension (RFC 7692) as Bun's
//! `perMessageDeflate: { compress: "dedicated", decompress: "shared" }`
//! negotiates it: the server keeps one compressor per socket with context
//! takeover (unless the client asks otherwise), and requires the client to
//! compress each message on its own (`client_no_context_takeover`).
//!
//! Compression is chosen per message: a frame with RSV1 set is compressed,
//! any other is sent as is, and the compressor's history only covers the
//! compressed ones.

use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

/// The tail every sync flush ends with; RFC 7692 leaves it off the wire.
const SYNC_TAIL: [u8; 4] = [0x00, 0x00, 0xff, 0xff];

/// What the handshake agreed on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Negotiated {
    /// The client asked the server not to keep history between messages.
    pub server_no_context_takeover: bool,
    /// The server's LZ77 window, 9 to 15 bits.
    pub server_max_window_bits: u8,
    /// The `Sec-WebSocket-Extensions` response value.
    pub response: String,
}

fn parse_bits(value: Option<&str>) -> Option<u8> {
    let value = value?.trim_matches('"');
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let bits: u8 = value.parse().ok()?;
    (8..=15).contains(&bits).then_some(bits)
}

/// Accepts the first permessage-deflate offer of the request's
/// `Sec-WebSocket-Extensions` values that this server can honour, and
/// declines the extension otherwise. An offer with an unknown or repeated
/// parameter is skipped, as RFC 7692 requires.
pub fn negotiate<'a>(header_values: impl IntoIterator<Item = &'a str>) -> Option<Negotiated> {
    for value in header_values {
        'offers: for offer in value.split(',') {
            let mut parts = offer.split(';').map(str::trim);
            if parts.next() != Some("permessage-deflate") {
                continue;
            }
            let mut server_no_context_takeover = false;
            let mut client_no_context_takeover = false;
            let mut server_max_window_bits: Option<u8> = None;
            let mut client_max_window_bits = false;
            for parameter in parts {
                if parameter.is_empty() {
                    continue;
                }
                let (name, value) = match parameter.split_once('=') {
                    Some((name, value)) => (name.trim(), Some(value.trim())),
                    None => (parameter, None),
                };
                let flag = match name {
                    "server_no_context_takeover" if value.is_none() => {
                        &mut server_no_context_takeover
                    }
                    "client_no_context_takeover" if value.is_none() => {
                        &mut client_no_context_takeover
                    }
                    "client_max_window_bits" => {
                        if value.is_some() && parse_bits(value).is_none() {
                            continue 'offers;
                        }
                        &mut client_max_window_bits
                    }
                    "server_max_window_bits" => {
                        if server_max_window_bits.is_some() {
                            continue 'offers;
                        }
                        match parse_bits(value) {
                            // A raw deflate stream cannot use an 8-bit window.
                            Some(bits) if bits >= 9 => server_max_window_bits = Some(bits),
                            _ => continue 'offers,
                        }
                        continue;
                    }
                    _ => continue 'offers,
                };
                if *flag {
                    continue 'offers;
                }
                *flag = true;
            }
            let mut response = String::from("permessage-deflate; client_no_context_takeover");
            if server_no_context_takeover {
                response.push_str("; server_no_context_takeover");
            }
            if let Some(bits) = server_max_window_bits {
                response.push_str(&format!("; server_max_window_bits={bits}"));
            }
            return Some(Negotiated {
                server_no_context_takeover,
                server_max_window_bits: server_max_window_bits.unwrap_or(15),
                response,
            });
        }
    }
    None
}

/// The socket's own compressor.
pub struct Deflater {
    stream: Compress,
    no_context_takeover: bool,
}

impl Deflater {
    pub fn new(negotiated: &Negotiated, level: u32) -> Self {
        Deflater {
            stream: Compress::new_with_window_bits(
                Compression::new(level),
                false,
                negotiated.server_max_window_bits,
            ),
            no_context_takeover: negotiated.server_no_context_takeover,
        }
    }

    /// Compresses one whole message into `output` (appended).
    pub fn compress(&mut self, input: &[u8], output: &mut Vec<u8>) -> Result<(), String> {
        let start_in = self.stream.total_in();
        output.reserve(input.len() / 2 + 64);
        loop {
            let consumed = (self.stream.total_in() - start_in) as usize;
            self.stream
                .compress_vec(&input[consumed..], output, FlushCompress::Sync)
                .map_err(|error| error.to_string())?;
            let consumed = (self.stream.total_in() - start_in) as usize;
            // A sync flush is complete once it stopped with output room left.
            if consumed == input.len() && output.len() < output.capacity() {
                break;
            }
            output.reserve(output.capacity().max(4096));
        }
        if output.ends_with(&SYNC_TAIL) {
            output.truncate(output.len() - SYNC_TAIL.len());
        }
        if self.no_context_takeover {
            self.stream.reset();
        }
        Ok(())
    }
}

/// Why an inflate failed.
#[derive(Debug, PartialEq, Eq)]
pub enum InflateError {
    /// The message inflates past the size limit.
    TooBig,
    Corrupt(String),
}

/// The socket's decompressor; the client compresses every message on its
/// own, so it starts afresh for each.
pub struct Inflater {
    stream: Decompress,
}

impl Default for Inflater {
    fn default() -> Self {
        Inflater {
            stream: Decompress::new_with_window_bits(false, 15),
        }
    }
}

impl Inflater {
    pub fn decompress(&mut self, input: &[u8], max_len: usize) -> Result<Vec<u8>, InflateError> {
        let result = self.inflate(input, max_len);
        self.stream.reset(false);
        result
    }

    fn inflate(&mut self, input: &[u8], max_len: usize) -> Result<Vec<u8>, InflateError> {
        let mut output = Vec::with_capacity((input.len() * 4).clamp(64, max_len.max(64)));
        for part in [input, &SYNC_TAIL[..]] {
            let start_in = self.stream.total_in();
            loop {
                let consumed = (self.stream.total_in() - start_in) as usize;
                let produced = output.len();
                let status = self
                    .stream
                    .decompress_vec(&part[consumed..], &mut output, FlushDecompress::Sync)
                    .map_err(|error| InflateError::Corrupt(error.to_string()))?;
                if output.len() > max_len {
                    return Err(InflateError::TooBig);
                }
                let before = consumed;
                let consumed = (self.stream.total_in() - start_in) as usize;
                // Done with this part once it is all in and the output still
                // had room: nothing more is pending inside the stream.
                if status == Status::StreamEnd
                    || (consumed == part.len() && output.len() < output.capacity())
                {
                    break;
                }
                if consumed == before
                    && output.len() == produced
                    && output.len() < output.capacity()
                {
                    return Err(InflateError::Corrupt("inflate made no progress".into()));
                }
                output.reserve(output.capacity().max(4096));
            }
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_offers_as_bun_does() {
        let cases = [
            (
                "permessage-deflate; client_max_window_bits",
                Some("permessage-deflate; client_no_context_takeover"),
            ),
            (
                "permessage-deflate",
                Some("permessage-deflate; client_no_context_takeover"),
            ),
            (
                "permessage-deflate; client_max_window_bits; server_max_window_bits=10",
                Some("permessage-deflate; client_no_context_takeover; server_max_window_bits=10"),
            ),
            (
                "permessage-deflate; server_no_context_takeover",
                Some("permessage-deflate; client_no_context_takeover; server_no_context_takeover"),
            ),
            (
                "permessage-deflate; client_max_window_bits=9, permessage-deflate",
                Some("permessage-deflate; client_no_context_takeover"),
            ),
            (
                "permessage-deflate; bogus, permessage-deflate",
                Some("permessage-deflate; client_no_context_takeover"),
            ),
            ("permessage-deflate; server_max_window_bits=16", None),
            ("permessage-deflate; server_max_window_bits", None),
            (
                "permessage-deflate; server_no_context_takeover; server_no_context_takeover",
                None,
            ),
            ("x-webkit-deflate-frame", None),
        ];
        for (offer, expected) in cases {
            assert_eq!(
                negotiate([offer]).map(|n| n.response),
                expected.map(str::to_owned),
                "{offer}"
            );
        }
    }

    #[test]
    fn round_trips_with_and_without_history() {
        for offer in [
            "permessage-deflate",
            "permessage-deflate; server_no_context_takeover; server_max_window_bits=9",
        ] {
            let negotiated = negotiate([offer]).unwrap();
            let mut deflater = Deflater::new(&negotiated, 1);
            let mut inflater = Decompress::new_with_window_bits(false, 15);
            // Little redundancy inside, so only history makes it small.
            let message: String = (0..400u32)
                .map(|n| {
                    format!(
                        "\u{1b}[{};{}H{} é 😀 ",
                        n % 50,
                        n * 7 % 131,
                        n.wrapping_mul(2_654_435_761)
                    )
                })
                .collect();
            let mut sizes = Vec::new();
            for _ in 0..3 {
                let mut wire = Vec::new();
                deflater.compress(message.as_bytes(), &mut wire).unwrap();
                sizes.push(wire.len());
                // A client keeping history across messages, as browsers do.
                wire.extend_from_slice(&SYNC_TAIL);
                let mut plain = Vec::with_capacity(message.len() + 64);
                inflater
                    .decompress_vec(&wire, &mut plain, FlushDecompress::Sync)
                    .unwrap();
                assert_eq!(plain, message.as_bytes());
            }
            if negotiated.server_no_context_takeover {
                assert_eq!(sizes[0], sizes[1]);
            } else {
                assert!(sizes[1] < sizes[0] / 10, "{sizes:?}");
            }
        }
    }

    #[test]
    fn inflates_each_client_message_on_its_own_and_caps_the_size() {
        let negotiated = negotiate(["permessage-deflate; server_no_context_takeover"]).unwrap();
        let mut deflater = Deflater::new(&negotiated, 6);
        let mut inflater = Inflater::default();
        for text in [
            "first",
            "second message, a little longer",
            &"z".repeat(100_000),
        ] {
            let mut wire = Vec::new();
            deflater.compress(text.as_bytes(), &mut wire).unwrap();
            assert_eq!(
                inflater.decompress(&wire, 1 << 20).unwrap(),
                text.as_bytes()
            );
        }
        let mut bomb = Vec::new();
        deflater.compress(&vec![b'a'; 4 << 20], &mut bomb).unwrap();
        assert_eq!(
            inflater.decompress(&bomb, 1 << 20),
            Err(InflateError::TooBig)
        );
        assert!(matches!(
            inflater.decompress(&[0xff, 0xff, 0xff], 1 << 20),
            Err(InflateError::Corrupt(_))
        ));
    }
}
