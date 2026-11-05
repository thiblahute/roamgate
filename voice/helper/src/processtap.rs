//! `osxprocesstapsrc`: what one application plays on this Mac, as a live
//! audio source, through a Core Audio process tap (macOS 14.2 and later).
//!
//! `osxprocesstapsrc bundle-id=com.spotify.client` taps the processes of
//! that application (and its helpers, `com.spotify.client.*`), mixed down to
//! stereo; `pid=1234` taps one process. The application keeps playing on
//! the Mac as it did: nothing of its output, nor of the Mac's devices,
//! changes; only with `mute=true` is it muted on the Mac while tapped. The
//! application need not run: until it plays, the element gives silence, and
//! it looks for it again every second, so an application restarted is
//! tapped again. Nothing is ever launched.
//!
//! The tap and its aggregate device are private to this process (gone with
//! it, even on a crash) and exist only from READY to NULL: while the call's
//! music is on.
//!
//! The tap is made into a private aggregate device whose input is read by
//! an IO procedure into a queue the streaming thread takes from.
//!
//! macOS asks the user before an application records what others play
//! ("System Audio Recording Only", in Privacy & Security). The permission
//! goes to the responsible process: for Roamgate, the program launchd
//! starts (bun). Without it, the tap gives only silence.

use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use gst::glib;
use gst::prelude::*;
use gst::subclass::prelude::*;
use gst_base::prelude::*;
use gst_base::subclass::base_src::CreateSuccess;
use gst_base::subclass::prelude::*;

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSUUID};

type AudioObjectId = u32;
type OsStatus = i32;

const SYSTEM_OBJECT: AudioObjectId = 1;
const fn four(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}
const SCOPE_GLOBAL: u32 = four(b"glob");
const ELEMENT_MAIN: u32 = 0;
const PROCESS_OBJECT_LIST: u32 = four(b"prs#");
const TRANSLATE_PID: u32 = four(b"id2p");
const PROCESS_BUNDLE_ID: u32 = four(b"pbid");
const TAP_FORMAT: u32 = four(b"tfmt");
/// CATapMuteBehavior.
const TAP_UNMUTED: isize = 0;
const TAP_MUTED_WHEN_TAPPED: isize = 2;
/// kAudioFormatFlagIsNonInterleaved.
const NON_INTERLEAVED: u32 = 1 << 5;

#[repr(C)]
struct PropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

impl PropertyAddress {
    fn global(selector: u32) -> Self {
        Self {
            selector,
            scope: SCOPE_GLOBAL,
            element: ELEMENT_MAIN,
        }
    }
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct StreamDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[repr(C)]
struct AudioBuffer {
    channels: u32,
    size: u32,
    data: *mut c_void,
}

#[repr(C)]
struct AudioBufferList {
    count: u32,
    buffers: [AudioBuffer; 1],
}

type IoProc = unsafe extern "C" fn(
    device: AudioObjectId,
    now: *const c_void,
    input: *const AudioBufferList,
    input_time: *const c_void,
    output: *mut AudioBufferList,
    output_time: *const c_void,
    client: *mut c_void,
) -> OsStatus;

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioObjectGetPropertyDataSize(
        object: AudioObjectId,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
    ) -> OsStatus;
    fn AudioObjectGetPropertyData(
        object: AudioObjectId,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> OsStatus;
    fn AudioHardwareCreateProcessTap(
        description: *mut AnyObject,
        tap: *mut AudioObjectId,
    ) -> OsStatus;
    fn AudioHardwareDestroyProcessTap(tap: AudioObjectId) -> OsStatus;
    fn AudioHardwareCreateAggregateDevice(
        description: *const c_void,
        device: *mut AudioObjectId,
    ) -> OsStatus;
    fn AudioHardwareDestroyAggregateDevice(device: AudioObjectId) -> OsStatus;
    fn AudioDeviceCreateIOProcID(
        device: AudioObjectId,
        procedure: IoProc,
        client: *mut c_void,
        id: *mut *mut c_void,
    ) -> OsStatus;
    fn AudioDeviceDestroyIOProcID(device: AudioObjectId, id: *mut c_void) -> OsStatus;
    fn AudioDeviceStart(device: AudioObjectId, id: *mut c_void) -> OsStatus;
    fn AudioDeviceStop(device: AudioObjectId, id: *mut c_void) -> OsStatus;
}

fn check(what: &str, status: OsStatus) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{what} failed ({status})"))
    }
}

