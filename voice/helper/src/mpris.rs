//! Media players on the session bus (MPRIS): a YouTube video starting in a
//! call pauses the desktop's Spotify app (call/youtube.rs), with GIO's
//! D-Bus client, which the helper links already (gstreamer-net's).

use gst::glib;
use gst::glib::prelude::*;
use gst_net::gio;

const PLAYER_PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
/// How long a player may take to answer.
const TIMEOUT_MS: i32 = 2000;

/// The bus names among `names` that are `prefix`, or `prefix` and a dot
/// (an instance: `org.mpris.MediaPlayer2.spotify.instance1234`).
pub fn named<'a>(names: &'a [String], prefix: &str) -> Vec<&'a str> {
    names
        .iter()
        .map(String::as_str)
        .filter(|name| {
            *name == prefix
                || name
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with('.'))
        })
        .collect()
}

/// Pauses the players named `prefix` (see `named`) that play; answers the
/// names paused. No session bus, or a player not answering, pauses
/// nothing.
pub fn pause_playing(prefix: &str) -> Vec<String> {
    let bus = match gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>) {
        Ok(bus) => bus,
        Err(err) => {
            eprintln!("no session bus to pause {prefix}: {err}");
            return Vec::new();
        }
    };
    let call =
        |name: &str, path: &str, interface: &str, method: &str, args: Option<glib::Variant>| {
            bus.call_sync(
                Some(name),
                path,
                interface,
                method,
                args.as_ref(),
                None,
                gio::DBusCallFlags::NONE,
                TIMEOUT_MS,
                None::<&gio::Cancellable>,
            )
        };
    let names = call(
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "ListNames",
        None,
    )
    .ok()
    .and_then(|reply| reply.child_value(0).get::<Vec<String>>())
    .unwrap_or_default();
    let mut paused = Vec::new();
    for name in named(&names, prefix) {
        let status = call(
            name,
            PLAYER_PATH,
            "org.freedesktop.DBus.Properties",
            "Get",
            Some((PLAYER, "PlaybackStatus").to_variant()),
        )
        .ok()
        .and_then(|reply| reply.child_value(0).as_variant())
        .and_then(|status| status.get::<String>());
        if status.as_deref() != Some("Playing") {
            continue;
        }
        match call(name, PLAYER_PATH, PLAYER, "Pause", None) {
            Ok(_) => paused.push(name.to_string()),
            Err(err) => eprintln!("{name} did not pause: {err}"),
        }
    }
    paused
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prefix_names_the_player_and_its_instances_only() {
        let names: Vec<String> = [
            "org.mpris.MediaPlayer2.spotify",
            "org.mpris.MediaPlayer2.spotify.instance42",
            "org.mpris.MediaPlayer2.spotifyd",
            "org.mpris.MediaPlayer2.vlc",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            named(&names, "org.mpris.MediaPlayer2.spotify"),
            [
                "org.mpris.MediaPlayer2.spotify",
                "org.mpris.MediaPlayer2.spotify.instance42"
            ]
        );
        assert!(named(&names, "org.mpris.MediaPlayer2.roamgatetest").is_empty());
    }
}
