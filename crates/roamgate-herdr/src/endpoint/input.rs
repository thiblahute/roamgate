//! Browser VT input (what xterm.js emits from key events) classified into
//! Herdr's stable semantic pane-input events, and encoded as
//! `ClientShellPaneInput` frames for the endpoint path
//! (bridge/vt-input-classifier.ts).
//!
//! Covers the common key space: printable text, Enter, Backspace, Tab,
//! arrows, Home, End, Insert, Delete, PageUp, PageDown, F1 to F12,
//! Ctrl+letter, Alt+char, modified CSI keys, bracketed paste and SGR cell
//! mouse reports. Basic CSI-u disambiguates printable ASCII and common
//! modified keys; full Kitty keyboard protocol extensions and pixel mouse
//! are not supported.

use crate::thin::BinWriter;

// crossterm KeyModifiers bits used on the wire.
pub const MOD_SHIFT: u8 = 0x1;
pub const MOD_CONTROL: u8 = 0x2;
pub const MOD_ALT: u8 = 0x4;
pub const MOD_SUPER: u8 = 0x8;

/// ClientKeyCode variant indices (frozen wire order).
pub mod key {
    pub const BACKSPACE: u64 = 0;
    pub const ENTER: u64 = 1;
    pub const LEFT: u64 = 2;
    pub const RIGHT: u64 = 3;
    pub const UP: u64 = 4;
    pub const DOWN: u64 = 5;
    pub const HOME: u64 = 6;
    pub const END: u64 = 7;
    pub const PAGE_UP: u64 = 8;
    pub const PAGE_DOWN: u64 = 9;
    pub const TAB: u64 = 10;
    pub const BACK_TAB: u64 = 11;
    pub const DELETE: u64 = 12;
    pub const INSERT: u64 = 13;
    pub const ESC: u64 = 14;
    pub const CHAR: u64 = 15;
    pub const F: u64 = 16;
}