/// The audio objects of the processes to tap: `pid`'s, or those whose
/// bundle id is `bundle_id` or starts with `bundle_id.`.
fn process_objects(bundle_id: Option<&str>, pid: i32) -> Vec<AudioObjectId> {
    if pid > 0 {
        let address = PropertyAddress::global(TRANSLATE_PID);
        let mut object: AudioObjectId = 0;
        let mut size = 4u32;
        // SAFETY: the qualifier is a pid_t, the answer an AudioObjectID.
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &address,
                4,
                (&pid as *const i32).cast(),
                &mut size,
                (&mut object as *mut AudioObjectId).cast(),
            )
        };
        return if status == 0 && object != 0 {
            vec![object]
        } else {
            vec![]
        };
    }
    let Some(bundle_id) = bundle_id.filter(|id| !id.is_empty()) else {
        return vec![];
    };
    let address = PropertyAddress::global(PROCESS_OBJECT_LIST);
    let mut size = 0u32;
    // SAFETY: plain property queries on the system object.
    let objects = unsafe {
        if AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &address, 0, std::ptr::null(), &mut size)
            != 0
        {
            return vec![];
        }
        let mut objects = vec![0 as AudioObjectId; size as usize / 4];
        if AudioObjectGetPropertyData(
            SYSTEM_OBJECT,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            objects.as_mut_ptr().cast(),
        ) != 0
        {
            return vec![];
        }
        objects.truncate(size as usize / 4);
        objects
    };
    let prefix = format!("{bundle_id}.");
    objects
        .into_iter()
        .filter(|&object| {
            process_bundle_id(object).is_some_and(|id| id == bundle_id || id.starts_with(&prefix))
        })
        .collect()
}

fn process_bundle_id(object: AudioObjectId) -> Option<String> {
    let address = PropertyAddress::global(PROCESS_BUNDLE_ID);
    let mut string: *mut NSString = std::ptr::null_mut();
    let mut size = std::mem::size_of::<*mut NSString>() as u32;
    // SAFETY: the property is a CFStringRef we own (toll-free NSString).
    unsafe {
        if AudioObjectGetPropertyData(
            object,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            (&mut string as *mut *mut NSString).cast(),
        ) != 0
        {
            return None;
        }
        Retained::from_raw(string).map(|string| string.to_string())
    }
}

/// The name of the taps and aggregate devices made here.
const NAME: &str = "Roamgate call background";
const TAP_LIST: u32 = four(b"tps#");
const DEVICE_LIST: u32 = four(b"dev#");
const OBJECT_NAME: u32 = four(b"lnam");
const TAP_DESCRIPTION: u32 = four(b"tdsc");

/// The ids of `selector`'s list on the system object.
fn system_list(selector: u32) -> Vec<AudioObjectId> {
    let address = PropertyAddress::global(selector);
    let mut size = 0u32;
    // SAFETY: plain property queries on the system object.
    unsafe {
        if AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &address, 0, std::ptr::null(), &mut size)
            != 0
        {
            return vec![];
        }
        let mut objects = vec![0 as AudioObjectId; size as usize / 4];
        if AudioObjectGetPropertyData(
            SYSTEM_OBJECT,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            objects.as_mut_ptr().cast(),
        ) != 0
        {
            return vec![];
        }
        objects.truncate(size as usize / 4);
        objects
    }
}

/// An object's retained Objective-C property (a CFString, a description).
fn object_property(object: AudioObjectId, selector: u32) -> Option<Retained<AnyObject>> {
    let address = PropertyAddress::global(selector);
    let mut value: *mut AnyObject = std::ptr::null_mut();
    let mut size = std::mem::size_of::<*mut AnyObject>() as u32;
    // SAFETY: the property is an object reference we own.
    unsafe {
        if AudioObjectGetPropertyData(
            object,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            (&mut value as *mut *mut AnyObject).cast(),
        ) != 0
        {
            return None;
        }
        Retained::from_raw(value)
    }
}

