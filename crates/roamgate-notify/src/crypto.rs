//! Web Push's cryptography, as the `web-push` package does it for the Bun
//! server: VAPID key pairs (P-256, base64url without padding), the VAPID
//! authorization (an ES256 JWT: `vapid t=<jwt>, k=<public key>`, valid 12
//! hours), and the `aes128gcm` content encoding of RFC 8291 (records of
//! 4096 bytes, no padding).

use aes_gcm::aead::{Aead, KeyInit, OsRng, rand_core::RngCore};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;

/// The record size `web-push` (http_ece) encrypts with.
pub const RECORD_SIZE: usize = 4096;
/// What a VAPID JWT is valid for, in seconds.
pub const VAPID_EXPIRATION_SECONDS: i64 = 12 * 60 * 60;

pub fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The bytes of a key as `web-push.ts`'s `keyBytes` accepts them: only
/// URL-safe base64 characters, exactly `length` bytes, and written as it
/// would be written again.
pub fn key_bytes(value: &str, length: usize) -> Option<Vec<u8>> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(value).ok()?;
    (bytes.len() == length && base64url(&bytes) == value).then_some(bytes)
}

/// A subscription's `p256dh`: an uncompressed point on P-256.
pub fn user_public_key(value: &str) -> Option<PublicKey> {
    let bytes = key_bytes(value, 65)?;
    if bytes[0] != 4 {
        return None;
    }
    PublicKey::from_sec1_bytes(&bytes).ok()
}

/// The uncompressed public key of a VAPID private key, base64url.
pub fn public_key_of(private_key: &[u8]) -> Option<String> {
    let secret = SecretKey::from_slice(private_key).ok()?;
    Some(base64url(
        secret.public_key().to_encoded_point(false).as_bytes(),
    ))
}

/// A new VAPID key pair (`webpush.generateVAPIDKeys()`): the public key
/// uncompressed, the private key 32 bytes.
pub fn generate_vapid_keys() -> (String, String) {
    let secret = SecretKey::random(&mut OsRng);
    let public = base64url(secret.public_key().to_encoded_point(false).as_bytes());
    (public, base64url(&secret.to_bytes()))
}

