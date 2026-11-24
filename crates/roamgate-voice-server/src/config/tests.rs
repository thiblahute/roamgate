use serde_json::json;

use super::*;

/// The tests' voice.json (voice-helper.test.ts CONFIG).
pub(crate) fn config(extra: Value) -> VoiceConfig {
    let mut raw = json!({
        "helper": "/bin/roamgate-voice",
        "whisper_model": "whisper.bin",
        "kokoro_model": "kokoro.onnx",
        "kokoro_voices": "voices.bin",
    });
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        if value.is_null() {
            raw.as_object_mut().unwrap().shift_remove(&key);
        } else {
            raw[&key] = value;
        }
    }
    VoiceConfig {
        raw: raw.as_object().unwrap().clone(),
    }
}

fn real() -> Value {
    json!({
        "helper": "/bin/sh",
        "whisper_model": "/bin/sh",
        "kokoro_model": "/bin/sh",
        "kokoro_voices": "/bin/sh",
    })
}

fn with(base: &Value, extra: Value) -> Value {
    let mut out = base.clone();
    for (key, value) in extra.as_object().unwrap() {
        out[key] = value.clone();
    }
    out
}

struct Dir(tempfile::TempDir);

impl Dir {
    fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }

    fn file(&self, config: &Value) -> PathBuf {
        let path = self.0.path().join("voice.json");
        fs::write(&path, js::stringify(config)).unwrap();
        path
    }

    fn read(&self, config: &Value) -> Result<Value, String> {
        read_voice_config(&self.file(config)).map(|config| Value::Object(config.raw))
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[test]
fn is_1_2_by_default_and_what_voice_json_says() {
    assert_eq!(config(json!({})).speech_rate(), 1.2);
    assert_eq!(config(json!({"speech_rate": 1.5})).speech_rate(), 1.5);
}

#[test]
fn voice_json_refuses_a_rate_out_of_range() {
    let dir = Dir::new();
    assert_eq!(
        dir.read(&with(&real(), json!({"speech_rate": 1.3}))),
        Ok(with(&real(), json!({"speech_rate": 1.3})))
    );
    assert!(dir.read(&with(&real(), json!({"speech_rate": 3}))).is_err());
    assert!(
        dir.read(&with(&real(), json!({"speech_rate": "fast"})))
            .is_err()
    );
}

#[test]
fn parakeet_is_given_whisper_s_model_too_to_read_again_what_it_writes_in_english() {
    assert_eq!(
        transcriber_args(Some("/p"), Some("/w.bin")),
        strings(&["--parakeet-model", "/p", "--whisper-model", "/w.bin"])
    );
    assert_eq!(
        transcriber_args(Some("/p"), None),
        strings(&["--parakeet-model", "/p"])
    );
    assert_eq!(
        transcriber_args(None, Some("/w.bin")),
        strings(&["--whisper-model", "/w.bin"])
    );
}

#[test]
fn voice_json_s_drop_other_voices_is_true_or_false() {
    let dir = Dir::new();
    let ok = with(&real(), json!({"drop_other_voices": true}));
    assert_eq!(dir.read(&ok), Ok(ok.clone()));
    assert!(
        dir.read(&with(&real(), json!({"drop_other_voices": "yes"})))
            .is_err()
    );
}

#[test]
fn voice_json_takes_the_speaker_s_reference_recordings_as_a_list_of_files() {
    let dir = Dir::new();
    let listed = with(
        &real(),
        json!({"speaker_reference": ["/bin/sh", "/bin/ls"]}),
    );
    assert_eq!(dir.read(&listed), Ok(listed.clone()));
    for reference in [json!("/bin/sh"), json!([""]), json!([3])] {
        assert!(
            dir.read(&with(&real(), json!({"speaker_reference": reference})))
                .is_err()
        );
    }
    assert_eq!(
        dir.read(&with(
            &real(),
            json!({"speaker_reference": ["/no/such/voice.wav"]})
        )),
        Err("speaker_reference not found: /no/such/voice.wav".into())
    );
}

#[test]
fn is_kept_in_voice_json_with_the_rest_untouched() {
    let dir = Dir::new();
    let path = dir.file(&with(&real(), json!({"route_model": "opus"})));
    write_speech_rate(1.3, &path).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        with(&real(), json!({"route_model": "opus", "speech_rate": 1.3}))
    );
    assert!(text.ends_with("}\n"));
    assert!(write_speech_rate(9.0, &path).is_err());
}