/// Destroys taps and aggregate devices of ours left over: ours are
/// private and go with the helper, so this finds nothing unless a public
/// one was left by some earlier build. Answers how many went.
pub fn sweep() -> usize {
    let mut swept = 0;
    for tap in system_list(TAP_LIST) {
        let named = object_property(tap, TAP_DESCRIPTION).and_then(|description| {
            // SAFETY: a CATapDescription's name.
            let name: Option<Retained<NSString>> = unsafe { msg_send![&*description, name] };
            name.map(|name| name.to_string())
        });
        if named.as_deref() == Some(NAME) {
            // SAFETY: a tap id from the system's list.
            unsafe { AudioHardwareDestroyProcessTap(tap) };
            swept += 1;
        }
    }
    for device in system_list(DEVICE_LIST) {
        let named = object_property(device, OBJECT_NAME).map(|name| {
            // SAFETY: the name is a CFString (toll-free NSString).
            let name: &NSString = unsafe { &*(Retained::as_ptr(&name) as *const NSString) };
            name.to_string()
        });
        if named.as_deref() == Some(NAME) {
            // SAFETY: a device id from the system's list.
            unsafe { AudioHardwareDestroyAggregateDevice(device) };
            swept += 1;
        }
    }
    swept
}

/// What the IO procedure fills and the streaming thread takes.
struct Queue {
    samples: Mutex<QueueState>,
    ready: Condvar,
}

#[derive(Default)]
struct QueueState {
    /// Interleaved stereo F32.
    samples: VecDeque<f32>,
    /// When the IO procedure last delivered.
    last: Option<Instant>,
}

/// The longest kept: past it, the oldest audio goes (the stream stalled).
const MAX_QUEUED_SECONDS: usize = 1;

unsafe extern "C" fn io_proc(
    _device: AudioObjectId,
    _now: *const c_void,
    input: *const AudioBufferList,
    _input_time: *const c_void,
    _output: *mut AudioBufferList,
    _output_time: *const c_void,
    client: *mut c_void,
) -> OsStatus {
    // SAFETY: client is the Queue the tap holds while the procedure runs.
    let queue = unsafe { &*(client as *const Queue) };
    if input.is_null() {
        return 0;
    }
    // SAFETY: Core Audio gives `count` buffers after the header.
    let buffers = unsafe {
        let list = &*input;
        std::slice::from_raw_parts(list.buffers.as_ptr(), list.count as usize)
    };
    let mut state = queue.samples.lock().unwrap();
    match buffers {
        // Interleaved: one buffer of every channel.
        [buffer] if !buffer.data.is_null() => {
            let channels = buffer.channels.max(1) as usize;
            // SAFETY: `size` bytes of F32 at `data`.
            let samples = unsafe {
                std::slice::from_raw_parts(buffer.data as *const f32, buffer.size as usize / 4)
            };
            for frame in samples.chunks_exact(channels) {
                let left = frame[0];
                let right = if channels > 1 { frame[1] } else { left };
                state.samples.push_back(left);
                state.samples.push_back(right);
            }
        }
        // One buffer a channel.
        [left, rest @ ..] if !left.data.is_null() => {
            let right = rest.first().filter(|b| !b.data.is_null()).unwrap_or(left);
            let frames = (left.size.min(right.size) / 4) as usize;
            // SAFETY: as above, for each channel's buffer.
            let (l, r) = unsafe {
                (
                    std::slice::from_raw_parts(left.data as *const f32, frames),
                    std::slice::from_raw_parts(right.data as *const f32, frames),
                )
            };
            for (l, r) in l.iter().zip(r) {
                state.samples.push_back(*l);
                state.samples.push_back(*r);
            }
        }
        _ => return 0,
    }
    state.last = Some(Instant::now());
    let max = 2 * 192_000 * MAX_QUEUED_SECONDS;
    while state.samples.len() > max {
        state.samples.pop_front();
    }
    drop(state);
    queue.ready.notify_one();
    0
}