/// The `Authorization` header for `endpoint`'s push service.
pub fn vapid_authorization(
    audience: &str,
    subject: &str,
    public_key: &str,
    private_key: &[u8],
    now_ms: i64,
) -> Option<String> {
    let key = SigningKey::from_slice(private_key).ok()?;
    let header = base64url(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = serde_json::json!({
        "aud": audience,
        "exp": now_ms.div_euclid(1000) + VAPID_EXPIRATION_SECONDS,
        "sub": subject,
    });
    let claims = base64url(serde_json::to_string(&claims).ok()?.as_bytes());
    let input = format!("{header}.{claims}");
    let signature: Signature = key.sign(input.as_bytes());
    Some(format!(
        "vapid t={input}.{}, k={public_key}",
        base64url(&signature.to_bytes())
    ))
}

fn expand(prk: &Hkdf<Sha256>, info: &[&[u8]], length: usize) -> Vec<u8> {
    let mut out = vec![0; length];
    prk.expand_multi_info(info, &mut out)
        .expect("HKDF lengths are fixed");
    out
}

/// The content key and nonce of an aes128gcm message (RFC 8291 and 8188).
fn keys(
    shared: &[u8],
    auth: &[u8],
    user_public: &[u8],
    server_public: &[u8],
    salt: &[u8],
) -> (Vec<u8>, Vec<u8>) {
    let (_, key) = Hkdf::<Sha256>::extract(Some(auth), shared);
    let ikm = expand(&key, &[b"WebPush: info\0", user_public, server_public], 32);
    let (_, prk) = Hkdf::<Sha256>::extract(Some(salt), &ikm);
    (
        expand(&prk, &[b"Content-Encoding: aes128gcm\0"], 16),
        expand(&prk, &[b"Content-Encoding: nonce\0"], 12),
    )
}

fn record_nonce(base: &[u8], sequence: usize) -> [u8; 12] {
    let mut nonce = [0; 12];
    nonce.copy_from_slice(base);
    for (index, byte) in (sequence as u64).to_be_bytes().iter().enumerate() {
        nonce[4 + index] ^= byte;
    }
    nonce
}

/// `payload` encrypted for a subscription (`p256dh`, `auth`), with a fresh
/// key pair and salt: the request body.
pub fn encrypt(payload: &[u8], p256dh: &str, auth: &str) -> Option<Vec<u8>> {
    let user = user_public_key(p256dh)?;
    let auth = key_bytes(auth, 16)?;
    let server = SecretKey::random(&mut OsRng);
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    encrypt_with(payload, &user, &auth, &server, &salt)
}

/// [`encrypt`] with the server's key pair and salt given (tests).
pub fn encrypt_with(
    payload: &[u8],
    user: &PublicKey,
    auth: &[u8],
    server: &SecretKey,
    salt: &[u8; 16],
) -> Option<Vec<u8>> {
    let shared = p256::ecdh::diffie_hellman(server.to_nonzero_scalar(), user.as_affine());
    let user_bytes = user.to_encoded_point(false);
    let server_public = server.public_key().to_encoded_point(false);
    let (key, nonce) = keys(
        shared.raw_secret_bytes(),
        auth,
        user_bytes.as_bytes(),
        server_public.as_bytes(),
        salt,
    );
    let cipher = Aes128Gcm::new_from_slice(&key).ok()?;
    let mut body = Vec::with_capacity(payload.len() + 103);
    body.extend_from_slice(salt);
    body.extend_from_slice(&(RECORD_SIZE as u32).to_be_bytes());
    body.push(server_public.as_bytes().len() as u8);
    body.extend_from_slice(server_public.as_bytes());
    // Each record carries up to its size less the tag and the delimiter
    // (1 between records, 2 after the last).
    let chunk = RECORD_SIZE - 17;
    let mut start = 0;
    let mut sequence = 0;
    loop {
        let end = (start + chunk).min(payload.len());
        let last = end >= payload.len();
        let mut record = payload[start..end].to_vec();
        record.push(if last { 2 } else { 1 });
        let nonce = record_nonce(&nonce, sequence);
        body.extend(
            cipher
                .encrypt(Nonce::from_slice(&nonce), record.as_slice())
                .ok()?,
        );
        if last {
            return Some(body);
        }
        start = end;
        sequence += 1;
    }
}

/// An aes128gcm body decrypted with the subscription's private key and
/// auth secret (what a browser does; tests and the data checks).
pub fn decrypt(body: &[u8], user: &SecretKey, auth: &[u8]) -> Option<Vec<u8>> {
    let salt = body.get(..16)?;
    let size = u32::from_be_bytes(body.get(16..20)?.try_into().ok()?) as usize;
    let id_length = *body.get(20)? as usize;
    let server_public = body.get(21..21 + id_length)?;
    let server = PublicKey::from_sec1_bytes(server_public).ok()?;
    let shared = p256::ecdh::diffie_hellman(user.to_nonzero_scalar(), server.as_affine());
    let user_public = user.public_key().to_encoded_point(false);
    let (key, nonce) = keys(
        shared.raw_secret_bytes(),
        auth,
        user_public.as_bytes(),
        server_public,
        salt,
    );
    let cipher = Aes128Gcm::new_from_slice(&key).ok()?;
    let mut out = Vec::new();
    for (sequence, record) in body[21 + id_length..].chunks(size).enumerate() {
        let mut plain = cipher
            .decrypt(Nonce::from_slice(&record_nonce(&nonce, sequence)), record)
            .ok()?;
        let delimiter = plain.iter().rposition(|byte| *byte != 0)?;
        plain.truncate(delimiter);
        out.extend(plain);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::VerifyingKey;
    use p256::ecdsa::signature::Verifier;

    #[test]
    fn keys_are_read_as_web_push_ts_reads_them() {
        let (public, private) = generate_vapid_keys();
        assert_eq!(public.len(), 87);
        assert_eq!(private.len(), 43);
        let bytes = key_bytes(&private, 32).unwrap();
        assert_eq!(public_key_of(&bytes).unwrap(), public);
        assert!(user_public_key(&public).is_some());
        // Padding, the standard alphabet, a wrong length, a non-canonical
        // last character and a point off the curve are refused.
        assert!(key_bytes(&format!("{private}="), 32).is_none());
        assert!(key_bytes(&private.replace('-', "+"), 32).is_none() || !private.contains('-'));
        assert!(key_bytes("AAAA", 32).is_none());
        assert!(key_bytes("tlzmxLZhijjM_ioHQdti4x", 16).is_none());
        assert!(key_bytes("tlzmxLZhijjM_ioHQdti4w", 16).is_some());
        let mut off = vec![4u8];
        off.extend([1u8; 64]);
        assert!(user_public_key(&base64url(&off)).is_none());
    }

    #[test]
    fn a_message_round_trips_over_several_records() {
        let user = SecretKey::random(&mut OsRng);
        let public = base64url(user.public_key().to_encoded_point(false).as_bytes());
        let auth = base64url(&[7u8; 16]);
        for length in [0, 10, RECORD_SIZE - 17, RECORD_SIZE - 16, 10_000] {
            let payload: Vec<u8> = (0..length).map(|n| n as u8).collect();
            let body = encrypt(&payload, &public, &auth).unwrap();
            assert_eq!(
                decrypt(&body, &user, &[7u8; 16]).unwrap(),
                payload,
                "{length}"
            );
        }
    }

    #[test]
    fn the_vapid_jwt_is_es256_for_the_audience() {
        let (public, private) = generate_vapid_keys();
        let private = key_bytes(&private, 32).unwrap();
        let header = vapid_authorization(
            "https://fcm.googleapis.com",
            "mailto:a@b.c",
            &public,
            &private,
            1_700_000_000_999,
        )
        .unwrap();
        let (jwt, key) = header
            .strip_prefix("vapid t=")
            .unwrap()
            .split_once(", k=")
            .unwrap();
        assert_eq!(key, public);
        let parts: Vec<&str> = jwt.split('.').collect();
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(
            claims,
            serde_json::json!({ "aud": "https://fcm.googleapis.com", "exp": 1_700_043_200, "sub": "mailto:a@b.c" })
        );
        let verifying =
            VerifyingKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(&public).unwrap()).unwrap();
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap();
        verifying
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
    }
}
