//! The terminal QR code of `roamgate url --qr` (cli/qr.ts), with the
//! modules of qrcode-generator 2.0.4 (Kazuhiko Arase, MIT): its version
//! search, Reed-Solomon blocks and its own mask penalty, so the drawing is
//! the one the Bun CLI prints. Only what `qrcode(0, "M")` with one Byte
//! segment uses is here.

const QUIET_ZONE: i32 = 4;
/// 256-color black on white keeps the code scannable on dark themes.
const COLORS: &str = "\x1b[38;5;16;48;5;231m";
const RESET: &str = "\x1b[0m";

/// The error correction level M as the library numbers it.
const LEVEL_M: u32 = 0;
const MODE_8BIT_BYTE: u32 = 1 << 2;
const PAD0: u32 = 0xEC;
const PAD1: u32 = 0x11;

const PATTERN_POSITION_TABLE: [&[usize]; 40] = [
    &[],
    &[6, 18],
    &[6, 22],
    &[6, 26],
    &[6, 30],
    &[6, 34],
    &[6, 22, 38],
    &[6, 24, 42],
    &[6, 26, 46],
    &[6, 28, 50],
    &[6, 30, 54],
    &[6, 32, 58],
    &[6, 34, 62],
    &[6, 26, 46, 66],
    &[6, 26, 48, 70],
    &[6, 26, 50, 74],
    &[6, 30, 54, 78],
    &[6, 30, 56, 82],
    &[6, 30, 58, 86],
    &[6, 34, 62, 90],
    &[6, 28, 50, 72, 94],
    &[6, 26, 50, 74, 98],
    &[6, 30, 54, 78, 102],
    &[6, 28, 54, 80, 106],
    &[6, 32, 58, 84, 110],
    &[6, 30, 58, 86, 114],
    &[6, 34, 62, 90, 118],
    &[6, 26, 50, 74, 98, 122],
    &[6, 30, 54, 78, 102, 126],
    &[6, 26, 52, 78, 104, 130],
    &[6, 30, 56, 82, 108, 134],
    &[6, 34, 60, 86, 112, 138],
    &[6, 30, 58, 86, 114, 142],
    &[6, 34, 62, 90, 118, 146],
    &[6, 30, 54, 78, 102, 126, 150],
    &[6, 24, 50, 76, 102, 128, 154],
    &[6, 28, 54, 80, 106, 132, 158],
    &[6, 32, 58, 84, 110, 136, 162],
    &[6, 26, 54, 82, 110, 138, 166],
    &[6, 30, 58, 86, 114, 142, 170],
];

/// The level M rows of RS_BLOCK_TABLE: (count, total, data) groups.
const RS_BLOCKS_M: [&[u32]; 40] = [
    &[1, 26, 16],
    &[1, 44, 28],
    &[1, 70, 44],
    &[2, 50, 32],
    &[2, 67, 43],
    &[4, 43, 27],
    &[4, 49, 31],
    &[2, 60, 38, 2, 61, 39],
    &[3, 58, 36, 2, 59, 37],
    &[4, 69, 43, 1, 70, 44],
    &[1, 80, 50, 4, 81, 51],
    &[6, 58, 36, 2, 59, 37],
    &[8, 59, 37, 1, 60, 38],
    &[4, 64, 40, 5, 65, 41],
    &[5, 65, 41, 5, 66, 42],
    &[7, 73, 45, 3, 74, 46],
    &[10, 74, 46, 1, 75, 47],
    &[9, 69, 43, 4, 70, 44],
    &[3, 70, 44, 11, 71, 45],
    &[3, 67, 41, 13, 68, 42],
    &[17, 68, 42],
    &[17, 74, 46],
    &[4, 75, 47, 14, 76, 48],
    &[6, 73, 45, 14, 74, 46],
    &[8, 75, 47, 13, 76, 48],
    &[19, 74, 46, 4, 75, 47],
    &[22, 73, 45, 3, 74, 46],
    &[3, 73, 45, 23, 74, 46],
    &[21, 73, 45, 7, 74, 46],
    &[19, 75, 47, 10, 76, 48],
    &[2, 74, 46, 29, 75, 47],
    &[10, 74, 46, 23, 75, 47],
    &[14, 74, 46, 21, 75, 47],
    &[14, 74, 46, 23, 75, 47],
    &[12, 75, 47, 26, 76, 48],
    &[6, 75, 47, 34, 76, 48],
    &[29, 74, 46, 14, 75, 47],
    &[13, 74, 46, 32, 75, 47],
    &[40, 75, 47, 7, 76, 48],
    &[18, 75, 47, 31, 76, 48],
];