#[test]
fn is_8_s_by_default_what_voice_json_says_and_kept_there() {
    assert_eq!(max_pause_ms(config(json!({})).get("max_pause_ms")), 8000.0);
    assert_eq!(max_pause_ms(Some(&json!(12_000))), 12_000.0);
    assert_eq!(max_pause_ms(Some(&json!(500))), 8000.0);
    let dir = Dir::new();
    let path = dir.file(&json!({"helper": "/bin/sh"}));
    write_max_pause(10_000.0, &path).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&fs::read_to_string(&path).unwrap()).unwrap(),
        json!({"helper": "/bin/sh", "max_pause_ms": 10_000})
    );
    assert!(write_max_pause(60_000.0, &path).is_err());
}

fn own() -> Vec<String> {
    strings(&[
        "/bin/roamgate-voice",
        "--whisper-model",
        "whisper.bin",
        "--kokoro-model",
        "kokoro.onnx",
        "--kokoro-voices",
        "voices.bin",
    ])
}

#[test]
fn the_helper_s_command_comes_after_its_wrapper_s_arguments() {
    assert_eq!(config(json!({})).helper_command(), own());
    assert_eq!(
        config(json!({"helper_wrapper": []})).helper_command(),
        own()
    );
    let speakers = json!({"speaker_model": "s.onnx", "speaker_reference": ["me.wav"]});
    let mut expected = own();
    expected.extend(strings(&["--speaker-model", "s.onnx"]));
    assert_eq!(config(speakers.clone()).helper_command(), expected);
    expected.extend(strings(&[
        "--drop-other-voices",
        "--speaker-reference",
        "[\"me.wav\"]",
    ]));
    assert_eq!(
        config(with(&speakers, json!({"drop_other_voices": true}))).helper_command(),
        expected
    );
    let mut wrapped = strings(&["/opt/bin/gpu-lease", "--name=voice", "--"]);
    wrapped.extend(own());
    assert_eq!(
        config(json!({"helper_wrapper": ["/opt/bin/gpu-lease", "--name=voice", "--"]}))
            .helper_command(),
        wrapped
    );
}

/// The desktop's wrapper: a transient unit holding the GPU unit, queued
/// with `--job-mode=replace` so a start right after a stop (a restart, the
/// flip of voice between Bun and the core) cancels the start of the
/// service the GPU unit conflicts with instead of failing as destructive.
/// The command line is the wrapper as written, then the helper's, as Bun's
/// helperCommand makes it: nothing is added before or between.
#[test]
fn a_systemd_unit_wrapper_holding_the_gpu_is_passed_as_written() {
    let wrapper = strings(&[
        "systemd-run",
        "--user",
        "--unit=roamgate-voice",
        "--job-mode=replace",
        "--pipe",
        "--collect",
        "-p",
        "Requires=llm-gpu-voice.service",
        "-p",
        "After=llm-gpu-voice.service",
        "-p",
        "PropagatesStopTo=llm-gpu-voice.service",
        "-E",
        "ROAMGATE_VOICE_ICE_ADDRESSES",
        "-E",
        "ROAMGATE_VOICE_DEBUG",
        "-E",
        "GST_DEBUG",
        "--",
    ]);
    let mut expected = wrapper.clone();
    expected.extend(own());
    let held = config(json!({ "helper_wrapper": wrapper }));
    assert_eq!(held.helper_command(), expected);
    assert_eq!(held.yield_cpu_priority(), None);
    // Yielding the CPU, the unit's priority goes right after systemd-run:
    // the job mode and the GPU unit stay as written.
    let mut yielding = strings(&[
        "systemd-run",
        "-p",
        "Nice=10",
        "-p",
        "CPUWeight=20",
        "-p",
        "IOSchedulingClass=idle",
    ]);
    yielding.extend(wrapper[1..].iter().cloned());
    yielding.extend(own());
    yielding.extend(strings(&["--cpu-threads", "4"]));
    assert_eq!(
        config(json!({ "helper_wrapper": wrapper, "yield_cpu": {"threads": 4} })).helper_command(),
        yielding
    );
}

