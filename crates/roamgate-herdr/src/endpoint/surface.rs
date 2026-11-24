//! The endpoint surface codecs (bridge/endpoint-surface.ts): full
//! `PaneSurface` frames, `PaneSurfacePatch` patches, and the negotiated
//! `endpoint.surface-delta.v1` and `endpoint.surface-reuse.v1` controls,
//! each checked strictly against the baseline it applies to. Counts are
//! checked before anything is allocated for them.

use base64::Engine;
use serde_json::{Map, Value, json};

use crate::thin::{BinReader, CellData, CursorState, FrameData};

pub const SURFACE_DELTA_KIND: &str = "endpoint.surface-delta.v1";
pub const SURFACE_REUSE_KIND: &str = "endpoint.surface-reuse.v1";
const MAX_FRAME: u64 = 32 * 1024 * 1024;
/// JavaScript's `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: u64 = (1 << 53) - 1;

/// A popup's requested size (Herdr's ClientShellPopupSize).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopupSize {
    Cells(u64),
    Percent(u64),
}

impl PopupSize {
    /// `{kind, value}`, as the browser reads it.
    pub fn to_value(size: Option<&PopupSize>) -> Value {
        match size {
            None => Value::Null,
            Some(PopupSize::Cells(value)) => json!({"kind": "cells", "value": value}),
            Some(PopupSize::Percent(value)) => json!({"kind": "percent", "value": value}),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Popup {
    pub terminal_id: String,
    pub title: String,
    pub width: Option<PopupSize>,
    pub height: Option<PopupSize>,
    pub frame: FrameData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: u64,
    pub y: u64,
    pub width: u64,
    pub height: u64,
}

impl Rect {
    pub fn to_value(&self) -> Value {
        json!({"x": self.x, "y": self.y, "width": self.width, "height": self.height})
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollMeta {
    pub offset_from_bottom: u64,
    pub max_offset_from_bottom: u64,
    pub viewport_rows: u64,
}

/// One pane of a surface (PaneSurfacePaneMeta).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneMeta {
    pub content_revision: u64,
    pub pane_id: String,
    pub rect: Rect,
    /// The content area inside decorations: a crop targets this rect.
    pub inner_rect: Rect,
    pub scroll: Option<ScrollMeta>,
    pub focused: bool,
    pub mouse_reporting: bool,
}

/// The composed surface of a shell, with what identifies it.
#[derive(Debug, Clone, PartialEq)]
pub struct SurfaceBaseline {
    pub boot_id: String,
    pub projection_revision: u64,
    pub surface_revision: u64,
    pub frame: FrameData,
    pub panes: Vec<PaneMeta>,
    pub popup: Option<Popup>,
}

fn invalid(reason: &str) -> String {
    format!("Invalid endpoint surface: {reason}")
}

fn require(ok: bool, reason: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(invalid(reason)) }
}

fn uint(value: u64, max: u64) -> Result<u64, String> {
    require(value <= MAX_SAFE && value <= max, "integer out of range")?;
    Ok(value)
}

/// The strict reads of the surface codecs (`SurfaceReader`).
struct SurfaceReader<'a>(BinReader<'a>);

impl<'a> SurfaceReader<'a> {
    fn u8(&mut self) -> Result<u8, String> {
        self.0.u8()
    }
    fn bool(&mut self) -> Result<bool, String> {
        let value = self.u8()?;
        require(value <= 1, "invalid boolean")?;
        Ok(value == 1)
    }
    fn option<T>(
        &mut self,
        read: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        if self.bool()? {
            read(self).map(Some)
        } else {
            Ok(None)
        }
    }
    fn varint(&mut self) -> Result<u64, String> {
        self.0.varint()
    }
    fn number(&mut self, max: u64) -> Result<u64, String> {
        uint(self.varint()?, max)
    }
    fn count(&mut self, max: u64) -> Result<u64, String> {
        let remaining = self.remaining() as u64;
        self.number(max.min(remaining))
    }
    fn string(&mut self) -> Result<String, String> {
        self.0.string()
    }
    fn bytes(&mut self) -> Result<(), String> {
        self.0.bytes().map(|_| ())
    }
    fn remaining(&self) -> usize {
        self.0.remaining()
    }
}

fn read_cursor(reader: &mut SurfaceReader<'_>) -> Result<Option<CursorState>, String> {
    reader.option(|reader| {
        Ok(CursorState {
            x: reader.number(65535)?,
            y: reader.number(65535)?,
            visible: reader.bool()?,
            shape: reader.u8()?,
        })
    })
}

fn read_cell(reader: &mut SurfaceReader<'_>) -> Result<CellData, String> {
    let symbol = reader.string()?;
    let fg = uint(reader.varint()?, 0xffff_ffff)?;
    let bg = uint(reader.varint()?, 0xffff_ffff)?;
    let modifier = uint(reader.varint()?, 65535)?;
    let skip = reader.bool()?;
    let hyperlink = reader.option(|reader| uint(reader.varint()?, 0xffff_ffff))?;
    Ok(CellData {
        symbol,
        fg,
        bg,
        modifier,
        skip,
        hyperlink,
    })
}

fn read_cells(reader: &mut SurfaceReader<'_>, count: u64) -> Result<Vec<CellData>, String> {
    require(count <= (reader.remaining() / 6) as u64, "truncated cells")?;
    let mut cells = Vec::with_capacity(count as usize);
    for _ in 0..count {
        cells.push(read_cell(reader)?);
    }
    Ok(cells)
}

fn read_frame(reader: &mut SurfaceReader<'_>, metadata: bool) -> Result<FrameData, String> {
    let count = reader.count(if metadata { 0 } else { MAX_FRAME / 6 })?;
    let cells = read_cells(reader, count)?;
    let width = reader.number(if metadata { 4096 } else { 65535 })?;
    let height = reader.number(if metadata { 4096 } else { 65535 })?;
    require(
        if metadata {
            width * height <= 1_000_000
        } else {
            count == width * height
        },
        "invalid grid size",
    )?;
    let cursor = read_cursor(reader)?;
    let links = reader.count(if metadata { 65536 } else { MAX_FRAME })?;
    let mut hyperlinks = Vec::with_capacity(links as usize);
    for _ in 0..links {
        hyperlinks.push(reader.string()?);
    }
    // Kitty graphics bytes are not rendered by the pane terminal.
    reader.bytes()?;
    Ok(FrameData {
        cells,
        width,
        height,
        cursor,
        hyperlinks,
    })
}

fn read_rect(reader: &mut SurfaceReader<'_>) -> Result<Rect, String> {
    Ok(Rect {
        x: reader.number(65535)?,
        y: reader.number(65535)?,
        width: reader.number(65535)?,
        height: reader.number(65535)?,
    })
}

fn unique_panes(panes: &[PaneMeta]) -> Result<(), String> {
    let mut ids: Vec<&str> = panes.iter().map(|pane| pane.pane_id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    require(ids.len() == panes.len(), "duplicate panes")
}

fn read_panes(reader: &mut SurfaceReader<'_>, metadata: bool) -> Result<Vec<PaneMeta>, String> {
    let max = if metadata {
        4096
    } else {
        (reader.remaining() / 18) as u64
    };
    let count = reader.count(max)?;
    let mut panes = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let pane_id = reader.string()?;
        let content_revision = reader.number(MAX_SAFE)?;
        let rect = read_rect(reader)?;
        let inner_rect = read_rect(reader)?;
        reader.option(read_rect)?;
        let scroll = reader.option(|reader| {
            Ok(ScrollMeta {
                offset_from_bottom: reader.number(MAX_SAFE)?,
                max_offset_from_bottom: reader.number(MAX_SAFE)?,
                viewport_rows: reader.number(MAX_SAFE)?,
            })
        })?;
        let focused = reader.bool()?;
        let mouse_reporting = reader.bool()?;
        reader.bool()?; // sgr_pixel_mouse
        reader.bool()?; // alternate_screen_active
        reader.number(0xffff_ffff)?; // pixel_width
        reader.number(0xffff_ffff)?; // pixel_height
        panes.push(PaneMeta {
            content_revision,
            pane_id,
            rect,
            inner_rect,
            scroll,
            focused,
            mouse_reporting,
        });
    }
    unique_panes(&panes)?;
    Ok(panes)
}

fn read_popup_size(reader: &mut SurfaceReader<'_>) -> Result<Option<PopupSize>, String> {
    reader.option(|reader| {
        Ok(if reader.number(1)? == 0 {
            PopupSize::Cells(reader.number(65535)?)
        } else {
            PopupSize::Percent(u64::from(reader.u8()?))
        })
    })
}

fn read_popup(reader: &mut SurfaceReader<'_>, metadata: bool) -> Result<Option<Popup>, String> {
    reader.option(|reader| {
        let terminal_id = reader.string()?;
        let title = reader.string()?;
        let width = read_popup_size(reader)?;
        let height = read_popup_size(reader)?;
        let frame = read_frame(reader, metadata)?;
        reader.bool()?;
        reader.bool()?;
        reader.number(0xffff_ffff)?;
        reader.number(0xffff_ffff)?;
        Ok(Popup {
            terminal_id,
            title,
            width,
            height,
            frame,
        })
    })
}

/// The scene precedes delta rows on the wire even though Roamgate does not
/// render it: every field is consumed, no image payload kept.
fn skip_graphics_key(reader: &mut SurfaceReader<'_>) -> Result<(), String> {
    if reader.number(1)? == 0 {
        reader.number(1)?; // Pane / Popup target
        reader.string()?;
        reader.number(0xffff_ffff)?; // image_id
    } else {
        reader.string()?;
        reader.string()?;
    }
    reader.number(0xffff_ffff)?;
    reader.number(0xffff_ffff)?;
    reader.number(2)?; // RGB / RGBA / PNG
    reader.varint()?; // data_len
    reader.varint()?; // opaque u64 fingerprint
    Ok(())
}

fn skip_graphics(reader: &mut SurfaceReader<'_>, metadata: bool) -> Result<bool, String> {
    let assets = reader.count(if metadata { 4096 } else { MAX_FRAME })?;
    for _ in 0..assets {
        skip_graphics_key(reader)?;
        reader.bytes()?;
    }
    let placements = reader.count(if metadata { 65536 } else { MAX_FRAME })?;
    for _ in 0..placements {
        skip_graphics_key(reader)?;
        // logical id, x/y, cols/rows, source rect, offsets, zigzag z, scrollback
        for _ in 0..13 {
            reader.number(0xffff_ffff)?;
        }
    }
    let retained = reader.count(if metadata { 65536 } else { MAX_FRAME })?;
    for _ in 0..retained {
        skip_graphics_key(reader)?;
    }
    Ok(assets + placements + retained > 0)
}

fn read_surface(
    reader: &mut SurfaceReader<'_>,
    metadata: bool,
) -> Result<(SurfaceBaseline, bool), String> {
    let boot_id = reader.string()?;
    let projection_revision = reader.number(MAX_SAFE)?;
    let surface_revision = reader.number(MAX_SAFE)?;
    let frame = read_frame(reader, metadata)?;
    let panes = read_panes(reader, metadata)?;
    let splits = reader.count(if metadata {
        4096
    } else {
        (reader.remaining() / 11) as u64
    })?;
    for _ in 0..splits {
        reader.number(1)?;
        reader.number(65535)?;
        read_rect(reader)?;
        read_rect(reader)?;
        let count = reader.count(if metadata { 4096 } else { MAX_FRAME })?;
        for _ in 0..count {
            reader.bool()?;
        }
    }
    let popup = read_popup(reader, metadata)?;
    let has_graphics = skip_graphics(reader, metadata)?;
    Ok((
        SurfaceBaseline {
            boot_id,
            projection_revision,
            surface_revision,
            frame,
            panes,
            popup,
        },
        has_graphics,
    ))
}

fn validate_links(frame: &FrameData) -> Result<(), String> {
    let links = frame.hyperlinks.len() as u64;
    require(
        frame
            .cells
            .iter()
            .all(|cell| cell.hyperlink.is_none_or(|link| link < links)),
        "invalid hyperlink index",
    )
}

/// A `PaneSurface` payload after its variant tag.
pub fn read_full_surface(payload: &[u8]) -> Result<SurfaceBaseline, String> {
    let mut reader = SurfaceReader(BinReader::new(payload));
    reader.0.variant()?;
    let (surface, _) = read_surface(&mut reader, false)?;
    require(reader.remaining() == 0, "trailing full-frame bytes")?;
    validate_links(&surface.frame)?;
    if let Some(popup) = &surface.popup {
        validate_links(&popup.frame)?;
    }
    Ok(surface)
}

fn check_base(
    current: Option<&SurfaceBaseline>,
    boot_id: &str,
    base: u64,
    next: u64,
) -> Result<(), String> {
    require(
        current.is_some_and(|current| {
            current.boot_id == boot_id && current.surface_revision == base && next == base + 1
        }),
        "baseline mismatch; reconnect required",
    )
}

/// Spans of cells written over `cells` (a grid of `width` x `height`).
fn patch_cells(
    reader: &mut SurfaceReader<'_>,
    cells: &mut [CellData],
    width: u64,
    height: u64,
    sparse: bool,
) -> Result<(), String> {
    let count = reader.count(if sparse {
        4096u64.min(width * height)
    } else {
        MAX_FRAME
    })?;
    let mut previous_end = 0u64;
    for _ in 0..count {
        let x = reader.number(65535)?;
        let y = reader.number(65535)?;
        let length = reader.count(width)?;
        let start = y * width + x;
        require(
            y < height && x + length <= width && (!sparse || (length > 0 && start >= previous_end)),
            "span outside grid or overlapping",
        )?;
        let row = read_cells(reader, length)?;
        for (offset, cell) in row.into_iter().enumerate() {
            if let Some(slot) = cells.get_mut(start as usize + offset) {
                *slot = cell;
            }
        }
        previous_end = start + length;
    }
    Ok(())
}

/// A `PaneSurfacePatch` payload, applied over `current` in place.
pub fn apply_surface_patch(
    payload: &[u8],
    current: Option<&mut SurfaceBaseline>,
) -> Result<(), String> {
    let mut reader = SurfaceReader(BinReader::new(payload));
    reader.0.variant()?;
    let boot_id = reader.string()?;
    let projection_revision = reader.number(MAX_SAFE)?;
    let base = reader.number(MAX_SAFE)?;
    let surface_revision = reader.number(MAX_SAFE)?;
    check_base(current.as_deref(), &boot_id, base, surface_revision)?;
    let current = current.expect("checked");
    require(
        projection_revision == current.projection_revision,
        "patch projection mismatch",
    )?;
    // In place: a failed patch closes the shell, its surface with it.
    let (width, height) = (current.frame.width, current.frame.height);
    patch_cells(&mut reader, &mut current.frame.cells, width, height, false)?;
    for pane in read_panes(&mut reader, false)? {
        let index = current
            .panes
            .iter()
            .position(|each| each.pane_id == pane.pane_id)
            .ok_or_else(|| invalid("patch changes pane topology"))?;
        current.panes[index] = pane;
    }
    current.frame.cursor = read_cursor(&mut reader)?;
    require(reader.remaining() == 0, "trailing patch bytes")?;
    validate_links(&current.frame)?;
    current.surface_revision = surface_revision;
    Ok(())
}

fn is_base64_body(data: &str) -> bool {
    data.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

/// An `endpoint.surface-delta.v1` control over `current`, whose cells it
/// takes (a failed delta closes the shell, its surface with it).
pub fn read_surface_delta(
    data: &str,
    current: Option<&mut SurfaceBaseline>,
) -> Result<SurfaceBaseline, String> {
    require(
        data.len() as u64 <= MAX_FRAME && is_base64_body(data),
        "invalid delta base64",
    )?;
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(data)
        .map_err(|_| invalid("invalid delta base64"))?;
    require(
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(&bytes) == data,
        "invalid delta base64",
    )?;
    let mut reader = SurfaceReader(BinReader::new(&bytes));
    let base_projection = reader.number(MAX_SAFE)?;
    let base = reader.number(MAX_SAFE)?;
    let (mut surface, has_graphics) = read_surface(&mut reader, true)?;
    require(
        has_graphics || data.len() <= 2 * 1024 * 1024,
        "ordinary delta exceeds frame limit",
    )?;
    check_base(
        current.as_deref(),
        &surface.boot_id,
        base,
        surface.surface_revision,
    )?;
    let current = current.expect("checked");
    require(
        base_projection == current.projection_revision
            && surface.projection_revision >= base_projection,
        "delta projection mismatch",
    )?;
    require(
        surface.frame.width == current.frame.width && surface.frame.height == current.frame.height,
        "delta dimensions changed",
    )?;
    let mut cells = std::mem::take(&mut current.frame.cells);
    patch_cells(
        &mut reader,
        &mut cells,
        surface.frame.width,
        surface.frame.height,
        true,
    )?;
    surface.frame.cells = cells;
    let has_popup_update = reader.bool()?;
    require(
        has_popup_update == surface.popup.is_some(),
        "missing or unexpected popup update",
    )?;
    if let Some(popup) = &mut surface.popup {
        if reader.number(1)? == 0 {
            let previous = current.popup.as_mut().filter(|previous| {
                previous.terminal_id == popup.terminal_id
                    && previous.frame.width == popup.frame.width
                    && previous.frame.height == popup.frame.height
            });
            let previous = previous.ok_or_else(|| invalid("popup baseline mismatch"))?;
            let mut cells = std::mem::take(&mut previous.frame.cells);
            patch_cells(
                &mut reader,
                &mut cells,
                popup.frame.width,
                popup.frame.height,
                true,
            )?;
            popup.frame.cells = cells;
        } else {
            let count = reader.count(1_000_000)?;
            require(
                count == popup.frame.width * popup.frame.height,
                "popup replacement size mismatch",
            )?;
            popup.frame.cells = read_cells(&mut reader, count)?;
        }
        validate_links(&popup.frame)?;
    }
    require(reader.remaining() == 0, "trailing delta bytes")?;
    validate_links(&surface.frame)?;
    Ok(surface)
}

fn object(value: &Value) -> Result<&Map<String, Value>, String> {
    value.as_object().ok_or_else(|| invalid("expected object"))
}

fn json_string(value: &Value) -> Result<String, String> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid("expected string"))
}

fn json_bool(value: &Value) -> Result<bool, String> {
    value.as_bool().ok_or_else(|| invalid("expected boolean"))
}

fn json_uint(value: &Value, max: u64) -> Result<u64, String> {
    let number = value
        .as_u64()
        .or_else(|| {
            value
                .as_f64()
                .filter(|number| *number >= 0.0 && number.fract() == 0.0)
                .map(|number| number as u64)
        })
        .ok_or_else(|| invalid("integer out of range"))?;
    uint(number, max)
}

fn json_array(value: &Value, max: usize) -> Result<&Vec<Value>, String> {
    value
        .as_array()
        .filter(|items| items.len() <= max)
        .ok_or_else(|| invalid("invalid collection"))
}

fn json_rect(value: &Value) -> Result<Rect, String> {
    let rect = object(value)?;
    let field = |name: &str| json_uint(rect.get(name).unwrap_or(&Value::Null), 65535);
    Ok(Rect {
        x: field("x")?,
        y: field("y")?,
        width: field("width")?,
        height: field("height")?,
    })
}

/// An `endpoint.surface-reuse.v1` control over `current`, whose cells it
/// takes.
pub fn read_surface_reuse(
    data: &str,
    current: Option<&mut SurfaceBaseline>,
) -> Result<SurfaceBaseline, String> {
    require(data.len() <= 2 * 1024 * 1024, "reuse exceeds frame limit")?;
    let parsed: Value = serde_json::from_str(data).map_err(|error| error.to_string())?;
    let reuse = object(&parsed)?;
    let null = Value::Null;
    let get = |map: &Map<String, Value>, key: &str| map.get(key).cloned().unwrap_or(Value::Null);
    let raw_value = get(reuse, "surface");
    let raw = object(&raw_value)?;
    let boot_id = json_string(&get(raw, "boot_id"))?;
    let projection_revision = json_uint(&get(raw, "projection_revision"), MAX_SAFE)?;
    let surface_revision = json_uint(&get(raw, "surface_revision"), MAX_SAFE)?;
    check_base(
        current.as_deref(),
        &boot_id,
        json_uint(&get(reuse, "base_surface_revision"), MAX_SAFE)?,
        surface_revision,
    )?;
    let current = current.expect("checked");
    require(
        projection_revision >= current.projection_revision,
        "reuse projection mismatch",
    )?;
    let frame_value = get(raw, "frame");
    let frame = object(&frame_value)?;
    require(
        json_array(frame.get("cells").unwrap_or(&null), 0)?.is_empty()
            && json_uint(&get(frame, "width"), 65535)? == current.frame.width
            && json_uint(&get(frame, "height"), 65535)? == current.frame.height,
        "reuse grid mismatch",
    )?;
    let cursor = match frame.get("cursor").unwrap_or(&null) {
        Value::Null => None,
        cursor => {
            let cursor = object(cursor)?;
            Some(CursorState {
                x: json_uint(&get(cursor, "x"), 65535)?,
                y: json_uint(&get(cursor, "y"), 65535)?,
                visible: json_bool(&get(cursor, "visible"))?,
                shape: json_uint(&get(cursor, "shape"), 255)? as u8,
            })
        }
    };
    let hyperlinks = json_array(frame.get("hyperlinks").unwrap_or(&null), 65536)?
        .iter()
        .map(json_string)
        .collect::<Result<Vec<_>, _>>()?;
    // v1 reuse is sent only without a popup; popup grids use the binary codec.
    require(
        raw.get("popup").unwrap_or(&null).is_null(),
        "unexpected reuse popup",
    )?;
    let frame = FrameData {
        cells: std::mem::take(&mut current.frame.cells),
        width: current.frame.width,
        height: current.frame.height,
        cursor,
        hyperlinks,
    };
    let mut panes = Vec::new();
    for value in json_array(raw.get("panes").unwrap_or(&null), 4096)? {
        let pane = object(value)?;
        let scroll = match pane.get("scroll").unwrap_or(&null) {
            Value::Null => None,
            scroll => {
                let scroll = object(scroll)?;
                Some(ScrollMeta {
                    offset_from_bottom: json_uint(&get(scroll, "offset_from_bottom"), MAX_SAFE)?,
                    max_offset_from_bottom: json_uint(
                        &get(scroll, "max_offset_from_bottom"),
                        MAX_SAFE,
                    )?,
                    viewport_rows: json_uint(&get(scroll, "viewport_rows"), MAX_SAFE)?,
                })
            }
        };
        panes.push(PaneMeta {
            pane_id: json_string(&get(pane, "pane_id"))?,
            content_revision: json_uint(&get(pane, "content_revision"), MAX_SAFE)?,
            rect: json_rect(&get(pane, "rect"))?,
            inner_rect: json_rect(&get(pane, "inner_rect"))?,
            scroll,
            focused: json_bool(&get(pane, "focused"))?,
            mouse_reporting: json_bool(&get(pane, "mouse_reporting"))?,
        });
    }
    unique_panes(&panes)?;
    validate_links(&frame)?;
    Ok(SurfaceBaseline {
        boot_id,
        projection_revision,
        surface_revision,
        frame,
        panes,
        popup: None,
    })
}