const G15: u32 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G18: u32 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
const G15_MASK: u32 = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

fn bch_digit(mut data: u32) -> i32 {
    let mut digit = 0;
    while data != 0 {
        digit += 1;
        data >>= 1;
    }
    digit
}

fn bch_type_info(data: u32) -> u32 {
    let mut d = data << 10;
    while bch_digit(d) - bch_digit(G15) >= 0 {
        d ^= G15 << (bch_digit(d) - bch_digit(G15));
    }
    ((data << 10) | d) ^ G15_MASK
}

fn bch_type_number(data: u32) -> u32 {
    let mut d = data << 12;
    while bch_digit(d) - bch_digit(G18) >= 0 {
        d ^= G18 << (bch_digit(d) - bch_digit(G18));
    }
    (data << 12) | d
}

fn mask(pattern: u32, i: usize, j: usize) -> bool {
    match pattern {
        0 => (i + j).is_multiple_of(2),
        1 => i.is_multiple_of(2),
        2 => j.is_multiple_of(3),
        3 => (i + j).is_multiple_of(3),
        4 => (i / 2 + j / 3).is_multiple_of(2),
        5 => ((i * j) % 2 + (i * j) % 3) == 0,
        6 => ((i * j) % 2 + (i * j) % 3).is_multiple_of(2),
        _ => ((i * j) % 3 + (i + j) % 2).is_multiple_of(2),
    }
}

/// GF(256) tables.
struct Galois {
    exp: [u32; 256],
    log: [u32; 256],
}

impl Galois {
    fn new() -> Self {
        let mut exp = [0u32; 256];
        let mut log = [0u32; 256];
        for (i, value) in exp.iter_mut().enumerate().take(8) {
            *value = 1 << i;
        }
        for i in 8..256 {
            exp[i] = exp[i - 4] ^ exp[i - 5] ^ exp[i - 6] ^ exp[i - 8];
        }
        for i in 0..255 {
            log[exp[i] as usize] = i as u32;
        }
        Self { exp, log }
    }

    fn gexp(&self, mut n: i64) -> u32 {
        while n < 0 {
            n += 255;
        }
        while n >= 256 {
            n -= 255;
        }
        self.exp[n as usize]
    }

    fn glog(&self, n: u32) -> i64 {
        i64::from(self.log[n as usize])
    }
}

/// qrPolynomial: leading zeros dropped, `shift` zeros appended.
fn polynomial(num: &[u32], shift: usize) -> Vec<u32> {
    let offset = num.iter().take_while(|value| **value == 0).count();
    let mut out = num[offset..].to_vec();
    out.extend(std::iter::repeat_n(0, shift));
    out
}

fn multiply(g: &Galois, a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut num = vec![0u32; a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            num[i + j] ^= g.gexp(g.glog(*x) + g.glog(*y));
        }
    }
    polynomial(&num, 0)
}

fn modulo(g: &Galois, a: &[u32], e: &[u32]) -> Vec<u32> {
    let mut current = a.to_vec();
    while current.len() >= e.len() {
        let ratio = g.glog(current[0]) - g.glog(e[0]);
        let mut num = current.clone();
        for (i, value) in e.iter().enumerate() {
            num[i] ^= g.gexp(g.glog(*value) + ratio);
        }
        current = polynomial(&num, 0);
    }
    current
}

struct BitBuffer {
    buffer: Vec<u32>,
    length: usize,
}

impl BitBuffer {
    fn new() -> Self {
        Self {
            buffer: Vec::new(),
            length: 0,
        }
    }

