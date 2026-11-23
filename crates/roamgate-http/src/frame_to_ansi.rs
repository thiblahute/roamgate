//! A Herdr wire frame's cell grid serialized as ANSI bytes for xterm.js
//! (bridge/frame-to-ansi.ts): the stable endpoint path delivers
//! server-rendered cells instead of an ANSI stream, so the bridge
//! re-encodes them, as a full repaint per frame.

use serde::Deserialize;
use unicode_width::UnicodeWidthStr;

const RESET: &str = "\x1b[0m";

// ratatui Modifier bits (plus Herdr underline-style extension in bits 12-15).
const MOD_BOLD: u32 = 0x0001;
const MOD_DIM: u32 = 0x0002;
const MOD_ITALIC: u32 = 0x0004;
const MOD_UNDERLINED: u32 = 0x0008;
const MOD_BLINK: u32 = 0x0010 | 0x0020;
const MOD_REVERSED: u32 = 0x0040;
const MOD_HIDDEN: u32 = 0x0080;
const MOD_CROSSED_OUT: u32 = 0x0100;
const UNDERLINE_STYLE_SHIFT: u32 = 12;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CellData {
    pub symbol: String,
    pub fg: u32,
    pub bg: u32,
    pub modifier: u32,
    pub skip: bool,
    pub hyperlink: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CursorData {
    pub x: usize,
    pub y: usize,
    pub visible: bool,
    pub shape: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FrameData {
    pub cells: Vec<CellData>,
    pub width: usize,
    pub height: usize,
    pub cursor: Option<CursorData>,
    #[serde(default)]
    pub hyperlinks: Vec<String>,
}

/// The viewer's size, when it is smaller than the frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Viewport {
    pub cols: usize,
    pub rows: usize,
}

fn sgr_color(packed: u32, foreground: bool) -> String {
    let kind = packed >> 24;
    let value = packed & 0x00ff_ffff;
    if kind == 0x00 {
        if value == 0 {
            return if foreground { "39" } else { "49" }.into();
        }
        if value <= 8 {
            return ((if foreground { 30 } else { 40 }) + value - 1).to_string();
        }
        return ((if foreground { 90 } else { 100 }) + value - 9).to_string();
    }
    if kind == 0x01 {
        return format!("{};5;{}", if foreground { 38 } else { 48 }, value & 0xff);
    }
    let (r, g, b) = ((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
    format!("{};2;{r};{g};{b}", if foreground { 38 } else { 48 })
}

fn sgr_style(cell: &CellData) -> String {
    let mut codes: Vec<String> = Vec::new();
    let modifier = cell.modifier;
    if modifier & MOD_BOLD != 0 {
        codes.push("1".into());
    }
    if modifier & MOD_DIM != 0 {
        codes.push("2".into());
    }
    if modifier & MOD_ITALIC != 0 {
        codes.push("3".into());
    }
    if modifier & MOD_UNDERLINED != 0 {
        let style = (modifier & 0xf000) >> UNDERLINE_STYLE_SHIFT;
        codes.push(if (1..=5).contains(&style) {
            format!("4:{style}")
        } else {
            "4".into()
        });
    }
    if modifier & MOD_BLINK != 0 {
        codes.push("5".into());
    }
    if modifier & MOD_REVERSED != 0 {
        codes.push("7".into());
    }
    if modifier & MOD_HIDDEN != 0 {
        codes.push("8".into());
    }
    if modifier & MOD_CROSSED_OUT != 0 {
        codes.push("9".into());
    }
    codes.push(sgr_color(cell.fg, true));
    codes.push(sgr_color(cell.bg, false));
    format!("\x1b[{}m", codes.join(";"))
}

fn style_key(cell: &CellData) -> (u32, u32, u32, Option<usize>) {
    (cell.fg, cell.bg, cell.modifier, cell.hyperlink)
}

fn is_default_blank(cell: &CellData) -> bool {
    cell.symbol == " "
        && cell.fg == 0
        && cell.bg == 0
        && cell.modifier == 0
        && cell.hyperlink.is_none()
}

/// `Bun.stringWidth` of a cell's grapheme: wide and emoji graphemes count
/// two columns, combining marks none.
pub fn string_width(text: &str) -> usize {
    text.width()
}

/// One frame as a full repaint: home, styled rows, cursor.
pub fn frame_to_ansi(frame: &FrameData, viewport: Option<Viewport>) -> String {
    let viewport = viewport.unwrap_or(Viewport {
        cols: frame.width,
        rows: frame.height,
    });
    let width = frame.width.min(viewport.cols);
    let height = frame.height.min(viewport.rows);
    // Frames are positioned cell grids, not flowing text. A stale frame can
    // exceed the viewer width during resize; never let it wrap and scroll.
    let mut out = format!("{RESET}\x1b[H\x1b[2J\x1b[?7l");
    let blank = CellData {
        symbol: " ".into(),
        fg: 0,
        bg: 0,
        modifier: 0,
        skip: false,
        hyperlink: None,
    };
    let cell_at = |index: usize| frame.cells.get(index).unwrap_or(&blank);
    for y in 0..height {
        if y > 0 {
            out.push_str(&format!("\x1b[{};1H", y + 1));
        }
        let row_start = y * frame.width;
        let mut row_end = width;
        // Trim trailing default blanks; the terminal background fills them.
        while row_end > 0 && is_default_blank(cell_at(row_start + row_end - 1)) {
            row_end -= 1;
        }
        let mut last_style = None;
        let mut link_open = false;
        let mut x = 0;
        while x < row_end {
            let cell = cell_at(row_start + x);
            if cell.skip {
                x += 1;
                continue;
            }
            let cell_width = string_width(&cell.symbol);
            if x + cell_width > width {
                break;
            }
            let key = style_key(cell);
            if last_style != Some(key) {
                if link_open {
                    out.push_str("\x1b]8;;\x1b\\");
                    link_open = false;
                }
                out.push_str(RESET);
                out.push_str(&sgr_style(cell));
                if let Some(uri) = cell.hyperlink.and_then(|link| frame.hyperlinks.get(link)) {
                    out.push_str(&format!("\x1b]8;;{uri}\x1b\\"));
                    link_open = true;
                }
                last_style = Some(key);
            }
            out.push_str(&cell.symbol);
            // Herdr's wide-character padding is often a normal blank (skip=false).
            let padding = cell_width.saturating_sub(1);
            x += padding;
            // xterm can render the same grapheme narrower; anchor the next source cell.
            if padding > 0 && x + 1 < row_end {
                out.push_str(&format!("\x1b[{}G", x + 2));
            }
            x += 1;
        }
        if link_open {
            out.push_str("\x1b]8;;\x1b\\");
        }
    }
    out.push_str("\x1b[?7h");
    match &frame.cursor {
        Some(cursor) if cursor.x < width && cursor.y < height => {
            // Hidden cursors still anchor xterm's IME composition and candidate window.
            out.push_str(&format!("{RESET}\x1b[{};{}H", cursor.y + 1, cursor.x + 1));
            if cursor.visible {
                out.push_str(&format!("\x1b[{} q\x1b[?25h", cursor.shape));
            } else {
                out.push_str("\x1b[?25l");
            }
        }
        _ => out.push_str("\x1b[?25l"),
    }
    out
}

#[cfg(test)]
mod tests {
    use roamgate_protocol::vectors;

    use super::*;

    /// contract/vectors/frame-to-ansi.json, every case.
    #[test]
    fn frame_to_ansi_vectors() {
        let file = vectors::load("frame-to-ansi");
        assert!(!file.cases.is_empty());
        for case in &file.cases {
            for call in &case.calls {
                assert_eq!(
                    call.target(),
                    "frame-to-ansi.frameToAnsi",
                    "{}",
                    case.title()
                );
                let frame: FrameData = serde_json::from_value(call.args[0].clone()).unwrap();
                let viewport = call.args.get(1).map(|value| Viewport {
                    cols: value["cols"].as_u64().unwrap() as usize,
                    rows: value["rows"].as_u64().unwrap() as usize,
                });
                let expected = vectors::text(call.result.as_ref().unwrap()).unwrap();
                assert_eq!(
                    frame_to_ansi(&frame, viewport),
                    expected,
                    "{}",
                    case.title()
                );
            }
        }
    }

    #[test]
    fn a_narrower_viewport_cuts_rows_columns_and_the_cursor() {
        let cell = |symbol: &str| CellData {
            symbol: symbol.into(),
            fg: 0,
            bg: 0,
            modifier: 0,
            skip: false,
            hyperlink: None,
        };
        let frame = FrameData {
            cells: ["a", "b", "c", "d"].map(cell).to_vec(),
            width: 2,
            height: 2,
            cursor: Some(CursorData {
                x: 1,
                y: 1,
                visible: true,
                shape: 2,
            }),
            hyperlinks: vec![],
        };
        assert_eq!(
            frame_to_ansi(&frame, Some(Viewport { cols: 1, rows: 1 })),
            "\x1b[0m\x1b[H\x1b[2J\x1b[?7l\x1b[0m\x1b[39;49ma\x1b[?7h\x1b[?25l"
        );
    }
}