#[test]
fn a_helper_yielding_the_cpu_to_a_game_low_priority_a_few_onnx_threads() {
    let systemd = json!([
        "systemd-run",
        "--user",
        "--unit=roamgate-voice",
        "--pipe",
        "--"
    ]);
    let yielding = json!({"yield_cpu": {"threads": 4}});
    let mut expected = strings(&[
        "systemd-run",
        "-p",
        "Nice=10",
        "-p",
        "CPUWeight=20",
        "-p",
        "IOSchedulingClass=idle",
        "--user",
        "--unit=roamgate-voice",
        "--pipe",
        "--",
    ]);
    expected.extend(own());
    expected.extend(strings(&["--cpu-threads", "4"]));
    let with_systemd = config(with(&yielding, json!({"helper_wrapper": systemd})));
    assert_eq!(with_systemd.helper_command(), expected);
    assert_eq!(with_systemd.yield_cpu_priority(), None);
    assert_eq!(
        config(with(
            &yielding,
            json!({"helper_wrapper": ["/usr/bin/systemd-run", "--user", "--"]})
        ))
        .helper_command()[1..3]
            .to_vec(),
        strings(&["-p", "Nice=10"])
    );
    let mut direct = own();
    direct.extend(strings(&["--cpu-threads", "4"]));
    assert_eq!(config(yielding.clone()).helper_command(), direct);
    assert_eq!(
        config(yielding.clone()).yield_cpu_priority(),
        Some(YIELD_CPU_NICE)
    );
    let mut lease = strings(&["/opt/bin/gpu-lease", "--"]);
    lease.extend(direct.clone());
    assert_eq!(
        config(with(
            &yielding,
            json!({"helper_wrapper": ["/opt/bin/gpu-lease", "--"]})
        ))
        .helper_command(),
        lease
    );
    let mut unlimited = strings(&[
        "systemd-run",
        "-p",
        "Nice=10",
        "-p",
        "CPUWeight=20",
        "-p",
        "IOSchedulingClass=idle",
    ]);
    unlimited.extend(strings(&[
        "--user",
        "--unit=roamgate-voice",
        "--pipe",
        "--",
    ]));
    unlimited.extend(own());
    assert_eq!(
        config(json!({"yield_cpu": {"threads": 0}, "helper_wrapper": systemd})).helper_command(),
        unlimited
    );
    let mut plain = strings(&[
        "systemd-run",
        "--user",
        "--unit=roamgate-voice",
        "--pipe",
        "--",
    ]);
    plain.extend(own());
    assert_eq!(
        config(json!({"helper_wrapper": systemd})).helper_command(),
        plain
    );
    assert_eq!(config(json!({})).yield_cpu_priority(), None);
}

#[test]
fn kokoro_s_onnx_model_comes_beside_tts_models_for_kokoro_s_sentences() {
    let models = json!([{"model": "qwen3-tts", "path": "q"}, {"model": "kokoro", "path": "k"}]);
    let tts = vec!["--tts-models".to_owned(), js::stringify(&models)];
    let onnx = strings(&[
        "--kokoro-model",
        "kokoro.onnx",
        "--kokoro-voices",
        "voices.bin",
    ]);
    let args = |config: VoiceConfig| config.helper_command()[3..].to_vec();
    assert_eq!(
        args(config(json!({"tts_models": models}))),
        [tts.clone(), onnx].concat()
    );
    assert_eq!(
        args(config(json!({"tts_models": models, "kokoro_voices": null}))),
        tts
    );
}

#[test]
fn a_front_is_a_companion_unless_voice_json_says_relay() {
    assert_eq!(config(json!({})).front_mode(), None);
    assert_eq!(
        config(json!({"front_model": "opus"})).front_mode(),
        Some(FrontMode::Companion)
    );
    assert_eq!(
        config(json!({"front_model": "opus", "front_mode": "relay"})).front_mode(),
        Some(FrontMode::Relay)
    );
    assert_eq!(
        config(json!({"front_mode": "companion"})).front_mode(),
        None
    );
}

#[test]
fn voice_json_refuses_another_mode_and_keeps_one_with_the_rest() {
    let dir = Dir::new();
    let relay = with(&real(), json!({"front_mode": "relay"}));
    assert_eq!(dir.read(&relay), Ok(relay.clone()));
    assert!(
        dir.read(&with(&real(), json!({"front_mode": "loud"})))
            .is_err()
    );
    let path = dir.file(&with(&real(), json!({"front_model": "opus"})));
    write_front_mode(FrontMode::Relay, &path).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&fs::read_to_string(&path).unwrap()).unwrap(),
        with(
            &real(),
            json!({"front_model": "opus", "front_mode": "relay"})
        )
    );
    // A mode that is not one cannot be written: FrontMode has only two.
}