    fn put(&mut self, num: u32, length: usize) {
        for i in 0..length {
            self.put_bit((num >> (length - i - 1)) & 1 == 1);
        }
    }

    fn put_bit(&mut self, bit: bool) {
        let index = self.length / 8;
        if self.buffer.len() <= index {
            self.buffer.push(0);
        }
        if bit {
            self.buffer[index] |= 0x80 >> (self.length % 8);
        }
        self.length += 1;
    }
}

fn length_in_bits(type_number: usize) -> usize {
    if type_number < 10 { 8 } else { 16 }
}

/// (total, data) of each block.
fn rs_blocks(type_number: usize) -> Vec<(usize, usize)> {
    let row = RS_BLOCKS_M[type_number - 1];
    let mut list = Vec::new();
    for group in row.chunks(3) {
        for _ in 0..group[0] {
            list.push((group[1] as usize, group[2] as usize));
        }
    }
    list
}

fn data_buffer(bytes: &[u32], type_number: usize) -> BitBuffer {
    let mut buffer = BitBuffer::new();
    buffer.put(MODE_8BIT_BYTE, 4);
    buffer.put(bytes.len() as u32, length_in_bits(type_number));
    for byte in bytes {
        buffer.put(*byte, 8);
    }
    buffer
}

fn create_data(g: &Galois, bytes: &[u32], type_number: usize) -> Vec<u32> {
    let blocks = rs_blocks(type_number);
    let mut buffer = data_buffer(bytes, type_number);
    let total_data: usize = blocks.iter().map(|(_, data)| data).sum();
    if buffer.length + 4 <= total_data * 8 {
        buffer.put(0, 4);
    }
    while !buffer.length.is_multiple_of(8) {
        buffer.put_bit(false);
    }
    loop {
        if buffer.length >= total_data * 8 {
            break;
        }
        buffer.put(PAD0, 8);
        if buffer.length >= total_data * 8 {
            break;
        }
        buffer.put(PAD1, 8);
    }
    let mut offset = 0;
    let mut dc_data = Vec::new();
    let mut ec_data = Vec::new();
    for (total, data_count) in &blocks {
        let ec_count = total - data_count;
        let dc: Vec<u32> = (0..*data_count)
            .map(|i| 0xff & buffer.buffer.get(i + offset).copied().unwrap_or(0))
            .collect();
        offset += data_count;
        let mut generator = vec![1u32];
        for i in 0..ec_count {
            generator = multiply(g, &generator, &[1, g.gexp(i as i64)]);
        }
        let raw = polynomial(&dc, generator.len() - 1);
        let rem = modulo(g, &raw, &generator);
        let ec_len = generator.len() - 1;
        let ec: Vec<u32> = (0..ec_len)
            .map(|i| {
                let index = i as i64 + rem.len() as i64 - ec_len as i64;
                if index >= 0 { rem[index as usize] } else { 0 }
            })
            .collect();
        dc_data.push(dc);
        ec_data.push(ec);
    }
    let mut out = Vec::new();
    for source in [&dc_data, &ec_data] {
        let longest = source.iter().map(Vec::len).max().unwrap_or(0);
        for i in 0..longest {
            for block in source.iter() {
                if let Some(value) = block.get(i) {
                    out.push(*value);
                }
            }
        }
    }
    out
}

/// A made QR code: `modules[row][col]` is dark.
pub struct QrCode {
    pub modules: Vec<Vec<bool>>,
}

struct Builder<'a> {
    type_number: usize,
    count: usize,
    modules: Vec<Vec<Option<bool>>>,
    data: &'a [u32],
}

