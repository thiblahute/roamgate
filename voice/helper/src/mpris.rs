//! Media players on the session bus (MPRIS): a YouTube video starting in a
//! call pauses the desktop's Spotify app (call/youtube.rs), and the log
//! tells what the players say when the call's music goes silent (main.rs),
//! with GIO's D-Bus client, which the helper links already (gstreamer-net's).

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

/// The session bus, as the players are asked on it.
struct Bus(gio::DBusConnection);

impl Bus {
    fn session() -> Result<Self, glib::Error> {
        gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>).map(Self)
    }

    fn call(
        &self,
        name: &str,
        path: &str,
        interface: &str,
        method: &str,
        args: Option<glib::Variant>,
    ) -> Result<glib::Variant, glib::Error> {
        self.0.call_sync(
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
    }

    /// The bus names now.
    fn names(&self) -> Vec<String> {
        self.call(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "ListNames",
            None,
        )
        .ok()
        .and_then(|reply| reply.child_value(0).get::<Vec<String>>())
        .unwrap_or_default()
    }

    /// A property of player `name`; None when it does not answer.
    fn property(&self, name: &str, property: &str) -> Option<glib::Variant> {
        self.call(
            name,
            PLAYER_PATH,
            "org.freedesktop.DBus.Properties",
            "Get",
            Some((PLAYER, property).to_variant()),
        )
        .ok()
        .and_then(|reply| reply.child_value(0).as_variant())
    }
}

/// Pauses the players named `prefix` (see `named`) that play; answers the
/// names paused. No session bus, or a player not answering, pauses
/// nothing.
pub fn pause_playing(prefix: &str) -> Vec<String> {
    let bus = match Bus::session() {
        Ok(bus) => bus,
        Err(err) => {
            eprintln!("no session bus to pause {prefix}: {err}");
            return Vec::new();
        }
    };
    let names = bus.names();
    let mut paused = Vec::new();
    for name in named(&names, prefix) {
        let status = bus
            .property(name, "PlaybackStatus")
            .and_then(|status| status.get::<String>());
        if status.as_deref() != Some("Playing") {
            continue;
        }
        match bus.call(name, PLAYER_PATH, PLAYER, "Pause", None) {
            Ok(_) => paused.push(name.to_string()),
            Err(err) => eprintln!("{name} did not pause: {err}"),
        }
    }
    paused
}

/// What the media players say now, for the log: "spotify Paused at 2:19,
/// vlc Playing at 0:42", a player's name without its bus prefix.
pub fn describe() -> String {
    let bus = match Bus::session() {
        Ok(bus) => bus,
        Err(err) => return format!("no session bus ({err})"),
    };
    let names = bus.names();
    let players: Vec<String> = named(&names, PLAYERS)
        .into_iter()
        .map(|name| {
            let status = bus
                .property(name, "PlaybackStatus")
                .and_then(|status| status.get::<String>());
            let position = bus
                .property(name, "Position")
                .and_then(|position| position.get::<i64>());
            player_state(name, status.as_deref(), position)
        })
        .collect();
    if players.is_empty() {
        "no media player".to_string()
    } else {
        players.join(", ")
    }
}

/// The bus name prefix of every MPRIS player.
const PLAYERS: &str = "org.mpris.MediaPlayer2";

/// One player's state as describe() tells it; `position` in microseconds.
fn player_state(name: &str, status: Option<&str>, position: Option<i64>) -> String {
    let short = name
        .strip_prefix(PLAYERS)
        .and_then(|rest| rest.strip_prefix('.'))
        .unwrap_or(name);
    let mut state = format!("{short} {}", status.unwrap_or("not answering"));
    if let Some(position) = position.filter(|position| *position >= 0) {
        let seconds = position / 1_000_000;
        state.push_str(&format!(" at {}:{:02}", seconds / 60, seconds % 60));
    }
    state
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
        assert_eq!(named(&names, PLAYERS).len(), 4);
    }

    #[test]
    fn a_player_is_told_by_its_short_name_status_and_position() {
        assert_eq!(
            player_state(
                "org.mpris.MediaPlayer2.spotify",
                Some("Paused"),
                Some(139_400_000)
            ),
            "spotify Paused at 2:19"
        );
        assert_eq!(
            player_state("org.mpris.MediaPlayer2.vlc.instance7", None, None),
            "vlc.instance7 not answering"
        );
    }
}