/// A process tap read through its aggregate device.
struct Tap {
    tap: AudioObjectId,
    device: AudioObjectId,
    proc_id: *mut c_void,
    queue: Arc<Queue>,
    rate: f64,
    objects: Vec<AudioObjectId>,
}

// SAFETY: the ids are Core Audio handles, usable from any thread.
unsafe impl Send for Tap {}

impl Tap {
    fn new(objects: Vec<AudioObjectId>, mute: bool) -> Result<Self, String> {
        // SAFETY: CATapDescription's documented initializer and setters.
        let (description, uuid) = unsafe {
            let numbers: Vec<Retained<NSNumber>> = objects
                .iter()
                .map(|&object| NSNumber::new_u32(object))
                .collect();
            let processes = NSArray::from_retained_slice(&numbers);
            let class = objc2::runtime::AnyClass::get(c"CATapDescription")
                .ok_or("this macOS has no process taps (14.2 or later is needed)")?;
            let allocated: *mut AnyObject = msg_send![class, alloc];
            let description: *mut AnyObject =
                msg_send![allocated, initStereoMixdownOfProcesses: &*processes];
            let description = Retained::from_raw(description).ok_or("CATapDescription failed")?;
            let uuid = NSUUID::new();
            let _: () = msg_send![&*description, setUUID: &*uuid];
            let _: () = msg_send![&*description, setPrivate: true];
            let behavior = if mute {
                TAP_MUTED_WHEN_TAPPED
            } else {
                TAP_UNMUTED
            };
            let _: () = msg_send![&*description, setMuteBehavior: behavior];
            let name = NSString::from_str(NAME);
            let _: () = msg_send![&*description, setName: &*name];
            (description, uuid.UUIDString())
        };
        let mut tap: AudioObjectId = 0;
        // SAFETY: a valid description; the tap id is written back.
        check("AudioHardwareCreateProcessTap", unsafe {
            AudioHardwareCreateProcessTap(
                Retained::as_ptr(&description) as *mut AnyObject,
                &mut tap,
            )
        })?;
        let made = Self::aggregate(tap, &uuid);
        let (device, rate) = match made {
            Ok(made) => made,
            Err(err) => {
                // SAFETY: the tap made above.
                unsafe { AudioHardwareDestroyProcessTap(tap) };
                return Err(err);
            }
        };
        let queue = Arc::new(Queue {
            samples: Mutex::new(QueueState::default()),
            ready: Condvar::new(),
        });
        let mut proc_id: *mut c_void = std::ptr::null_mut();
        // SAFETY: the queue outlives the procedure: Drop stops and destroys
        // it before the queue goes.
        let started = unsafe {
            check(
                "AudioDeviceCreateIOProcID",
                AudioDeviceCreateIOProcID(
                    device,
                    io_proc,
                    Arc::as_ptr(&queue) as *mut c_void,
                    &mut proc_id,
                ),
            )
            .and_then(|()| check("AudioDeviceStart", AudioDeviceStart(device, proc_id)))
        };
        let made = Self {
            tap,
            device,
            proc_id,
            queue,
            rate,
            objects,
        };
        started.map(|()| made)
    }