struct Checked {
    dir: tempfile::TempDir,
}

impl Checked {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        for name in ["helper", "kokoro.onnx", "whisper.bin"] {
            fs::write(dir.path().join(name), "").unwrap();
        }
        Self { dir }
    }

    fn file(&self) -> String {
        self.dir.path().join("voice.json").display().to_string()
    }

    fn path(&self, name: &str) -> String {
        self.dir.path().join(name).display().to_string()
    }

    fn base(&self) -> Value {
        json!({"helper": self.path("helper"), "whisper_model": self.path("whisper.bin")})
    }

    fn readable(&self) -> Value {
        with(&self.base(), json!({"tts_models": [{"model": "kokoro"}]}))
    }

    fn read(&self, config: &Value) -> Result<Value, String> {
        let path = self.dir.path().join("voice.json");
        fs::write(&path, js::stringify(config)).unwrap();
        read_voice_config(&path).map(|config| Value::Object(config.raw))
    }

    fn error(&self, message: &str) -> Result<Value, String> {
        Err(format!("{}: {message}", self.file()))
    }
}

#[test]
fn helper_wrapper_is_a_list_of_arguments_a_program_first() {
    let checked = Checked::new();
    for wrapper in [json!([]), json!(["/opt/bin/gpu-lease", "--"])] {
        assert!(
            checked
                .read(&with(
                    &checked.readable(),
                    json!({"helper_wrapper": wrapper})
                ))
                .is_ok()
        );
    }
    for wrapper in [json!("/opt/bin/gpu-lease --"), json!([1]), json!([""])] {
        assert_eq!(
            checked.read(&with(
                &checked.readable(),
                json!({"helper_wrapper": wrapper})
            )),
            checked.error("helper_wrapper must be a list of arguments, a program first")
        );
    }
}

#[test]
fn helper_idle_exit_minutes_is_a_number_of_minutes_0_for_never() {
    let checked = Checked::new();
    for minutes in [json!(0), json!(10), json!(0.5)] {
        assert!(
            checked
                .read(&with(
                    &checked.readable(),
                    json!({"helper_idle_exit_minutes": minutes})
                ))
                .is_ok()
        );
    }
    for minutes in [json!(-1), json!("10"), json!(null)] {
        assert_eq!(
            checked.read(&with(
                &checked.readable(),
                json!({"helper_idle_exit_minutes": minutes})
            )),
            checked.error("helper_idle_exit_minutes must be a number of minutes, 0 for never")
        );
    }
}

#[test]
fn gaming_cpu_threads_is_a_whole_number_of_threads_0_for_no_limit() {
    let checked = Checked::new();
    for threads in [json!(0), json!(2), json!(4)] {
        assert!(
            checked
                .read(&with(
                    &checked.readable(),
                    json!({"gaming_cpu_threads": threads})
                ))
                .is_ok()
        );
    }
    for threads in [json!(-1), json!(1.5), json!("4"), json!(null)] {
        assert_eq!(
            checked.read(&with(
                &checked.readable(),
                json!({"gaming_cpu_threads": threads})
            )),
            checked.error("gaming_cpu_threads must be a number of threads, 0 for no limit")
        );
    }
}

#[test]
fn any_tts_models_read_in_place_of_kokoro() {
    let checked = Checked::new();
    let config = with(
        &checked.base(),
        json!({"tts_models": [{"model": "qwen3-tts", "path": "/models/qwen3", "voice_embedding": "me.json"}, {"model": "kokoro"}]}),
    );
    assert!(checked.read(&config).is_ok());
}

#[test]
fn a_qwen3_tts_model_can_name_a_stock_speaker() {
    let checked = Checked::new();
    let stock = with(
        &checked.base(),
        json!({
            "stock_model": "/models/Qwen3-TTS-CustomVoice",
            "tts_models": [
                {"model": "qwen3-tts", "path": "/models/cv", "speaker": "ryan"},
                {"model": "qwen3-tts", "path": "/models/cv", "voice": "vivian"},
            ],
        }),
    );
    assert!(checked.read(&stock).is_ok());
    assert_eq!(
        checked.read(&with(
            &checked.base(),
            json!({"tts_models": [{"model": "qwen3-tts", "path": "/models/cv", "speaker": ""}]})
        )),
        checked.error("the speaker of a qwen3-tts model must be a name")
    );
    assert_eq!(
        checked.read(&with(&stock, json!({"stock_model": 3}))),
        checked.error("stock_model must be a string")
    );
}

