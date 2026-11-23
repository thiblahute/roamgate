//! The host's external addresses and their changes
//! (server/src/connections/network-watch.ts): a change (Wi-Fi back, a VPN
//! up) runs pending SSH retries at once. Polled, every 5 s by default.

use std::sync::Arc;
use std::time::Duration;

use roamgate_base::clock::SharedClock;

/// One address of an interface, as Node's `networkInterfaces` gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterfaceAddress {
    pub name: String,
    /// `IPv4` or `IPv6`.
    pub family: &'static str,
    pub address: String,
    pub internal: bool,
}

pub type InterfaceReader = Arc<dyn Fn() -> Result<Vec<InterfaceAddress>, String> + Send + Sync>;

/// This machine's interfaces.
pub fn system_interfaces() -> Result<Vec<InterfaceAddress>, String> {
    let interfaces = if_addrs::get_if_addrs().map_err(|error| error.to_string())?;
    Ok(interfaces
        .into_iter()
        .map(|interface| {
            let ip = interface.ip();
            InterfaceAddress {
                internal: interface.is_loopback(),
                family: if ip.is_ipv4() { "IPv4" } else { "IPv6" },
                address: ip.to_string(),
                name: interface.name,
            }
        })
        .collect())
}

/// The external addresses, `name|family|address`, sorted and joined by `,`.
pub fn network_fingerprint(read: &InterfaceReader) -> Result<String, String> {
    let mut addresses: Vec<String> = read()?
        .into_iter()
        .filter(|entry| !entry.internal)
        .map(|entry| format!("{}|{}|{}", entry.name, entry.family, entry.address))
        .collect();
    addresses.sort();
    Ok(addresses.join(","))
}

/// Calls `on_change` when the external addresses change; the returned
/// handle stops watching when dropped or aborted.
pub fn watch_network_changes(
    clock: SharedClock,
    on_change: Arc<dyn Fn() + Send + Sync>,
    interval: Duration,
    read: InterfaceReader,
) -> tokio::task::JoinHandle<()> {
    let mut last = network_fingerprint(&read).ok();
    tokio::spawn(async move {
        let mut ticks = clock.interval(interval);
        loop {
            ticks.tick().await;
            let Ok(current) = network_fingerprint(&read) else {
                continue;
            };
            if last.as_deref() == Some(current.as_str()) {
                continue;
            }
            last = Some(current);
            on_change();
        }
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use roamgate_base::clock::TokioClock;

    use super::*;

    fn iface(name: &str, address: &str, internal: bool) -> InterfaceAddress {
        InterfaceAddress {
            name: name.into(),
            family: "IPv4",
            address: address.into(),
            internal,
        }
    }

    #[test]
    fn fingerprints_only_external_addresses_in_a_stable_order() {
        let a: InterfaceReader = Arc::new(|| {
            Ok(vec![
                iface("lo0", "127.0.0.1", true),
                iface("en0", "192.168.1.2", false),
                iface("utun1", "10.0.0.2", false),
            ])
        });
        let b: InterfaceReader = Arc::new(|| {
            Ok(vec![
                iface("utun1", "10.0.0.2", false),
                iface("en0", "192.168.1.2", false),
            ])
        });
        assert_eq!(network_fingerprint(&a), network_fingerprint(&b));
        assert!(!network_fingerprint(&a).unwrap().contains("127.0.0.1"));
    }

    #[tokio::test(start_paused = true)]
    async fn reports_a_change_of_addresses_once_not_every_poll() {
        let current = Arc::new(Mutex::new(vec![iface("lo0", "127.0.0.1", true)]));
        let seen = current.clone();
        let read: InterfaceReader = Arc::new(move || Ok(seen.lock().unwrap().clone()));
        let changes = Arc::new(AtomicUsize::new(0));
        let counter = changes.clone();
        let clock: SharedClock = Arc::new(TokioClock::starting_at(0));
        let watch = watch_network_changes(
            clock,
            Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
            Duration::from_millis(1000),
            read,
        );
        tokio::time::sleep(Duration::from_millis(3000)).await;
        assert_eq!(changes.load(Ordering::SeqCst), 0);
        current
            .lock()
            .unwrap()
            .push(iface("en0", "192.168.1.2", false));
        tokio::time::sleep(Duration::from_millis(3000)).await;
        assert_eq!(changes.load(Ordering::SeqCst), 1);
        watch.abort();
        current.lock().unwrap().clear();
        tokio::time::sleep(Duration::from_millis(3000)).await;
        assert_eq!(changes.load(Ordering::SeqCst), 1);
    }
}