    /// The private aggregate device reading `tap`, and the tap's rate.
    fn aggregate(tap: AudioObjectId, uuid: &NSString) -> Result<(AudioObjectId, f64), String> {
        let address = PropertyAddress::global(TAP_FORMAT);
        let mut format = StreamDescription::default();
        let mut size = std::mem::size_of::<StreamDescription>() as u32;
        // SAFETY: the tap's format is an AudioStreamBasicDescription.
        check("reading the tap's format", unsafe {
            AudioObjectGetPropertyData(
                tap,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                (&mut format as *mut StreamDescription).cast(),
            )
        })?;
        if format.format_flags & NON_INTERLEAVED != 0 && format.channels_per_frame > 2 {
            return Err("the tap's format is not stereo".into());
        }
        let key = |key: &str| NSString::from_str(key);
        let sub_tap: Retained<NSDictionary<NSString, AnyObject>> =
            NSDictionary::from_retained_objects(
                &[&*key("uid"), &*key("drift")],
                &[
                    Retained::into_super(Retained::into_super(NSString::from_str(
                        &uuid.to_string(),
                    ))),
                    Retained::into_super(Retained::into_super(Retained::into_super(
                        NSNumber::new_bool(true),
                    ))),
                ],
            );
        let taps = NSArray::from_retained_slice(&[sub_tap]);
        let device_uid = NSUUID::new().UUIDString();
        let values: [Retained<AnyObject>; 5] = [
            Retained::into_super(Retained::into_super(NSString::from_str(NAME))),
            Retained::into_super(Retained::into_super(device_uid)),
            Retained::into_super(Retained::into_super(Retained::into_super(
                NSNumber::new_bool(true),
            ))),
            Retained::into_super(Retained::into_super(Retained::into_super(
                NSNumber::new_bool(true),
            ))),
            Retained::into_super(Retained::into_super(taps)),
        ];
        let keys = [
            &*key("name"),
            &*key("uid"),
            &*key("private"),
            &*key("tapautostart"),
            &*key("taps"),
        ];
        let description: Retained<NSDictionary<NSString, AnyObject>> =
            NSDictionary::from_retained_objects(&keys, &values);
        let mut device: AudioObjectId = 0;
        // SAFETY: an NSDictionary is a CFDictionaryRef (toll-free).
        check("AudioHardwareCreateAggregateDevice", unsafe {
            AudioHardwareCreateAggregateDevice(
                Retained::as_ptr(&description) as *const c_void,
                &mut device,
            )
        })?;
        Ok((device, format.sample_rate))
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        // SAFETY: stopped before anything it uses goes.
        unsafe {
            if !self.proc_id.is_null() {
                AudioDeviceStop(self.device, self.proc_id);
                AudioDeviceDestroyIOProcID(self.device, self.proc_id);
            }
            AudioHardwareDestroyAggregateDevice(self.device);
            AudioHardwareDestroyProcessTap(self.tap);
        }
    }
}

/// 10 ms at 48 kHz: the silence given while nothing is tapped.
const SILENCE_FRAMES: usize = 480;
const RATE: i32 = 48_000;
/// How often the processes are looked for again.
const RESCAN: Duration = Duration::from_secs(1);
/// The longest a buffer is waited for before silence is given instead.
const WAIT: Duration = Duration::from_millis(100);

#[derive(Default)]
struct Settings {
    bundle_id: Option<String>,
    pid: i32,
    mute: bool,
}

#[derive(Default)]
struct State {
    tap: Option<Tap>,
    scanned: Option<Instant>,
    /// The rate the caps say.
    rate: i32,
    /// When silence was last given, to pace it.
    next_silence: Option<Instant>,
    warned: bool,
}

#[derive(Default)]
pub struct ProcessTapSrc {
    settings: Mutex<Settings>,
    state: Mutex<State>,
    flushing: Mutex<bool>,
}

fn caps(rate: i32) -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("rate", rate)
        .field("channels", 2i32)
        .field("channel-mask", gst::Bitmask::new(0x3))
        .build()
}

impl ProcessTapSrc {
    /// Taps the processes again when they changed (started, restarted, gone).
    fn rescan(&self, state: &mut State) {
        let due = state.scanned.is_none_or(|at| at.elapsed() >= RESCAN);
        if !due {
            return;
        }
        state.scanned = Some(Instant::now());
        let (bundle_id, pid, mute) = {
            let settings = self.settings.lock().unwrap();
            (settings.bundle_id.clone(), settings.pid, settings.mute)
        };
        let mut objects = process_objects(bundle_id.as_deref(), pid);
        objects.sort_unstable();
        if state.tap.as_ref().map(|tap| &tap.objects) == Some(&objects) {
            return;
        }
        state.tap = None;
        if objects.is_empty() {
            return;
        }
        match Tap::new(objects, mute) {
            Ok(tap) => {
                gst::info!(
                    CAT,
                    imp = self,
                    "tapping {} process(es) at {} Hz",
                    tap.objects.len(),
                    tap.rate
                );
                state.tap = Some(tap);
                state.warned = false;
            }
            Err(err) => {
                if !state.warned {
                    gst::element_imp_warning!(self, gst::ResourceError::OpenRead, ["{}", err]);
                    state.warned = true;
                }
            }
        }
    }
}