/// Herdr v0.9.0 src/protocol/wire.rs (endpoint generation 1 frozen order).
pub mod mouse_kind {
    pub const DOWN: u64 = 0;
    pub const UP: u64 = 1;
    pub const DRAG: u64 = 2;
    pub const MOVED: u64 = 3;
    pub const SCROLL_UP: u64 = 4;
    pub const SCROLL_DOWN: u64 = 5;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MouseEvent {
    pub kind: u64,
    /// ClientMouseButton: Left 0, Right 1, Middle 2 (Down, Up and Drag).
    pub button: Option<u64>,
    /// Zero-based, relative to the cropped pane content.
    pub column: u64,
    pub row: u64,
    pub modifiers: u8,
    pub lines: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneInputEvent {
    Mouse(MouseEvent),
    Key {
        code: u64,
        /// The code point of a `CHAR` key.
        char: Option<u64>,
        /// The number of an `F` key.
        function: Option<u64>,
        modifiers: u8,
    },
    Text(String),
    Paste(String),
}

/// Events as one ClientShellPaneInput frame payload (variant 13).
pub fn encode_pane_input(pane_id: &str, events: &[PaneInputEvent]) -> Vec<u8> {
    let mut writer = BinWriter::new();
    writer.variant(13); // ClientMessage::ClientShellPaneInput
    writer.string(pane_id);
    writer.varint(events.len() as u64);
    for event in events {
        match event {
            PaneInputEvent::Key {
                code,
                char,
                function,
                modifiers,
            } => {
                writer.variant(0); // ClientPaneInputEvent::Key
                writer.variant(*code);
                if *code == key::CHAR {
                    writer.varint(char.unwrap_or(0));
                }
                if *code == key::F {
                    writer.varint(function.unwrap_or(1));
                }
                writer.u8(*modifiers);
                writer.variant(0); // ClientKeyKind::Press
                writer.varint(1); // repeat_count
                writer.bool(false); // shifted_codepoint: None
                writer.bool(false); // generated text: None
                writer.bool(false); // tracks_release
                writer.bool(false); // physical_key_id: None
                writer.bool(false); // windows_record: None
            }
            PaneInputEvent::Mouse(mouse) => {
                writer.variant(2); // ClientPaneInputEvent::Mouse
                writer.variant(mouse.kind);
                if mouse.kind <= mouse_kind::DRAG {
                    writer.variant(mouse.button.unwrap_or(0));
                }
                writer.variant(0); // ClientMousePosition::Cell
                writer.varint(mouse.column);
                writer.varint(mouse.row);
                writer.bool(false); // geometry: None (only needed for pixels)
                writer.u8(mouse.modifiers);
                writer.varint(mouse.lines);
            }
            PaneInputEvent::Text(text) => {
                writer.variant(1); // ClientPaneInputEvent::TextCommit
                writer.string(text);
            }
            PaneInputEvent::Paste(text) => {
                writer.variant(3); // ClientPaneInputEvent::Paste
                writer.string(text);
            }
        }
    }
    writer.into_bytes()
}

fn key_event(code: u64, modifiers: u8) -> PaneInputEvent {
    PaneInputEvent::Key {
        code,
        char: None,
        function: None,
        modifiers,
    }
}

fn char_key(char: u64, modifiers: u8) -> PaneInputEvent {
    PaneInputEvent::Key {
        code: key::CHAR,
        char: Some(char),
        function: None,
        modifiers,
    }
}

fn function_key(number: u64, modifiers: u8) -> PaneInputEvent {
    PaneInputEvent::Key {
        code: key::F,
        char: None,
        function: Some(number),
        modifiers,
    }
}

fn csi_final_key(byte: u8) -> Option<u64> {
    Some(match byte {
        b'A' => key::UP,
        b'B' => key::DOWN,
        b'C' => key::RIGHT,
        b'D' => key::LEFT,
        b'H' => key::HOME,
        b'F' => key::END,
        b'Z' => key::BACK_TAB,
        _ => return None,
    })
}

fn csi_function_final(byte: u8) -> Option<u64> {
    Some(match byte {
        b'P' => 1,
        b'Q' => 2,
        b'R' => 3,
        b'S' => 4,
        _ => return None,
    })
}

/// `n in CSI_TILDE_KEYS`: an integral parameter only.
fn csi_tilde_key(n: f64) -> Option<u64> {
    Some(match n {
        1.0 | 7.0 => key::HOME,
        2.0 => key::INSERT,
        3.0 => key::DELETE,
        4.0 | 8.0 => key::END,
        5.0 => key::PAGE_UP,
        6.0 => key::PAGE_DOWN,
        _ => return None,
    })
}

fn csi_tilde_function(n: f64) -> Option<u64> {
    Some(match n {
        11.0 => 1,
        12.0 => 2,
        13.0 => 3,
        14.0 => 4,
        15.0 => 5,
        17.0 => 6,
        18.0 => 7,
        19.0 => 8,
        20.0 => 9,
        21.0 => 10,
        23.0 => 11,
        24.0 => 12,
        _ => return None,
    })
}

fn ss3_key(byte: u8) -> Option<PaneInputEvent> {
    Some(match byte {
        b'A' => key_event(key::UP, 0),
        b'B' => key_event(key::DOWN, 0),
        b'C' => key_event(key::RIGHT, 0),
        b'D' => key_event(key::LEFT, 0),
        b'H' => key_event(key::HOME, 0),
        b'F' => key_event(key::END, 0),
        b'P' => function_key(1, 0),
        b'Q' => function_key(2, 0),
        b'R' => function_key(3, 0),
        b'S' => function_key(4, 0),
        _ => return None,
    })
}

/// JavaScript's ToInt32 of a number (NaN is 0).
fn int32(value: f64) -> i64 {
    if value.is_finite() {
        value.trunc() as i64
    } else {
        0
    }
}

/// xterm modifier param (1+bits: shift 1, alt 2, ctrl 4, super 8) to
/// crossterm bits.
fn xterm_modifiers(param: f64) -> u8 {
    let bits = if param.is_nan() {
        0
    } else {
        int32((param - 1.0).max(0.0))
    };
    let mut modifiers = 0;
    if bits & 1 != 0 {
        modifiers |= MOD_SHIFT;
    }
    if bits & 2 != 0 {
        modifiers |= MOD_ALT;
    }
    if bits & 4 != 0 {
        modifiers |= MOD_CONTROL;
    }
    if bits & 8 != 0 {
        modifiers |= MOD_SUPER;
    }
    modifiers
}

/// A control byte 0x00 to 0x1f (or DEL) as a key, None when handled
/// elsewhere.
fn control_byte_key(byte: u8) -> Option<PaneInputEvent> {
    Some(match byte {
        0x0d => key_event(key::ENTER, 0),
        0x09 => key_event(key::TAB, 0),
        0x7f => key_event(key::BACKSPACE, 0),
        0x08 => char_key(0x68, MOD_CONTROL), // ctrl+h
        0x01..=0x1a => char_key(0x60 + u64::from(byte), MOD_CONTROL),
        0x00 => char_key(0x20, MOD_CONTROL), // ctrl+space
        // ctrl+\ ctrl+] ctrl+^ ctrl+_
        0x1c..=0x1f => char_key(
            [0x5c, 0x5d, 0x5e, 0x5f][usize::from(byte - 0x1c)],
            MOD_CONTROL,
        ),
        _ => return None,
    })
}

fn utf8_length(first: u8) -> usize {
    match first {
        0..0x80 => 1,
        0xf0.. => 4,
        0xe0.. => 3,
        0xc0.. => 2,
        // A stray continuation byte: a single one.
        _ => 1,
    }
}

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

/// `Number(p)` of a CSI parameter (`""` is 1).
fn csi_number(parameter: &str) -> f64 {
    if parameter.is_empty() {
        return 1.0;
    }
    let trimmed = parameter.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// Keeps what an input chunk left incomplete for the next one.
#[derive(Debug, Default)]
pub struct VtInputClassifier {
    pending: Vec<u8>,
}

impl VtInputClassifier {
    pub fn new() -> Self {
        Self::default()
    }

    /// One browser input chunk: its complete events.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<PaneInputEvent> {
        self.pending.extend_from_slice(chunk);
        let buffer = std::mem::take(&mut self.pending);
        let mut events = Vec::new();
        let mut text = String::new();
        let flush_text = |text: &mut String, events: &mut Vec<PaneInputEvent>| {
            if !text.is_empty() {
                events.push(PaneInputEvent::Text(std::mem::take(text)));
            }
        };
        let mut i = 0;
        while i < buffer.len() {
            let byte = buffer[i];
            if byte == 0x1b {
                if buffer[i..].starts_with(PASTE_START) {
                    let Some(end) = find(&buffer, PASTE_END, i + PASTE_START.len()) else {
                        break; // the rest of the paste is still to come
                    };
                    flush_text(&mut text, &mut events);
                    events.push(PaneInputEvent::Paste(
                        String::from_utf8_lossy(&buffer[i + PASTE_START.len()..end]).into_owned(),
                    ));
                    i = end + PASTE_END.len();
                    continue;
                }
                let Some((parsed, next)) = parse_escape(&buffer, i) else {
                    break; // incomplete: wait for more bytes
                };
                flush_text(&mut text, &mut events);
                events.extend(parsed);
                i = next;
                continue;
            }
            if byte < 0x20 || byte == 0x7f {
                if let Some(event) = control_byte_key(byte) {
                    flush_text(&mut text, &mut events);
                    events.push(event);
                }
                i += 1;
                continue;
            }
            let length = utf8_length(byte);
            if i + length > buffer.len() {
                break; // an incomplete UTF-8 character
            }
            text.push_str(&String::from_utf8_lossy(&buffer[i..i + length]));
            i += length;
        }
        flush_text(&mut text, &mut events);
        self.pending = buffer[i..].to_vec();
        events
    }

    /// A lone ESC as the Esc key (after a short idle timeout).
    pub fn flush(&mut self) -> Vec<PaneInputEvent> {
        if self.pending == [0x1b] {
            self.pending.clear();
            return vec![key_event(key::ESC, 0)];
        }
        Vec::new()
    }
}

/// One escape sequence at `buffer[i]` (an ESC): its events and where the
/// next input starts, or None while it is incomplete.
fn parse_escape(buffer: &[u8], i: usize) -> Option<(Vec<PaneInputEvent>, usize)> {
    if i + 1 >= buffer.len() {
        return None; // a lone ESC so far
    }
    let second = buffer[i + 1];
    if second == 0x5b && buffer.get(i + 2) == Some(&0x3c) {
        // Malformed SGR mouse fields stay out of the text and key path
        // too. A new ESC cancels a truncated report, reprocessed alone.
        let mut j = i + 3;
        while j < buffer.len() && !(0x40..=0x7e).contains(&buffer[j]) {
            if buffer[j] == 0x1b {
                return Some((Vec::new(), j));
            }
            j += 1;
        }
        if j >= buffer.len() {
            return None;
        }
        let params = String::from_utf8_lossy(&buffer[i + 2..j]);
        let event = parse_sgr_mouse(&params, buffer[j]);
        return Some((
            event.map(PaneInputEvent::Mouse).into_iter().collect(),
            j + 1,
        ));
    }
    if second == 0x5b {
        // CSI: ESC [ params final
        let mut j = i + 2;
        while j < buffer.len() && (0x30..=0x3f).contains(&buffer[j]) {
            j += 1;
        }
        if j >= buffer.len() {
            return None;
        }
        let last = buffer[j];
        if !(0x40..=0x7e).contains(&last) {
            // Not a valid CSI final: the ESC goes.
            return Some((vec![key_event(key::ESC, 0)], i + 1));
        }
        let raw: String = buffer[i + 2..j].iter().map(|&b| b as char).collect();
        let params: Vec<f64> = raw.split(';').map(csi_number).collect();
        let next = j + 1;
        let first = params.first().copied().unwrap_or(1.0);
        let second_param = params.get(1).copied().unwrap_or(1.0);
        if last == b'~' {
            let modifiers = xterm_modifiers(second_param);
            if let Some(code) = csi_tilde_key(first) {
                return Some((vec![key_event(code, modifiers)], next));
            }
            if let Some(number) = csi_tilde_function(first) {
                return Some((vec![function_key(number, modifiers)], next));
            }
            return Some((Vec::new(), next)); // an unknown ~ sequence: swallowed
        }
        if let Some(code) = csi_final_key(last) {
            return Some((vec![key_event(code, xterm_modifiers(second_param))], next));
        }
        if let Some(number) = csi_function_final(last)
            && first == 1.0
        {
            return Some((
                vec![function_key(number, xterm_modifiers(second_param))],
                next,
            ));
        }
        // TerminalView and custom mobile keys use basic CSI-u where legacy
        // control bytes lose key identity or modifiers: bounded to the
        // supported named keys and printable ASCII, not full Kitty events.
        if last == b'u' && params.len() <= 2 {
            let codepoint = first;
            let modifier = second_param;
            let named = match codepoint {
                9.0 => Some(key::TAB),
                13.0 => Some(key::ENTER),
                27.0 => Some(key::ESC),
                127.0 => Some(key::BACKSPACE),
                _ => None,
            };
            let integral = |value: f64| value.is_finite() && value.fract() == 0.0;
            if integral(codepoint)
                && (named.is_some() || (32.0..=126.0).contains(&codepoint))
                && integral(modifier)
                && (1.0..=16.0).contains(&modifier)
            {
                let modifiers = xterm_modifiers(modifier);
                let event = match named {
                    Some(code) => key_event(code, modifiers),
                    None => char_key(codepoint as u64, modifiers),
                };
                return Some((vec![event], next));
            }
        }
        return Some((Vec::new(), next)); // an unknown CSI: swallowed
    }
    if second == 0x4f {
        // SS3: ESC O final
        let last = *buffer.get(i + 2)?;
        return Some((ss3_key(last).into_iter().collect(), i + 3));
    }
    if second == 0x1b {
        // Two ESCs: the first is a real Esc, the second processed again.
        return Some((vec![key_event(key::ESC, 0)], i + 1));
    }
    // ESC and a printable character: Alt+char.
    let length = utf8_length(second);
    if i + 1 + length > buffer.len() {
        return None;
    }
    if second >= 0x20 && second != 0x7f {
        let text = String::from_utf8_lossy(&buffer[i + 1..i + 1 + length]);
        let char = text.chars().next().map(u64::from).unwrap_or(0xfffd);
        return Some((vec![char_key(char, MOD_ALT)], i + 1 + length));
    }
    // xterm writes Alt+Backspace and Alt+Ctrl combinations as ESC before
    // the ordinary control byte, as it does for printable characters.
    if let Some(PaneInputEvent::Key {
        code,
        char,
        function,
        modifiers,
    }) = control_byte_key(second)
    {
        return Some((
            vec![PaneInputEvent::Key {
                code,
                char,
                function,
                modifiers: modifiers | MOD_ALT,
            }],
            i + 2,
        ));
    }
    Some((vec![key_event(key::ESC, 0)], i + 1))
}

/// An SGR cell mouse report (explicitly negotiated by the endpoint
/// frontend).
fn parse_sgr_mouse(params: &str, last: u8) -> Option<MouseEvent> {
    if last != b'M' && last != b'm' {
        return None;
    }
    let fields: Vec<&str> = params.strip_prefix('<')?.split(';').collect();
    if fields.len() != 3
        || fields
            .iter()
            .any(|field| field.is_empty() || !field.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let number = |field: &str| field.parse::<f64>().unwrap_or(f64::INFINITY);
    let (code, x, y) = (number(fields[0]), number(fields[1]), number(fields[2]));
    if !(0.0..=127.0).contains(&code)
        || !(1.0..=65536.0).contains(&x)
        || !(1.0..=65536.0).contains(&y)
    {
        return None;
    }
    let code = code as u64;
    let button = code & 3;
    let motion = code & 32 != 0;
    let wheel = code & 64 != 0;
    // Wheel releases, wheel motion and anonymous button releases are not
    // SGR events.
    if (wheel && (motion || last == b'm'))
        || (!wheel && ((motion && last == b'm') || (!motion && button == 3)))
    {
        return None;
    }
    let mut modifiers = 0;
    if code & 4 != 0 {
        modifiers |= MOD_SHIFT;
    }
    if code & 8 != 0 {
        modifiers |= MOD_ALT;
    }
    if code & 16 != 0 {
        modifiers |= MOD_CONTROL;
    }
    let kind = if wheel {
        mouse_kind::SCROLL_UP + button
    } else if motion {
        if button == 3 {
            mouse_kind::MOVED
        } else {
            mouse_kind::DRAG
        }
    } else if last == b'm' {
        mouse_kind::UP
    } else {
        mouse_kind::DOWN
    };
    Some(MouseEvent {
        kind,
        button: (kind <= mouse_kind::DRAG).then(|| [0, 2, 1][button as usize]),
        column: x as u64 - 1,
        row: y as u64 - 1,
        modifiers,
        lines: 1,
    })
}