impl Builder<'_> {
    fn make(&mut self, test: bool, pattern: u32) {
        self.modules = vec![vec![None; self.count]; self.count];
        self.probe(0, 0);
        self.probe(self.count - 7, 0);
        self.probe(0, self.count - 7);
        self.adjust();
        self.timing();
        self.type_info(test, pattern);
        if self.type_number >= 7 {
            self.type_number_bits(test);
        }
        self.map(pattern);
    }

    fn probe(&mut self, row: usize, col: usize) {
        let count = self.count as i64;
        for r in -1i64..=7 {
            let rr = row as i64 + r;
            if rr <= -1 || count <= rr {
                continue;
            }
            for c in -1i64..=7 {
                let cc = col as i64 + c;
                if cc <= -1 || count <= cc {
                    continue;
                }
                let dark = ((0..=6).contains(&r) && (c == 0 || c == 6))
                    || ((0..=6).contains(&c) && (r == 0 || r == 6))
                    || ((2..=4).contains(&r) && (2..=4).contains(&c));
                self.modules[rr as usize][cc as usize] = Some(dark);
            }
        }
    }

    fn adjust(&mut self) {
        let positions = PATTERN_POSITION_TABLE[self.type_number - 1];
        for &row in positions {
            for &col in positions {
                if self.modules[row][col].is_some() {
                    continue;
                }
                for r in -2i64..=2 {
                    for c in -2i64..=2 {
                        let dark = r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0);
                        self.modules[(row as i64 + r) as usize][(col as i64 + c) as usize] =
                            Some(dark);
                    }
                }
            }
        }
    }

    fn timing(&mut self) {
        for r in 8..self.count - 8 {
            if self.modules[r][6].is_none() {
                self.modules[r][6] = Some(r.is_multiple_of(2));
            }
        }
        for c in 8..self.count - 8 {
            if self.modules[6][c].is_none() {
                self.modules[6][c] = Some(c.is_multiple_of(2));
            }
        }
    }

    fn type_number_bits(&mut self, test: bool) {
        let bits = bch_type_number(self.type_number as u32);
        for i in 0..18 {
            let dark = !test && ((bits >> i) & 1) == 1;
            self.modules[i / 3][i % 3 + self.count - 8 - 3] = Some(dark);
        }
        for i in 0..18 {
            let dark = !test && ((bits >> i) & 1) == 1;
            self.modules[i % 3 + self.count - 8 - 3][i / 3] = Some(dark);
        }
    }

    fn type_info(&mut self, test: bool, pattern: u32) {
        let bits = bch_type_info((LEVEL_M << 3) | pattern);
        let count = self.count;
        for i in 0..15 {
            let dark = Some(!test && ((bits >> i) & 1) == 1);
            if i < 6 {
                self.modules[i][8] = dark;
            } else if i < 8 {
                self.modules[i + 1][8] = dark;
            } else {
                self.modules[count - 15 + i][8] = dark;
            }
        }
        for i in 0..15 {
            let dark = Some(!test && ((bits >> i) & 1) == 1);
            if i < 8 {
                self.modules[8][count - i - 1] = dark;
            } else if i < 9 {
                self.modules[8][15 - i] = dark;
            } else {
                self.modules[8][15 - i - 1] = dark;
            }
        }
        self.modules[count - 8][8] = Some(!test);
    }

    fn map(&mut self, pattern: u32) {
        let mut inc: i64 = -1;
        let mut row = self.count as i64 - 1;
        let mut bit_index: i32 = 7;
        let mut byte_index = 0;
        let mut col = self.count as i64 - 1;
        while col > 0 {
            if col == 6 {
                col -= 1;
            }
            loop {
                for c in 0..2 {
                    let cc = (col - c) as usize;
                    let rr = row as usize;
                    if self.modules[rr][cc].is_none() {
                        let mut dark = false;
                        if byte_index < self.data.len() {
                            dark = (self.data[byte_index] >> bit_index) & 1 == 1;
                        }
                        if mask(pattern, rr, cc) {
                            dark = !dark;
                        }
                        self.modules[rr][cc] = Some(dark);
                        bit_index -= 1;
                        if bit_index == -1 {
                            byte_index += 1;
                            bit_index = 7;
                        }
                    }
                }
                row += inc;
                if row < 0 || self.count as i64 <= row {
                    row -= inc;
                    inc = -inc;
                    break;
                }
            }
            col -= 2;
        }
    }

    fn dark(&self, row: usize, col: usize) -> bool {
        self.modules[row][col] == Some(true)
    }

    /// getLostPoint, a float as the library computes it.
    fn lost_point(&self) -> f64 {
        let n = self.count;
        let mut lost = 0f64;
        for row in 0..n {
            for col in 0..n {
                let dark = self.dark(row, col);
                let mut same = 0;
                for r in -1i64..=1 {
                    let rr = row as i64 + r;
                    if rr < 0 || n as i64 <= rr {
                        continue;
                    }
                    for c in -1i64..=1 {
                        let cc = col as i64 + c;
                        if cc < 0 || n as i64 <= cc || (r == 0 && c == 0) {
                            continue;
                        }
                        if dark == self.dark(rr as usize, cc as usize) {
                            same += 1;
                        }
                    }
                }
                if same > 5 {
                    lost += f64::from(3 + same - 5);
                }
            }
        }
        for row in 0..n - 1 {
            for col in 0..n - 1 {
                let count = [(0, 0), (1, 0), (0, 1), (1, 1)]
                    .iter()
                    .filter(|(r, c)| self.dark(row + r, col + c))
                    .count();
                if count == 0 || count == 4 {
                    lost += 3.0;
                }
            }
        }
        let finder = [true, false, true, true, true, false, true];
        for row in 0..n {
            for col in 0..n - 6 {
                if (0..7).all(|k| self.dark(row, col + k) == finder[k]) {
                    lost += 40.0;
                }
            }
        }
        for col in 0..n {
            for row in 0..n - 6 {
                if (0..7).all(|k| self.dark(row + k, col) == finder[k]) {
                    lost += 40.0;
                }
            }
        }
        let dark_count = (0..n)
            .flat_map(|col| (0..n).map(move |row| (row, col)))
            .filter(|(row, col)| self.dark(*row, *col))
            .count() as f64;
        let ratio = (100.0 * dark_count / n as f64 / n as f64 - 50.0).abs() / 5.0;
        lost + ratio * 10.0
    }
}