static CAT: std::sync::LazyLock<gst::DebugCategory> = std::sync::LazyLock::new(|| {
    gst::DebugCategory::new(
        "osxprocesstapsrc",
        gst::DebugColorFlags::empty(),
        Some("What an application plays, through a Core Audio process tap"),
    )
});

#[glib::object_subclass]
impl ObjectSubclass for ProcessTapSrc {
    const NAME: &'static str = "RoamgateProcessTapSrc";
    type Type = ProcessTap;
    type ParentType = gst_base::PushSrc;
}

impl ObjectImpl for ProcessTapSrc {
    fn properties() -> &'static [glib::ParamSpec] {
        static PROPERTIES: std::sync::LazyLock<Vec<glib::ParamSpec>> =
            std::sync::LazyLock::new(|| {
                vec![
                    glib::ParamSpecString::builder("bundle-id")
                        .nick("Bundle id")
                        .blurb("The application to tap (com.spotify.client), its helpers included")
                        .mutable_ready()
                        .build(),
                    glib::ParamSpecInt::builder("pid")
                        .nick("Process id")
                        .blurb("One process to tap, in place of bundle-id")
                        .minimum(0)
                        .default_value(0)
                        .mutable_ready()
                        .build(),
                    glib::ParamSpecBoolean::builder("mute")
                        .nick("Mute")
                        .blurb("Mute the application on this Mac's speakers while it is tapped")
                        .default_value(false)
                        .mutable_ready()
                        .build(),
                ]
            });
        PROPERTIES.as_ref()
    }

    fn set_property(&self, _id: usize, value: &glib::Value, pspec: &glib::ParamSpec) {
        let mut settings = self.settings.lock().unwrap();
        match pspec.name() {
            "bundle-id" => settings.bundle_id = value.get().unwrap(),
            "pid" => settings.pid = value.get().unwrap(),
            "mute" => settings.mute = value.get().unwrap(),
            _ => unreachable!(),
        }
    }

    fn property(&self, _id: usize, pspec: &glib::ParamSpec) -> glib::Value {
        let settings = self.settings.lock().unwrap();
        match pspec.name() {
            "bundle-id" => settings.bundle_id.to_value(),
            "pid" => settings.pid.to_value(),
            "mute" => settings.mute.to_value(),
            _ => unreachable!(),
        }
    }

    fn constructed(&self) {
        self.parent_constructed();
        let obj = self.obj();
        obj.set_live(true);
        obj.set_format(gst::Format::Time);
        obj.set_do_timestamp(true);
    }
}

impl GstObjectImpl for ProcessTapSrc {}

impl ElementImpl for ProcessTapSrc {
    fn metadata() -> Option<&'static gst::subclass::ElementMetadata> {
        static METADATA: std::sync::LazyLock<gst::subclass::ElementMetadata> =
            std::sync::LazyLock::new(|| {
                gst::subclass::ElementMetadata::new(
                    "Process tap source",
                    "Source/Audio",
                    "What an application plays, through a Core Audio process tap",
                    "Roamgate",
                )
            });
        Some(&*METADATA)
    }

    fn pad_templates() -> &'static [gst::PadTemplate] {
        static TEMPLATES: std::sync::LazyLock<Vec<gst::PadTemplate>> =
            std::sync::LazyLock::new(|| {
                let caps = gst::Caps::builder("audio/x-raw")
                    .field("format", "F32LE")
                    .field("layout", "interleaved")
                    .field("rate", gst::IntRange::new(8000i32, 192_000))
                    .field("channels", 2i32)
                    .build();
                vec![
                    gst::PadTemplate::new(
                        "src",
                        gst::PadDirection::Src,
                        gst::PadPresence::Always,
                        &caps,
                    )
                    .unwrap(),
                ]
            });
        TEMPLATES.as_ref()
    }
}

impl BaseSrcImpl for ProcessTapSrc {
    fn start(&self) -> Result<(), gst::ErrorMessage> {
        let mut state = self.state.lock().unwrap();
        *state = State::default();
        self.rescan(&mut state);
        state.rate = state.tap.as_ref().map_or(RATE, |tap| tap.rate as i32);
        *self.flushing.lock().unwrap() = false;
        Ok(())
    }