#[test]
fn companion_mcp_lists_tool_names_and_may_name_a_model() {
    let checked = Checked::new();
    let tts = with(
        &checked.base(),
        json!({"tts_models": [{"model": "qwen3-tts", "path": "/models/cv"}]}),
    );
    assert!(
        checked
            .read(&with(
                &tts,
                json!({"companion_mcp": {"allow": ["mcp__spotify"], "confirm": ["mcp__claude_ai_WhatsApp__send_message"], "model": "sonnet"}})
            ))
            .is_ok()
    );
    assert_eq!(
        checked.read(&with(&tts, json!({"companion_mcp": ["mcp__spotify"]}))),
        checked.error("companion_mcp must be an object")
    );
    assert_eq!(
        checked.read(&with(
            &tts,
            json!({"companion_mcp": {"allow": "mcp__spotify"}})
        )),
        checked.error("companion_mcp.allow must be a list of tool names")
    );
    assert_eq!(
        checked.read(&with(&tts, json!({"companion_mcp": {"confirm": [""]}}))),
        checked.error("companion_mcp.confirm must be a list of tool names")
    );
    assert_eq!(
        checked.read(&with(&tts, json!({"companion_mcp": {"model": 1}}))),
        checked.error("companion_mcp.model must be a string")
    );
}

#[test]
fn kokoro_s_files_are_needed_without_them() {
    let checked = Checked::new();
    assert_eq!(
        checked.read(&checked.base()),
        checked.error("kokoro_model and kokoro_voices, or tts_models, are required")
    );
    assert_eq!(
        checked.read(&with(
            &checked.base(),
            json!({"kokoro_model": checked.path("kokoro.onnx"), "kokoro_voices": checked.path("missing.bin")})
        )),
        Err(format!("kokoro_voices not found: {}", checked.path("missing.bin")))
    );
}

#[test]
fn each_any_tts_model_is_named() {
    let checked = Checked::new();
    for models in [json!([{"path": "/models/qwen3"}]), json!([])] {
        assert_eq!(
            checked.read(&with(&checked.base(), json!({"tts_models": models}))),
            checked.error("tts_models must be a list of objects with a model name")
        );
    }
}

#[test]
fn kokoro_alone_is_made_at_the_reading_speed() {
    let kokoro = json!({"model": "kokoro", "path": "/models/kokoro"});
    let config = config(json!({"speech_rate": 1.3, "tts_models": [kokoro]}));
    assert_eq!(config.native_speech_rate(), 1.3);
    assert_eq!(
        Value::Array(
            config
                .helper_tts_models()
                .unwrap()
                .into_iter()
                .map(Value::Object)
                .collect()
        ),
        json!([{"model": "kokoro", "path": "/models/kokoro", "speed": 1.3}])
    );
    let mut default = config.clone();
    default.raw.shift_remove("speech_rate");
    assert_eq!(default.native_speech_rate(), 1.2);
}

#[test]
fn other_models_or_a_speed_of_its_own_leave_it_to_the_browser() {
    let kokoro = json!({"model": "kokoro", "path": "/models/kokoro"});
    let qwen = json!({"model": "qwen3-tts", "path": "/models/qwen3"});
    let mixed = config(json!({"tts_models": [qwen, kokoro]}));
    assert_eq!(mixed.native_speech_rate(), 1.0);
    assert_eq!(
        Value::Array(
            mixed
                .helper_tts_models()
                .unwrap()
                .into_iter()
                .map(Value::Object)
                .collect()
        ),
        json!([qwen, kokoro])
    );
    let own = config(
        json!({"tts_models": [{"model": "kokoro", "path": "/models/kokoro", "speed": 1.1}]}),
    );
    assert_eq!(own.native_speech_rate(), 1.0);
    assert_eq!(config(json!({})).native_speech_rate(), 1.0);
}

#[test]
fn without_a_configuration_voice_is_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("voice.json");
    assert_eq!(
        read_voice_config(&path),
        Err(format!("No voice configuration ({})", path.display()))
    );
}
