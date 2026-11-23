//! cli/url.test.ts renderTerminalQr, against qrcode-generator's own
//! modules (golden.jsonl and rendered.txt were printed by Bun with the
//! library the TS CLI uses).

use super::*;

/// draws exactly the library's modules with a quiet zone
#[test]
fn draws_exactly_the_library_s_modules_with_a_quiet_zone() {
    let text = format!("http://192.168.1.20:8787/?token={}", "a".repeat(64));
    assert_eq!(render_terminal_qr(&text), include_str!("rendered.txt"));
    let rendered = render_terminal_qr(&text);
    let size = make_qr(&text).modules.len();
    let mut grid: Vec<Vec<bool>> = Vec::new();
    for line in rendered.split('\n') {
        let glyphs: Vec<char> = line
            .replace(COLORS, "")
            .replace(RESET, "")
            .chars()
            .collect();
        grid.push(
            glyphs
                .iter()
                .map(|g| *g == '\u{2588}' || *g == '\u{2580}')
                .collect(),
        );
        grid.push(
            glyphs
                .iter()
                .map(|g| *g == '\u{2588}' || *g == '\u{2584}')
                .collect(),
        );
    }
    let code = make_qr(&text);
    for row in -4..size as i32 + 4 {
        for col in -4..size as i32 + 4 {
            let inside = row >= 0 && col >= 0 && row < size as i32 && col < size as i32;
            let expected = inside && code.modules[row as usize][col as usize];
            assert_eq!(grid[(row + 4) as usize][(col + 4) as usize], expected);
        }
    }
    for line in include_str!("golden.jsonl").lines() {
        let entry: serde_json::Value = serde_json::from_str(line).unwrap();
        let text = entry["text"].as_str().unwrap();
        let modules: String = make_qr(text)
            .modules
            .iter()
            .map(|row| {
                row.iter()
                    .map(|dark| if *dark { '1' } else { '0' })
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("/");
        assert_eq!(modules, entry["modules"].as_str().unwrap(), "{text}");
    }
}