    fn stop(&self) -> Result<(), gst::ErrorMessage> {
        *self.state.lock().unwrap() = State::default();
        Ok(())
    }

    fn caps(&self, _filter: Option<&gst::Caps>) -> Option<gst::Caps> {
        let rate = self.state.lock().unwrap().rate;
        Some(caps(if rate > 0 { rate } else { RATE }))
    }

    fn fixate(&self, mut caps: gst::Caps) -> gst::Caps {
        caps.fixate();
        caps
    }

    fn query(&self, query: &mut gst::QueryRef) -> bool {
        if let gst::QueryViewMut::Latency(query) = query.view_mut() {
            query.set(true, gst::ClockTime::from_mseconds(20), None);
            return true;
        }
        BaseSrcImplExt::parent_query(self, query)
    }

    fn unlock(&self) -> Result<(), gst::ErrorMessage> {
        *self.flushing.lock().unwrap() = true;
        if let Some(tap) = &self.state.lock().unwrap().tap {
            tap.queue.ready.notify_all();
        }
        Ok(())
    }

    fn unlock_stop(&self) -> Result<(), gst::ErrorMessage> {
        *self.flushing.lock().unwrap() = false;
        Ok(())
    }
}

impl PushSrcImpl for ProcessTapSrc {
    fn create(
        &self,
        _buffer: Option<&mut gst::BufferRef>,
    ) -> Result<CreateSuccess, gst::FlowError> {
        let (queue, rate) = {
            let mut state = self.state.lock().unwrap();
            self.rescan(&mut state);
            let rate = state.tap.as_ref().map_or(state.rate, |tap| tap.rate as i32);
            if rate != state.rate && rate > 0 {
                state.rate = rate;
                drop(state);
                let _ = self.obj().set_caps(&caps(rate));
                state = self.state.lock().unwrap();
            }
            (state.tap.as_ref().map(|tap| tap.queue.clone()), state.rate)
        };
        let samples = match queue {
            Some(queue) => {
                let state = queue.samples.lock().unwrap();
                let (mut state, _) = queue
                    .ready
                    .wait_timeout_while(state, WAIT, |state| {
                        state.samples.len() < 2 * SILENCE_FRAMES && !*self.flushing.lock().unwrap()
                    })
                    .unwrap();
                if *self.flushing.lock().unwrap() {
                    return Err(gst::FlowError::Flushing);
                }
                if state.samples.len() >= 2 * SILENCE_FRAMES {
                    let take = state.samples.len() & !1;
                    Some(state.samples.drain(..take).collect::<Vec<f32>>())
                } else {
                    None
                }
            }
            None => None,
        };
        let samples = match samples {
            Some(samples) => samples,
            None => {
                // Nothing tapped (or it stalled): 10 ms of silence, paced.
                let frames = (rate as usize / 100).max(1);
                let next = {
                    let mut state = self.state.lock().unwrap();
                    let now = Instant::now();
                    let next = state.next_silence.filter(|at| *at > now).unwrap_or(now);
                    state.next_silence = Some(next + Duration::from_millis(10));
                    next
                };
                let wait = next.saturating_duration_since(Instant::now());
                if !wait.is_zero() {
                    std::thread::sleep(wait);
                }
                if *self.flushing.lock().unwrap() {
                    return Err(gst::FlowError::Flushing);
                }
                vec![0f32; 2 * frames]
            }
        };
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        Ok(CreateSuccess::NewBuffer(gst::Buffer::from_mut_slice(bytes)))
    }
}

glib::wrapper! {
    pub struct ProcessTap(ObjectSubclass<ProcessTapSrc>)
        @extends gst_base::PushSrc, gst_base::BaseSrc, gst::Element, gst::Object;
}

/// Makes `osxprocesstapsrc` available to gst-launch descriptions.
pub fn register() -> Result<(), glib::BoolError> {
    gst::Element::register(
        None,
        "osxprocesstapsrc",
        gst::Rank::NONE,
        ProcessTap::static_type(),
    )
}