/// `qrcode(0, "M")`, `addData(text, "Byte")`, `make()`: the bytes are
/// each UTF-16 unit's low byte, as the library's default stringToBytes.
pub fn make_qr(text: &str) -> QrCode {
    let bytes: Vec<u32> = text
        .encode_utf16()
        .map(|unit| u32::from(unit & 0xff))
        .collect();
    let mut type_number = 1;
    while type_number < 40 {
        let total: usize = rs_blocks(type_number).iter().map(|(_, data)| data).sum();
        if data_buffer(&bytes, type_number).length <= total * 8 {
            break;
        }
        type_number += 1;
    }
    let galois = Galois::new();
    let data = create_data(&galois, &bytes, type_number);
    let mut builder = Builder {
        type_number,
        count: type_number * 4 + 17,
        modules: Vec::new(),
        data: &data,
    };
    let mut best = 0;
    let mut min_lost = 0f64;
    for pattern in 0..8 {
        builder.make(true, pattern);
        let lost = builder.lost_point();
        if pattern == 0 || min_lost > lost {
            min_lost = lost;
            best = pattern;
        }
    }
    builder.make(false, best);
    QrCode {
        modules: builder
            .modules
            .iter()
            .map(|row| row.iter().map(|module| *module == Some(true)).collect())
            .collect(),
    }
}

/// renderTerminalQr: half blocks, two modules per character row, a quiet
/// zone, explicit colors (an inverted code often fails to scan).
pub fn render_terminal_qr(text: &str) -> String {
    let code = make_qr(text);
    let size = code.modules.len() as i32;
    let dark = |row: i32, col: i32| {
        row >= 0 && row < size && col >= 0 && col < size && code.modules[row as usize][col as usize]
    };
    let mut lines = Vec::new();
    let mut row = -QUIET_ZONE;
    while row < size + QUIET_ZONE {
        let mut line = COLORS.to_owned();
        for col in -QUIET_ZONE..size + QUIET_ZONE {
            line.push(match (dark(row, col), dark(row + 1, col)) {
                (true, true) => '\u{2588}',
                (true, false) => '\u{2580}',
                (false, true) => '\u{2584}',
                (false, false) => ' ',
            });
        }
        line.push_str(RESET);
        lines.push(line);
        row += 2;
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests;
