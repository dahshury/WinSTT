//! A final-only speech LLM must never receive rolling preview decodes. Its
//! selected lightweight streaming companion has its own supervised worker.
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::winstt::settings_schema::{
    DeviceType, ModelUnloadTimeout, RecordingMode, WinsttSettings,
};
use crate::winstt::stt::{
    NativeStreamUpdate, SttBackend, SttError, SttResult, Transcriber, WinsttSttBackend,
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Selection {
    model: String,
    language: String,
}

pub(super) fn final_only(settings: &WinsttSettings) -> bool {
    settings.general.recording_mode != RecordingMode::Listen
        && crate::winstt::catalog::find(&settings.model.model)
            .is_some_and(|entry| !entry.supports_realtime)
}

fn selection(settings: &WinsttSettings) -> Option<Selection> {
    if !final_only(settings) {
        return None;
    }
    let id = crate::winstt::catalog::canonical_model_id(&settings.model.realtime_model);
    let entry = crate::winstt::catalog::find(id)?;
    let kind = crate::winstt::stt::cache_probe::engine_kind_for(
        entry.id,
        entry.family.as_str(),
        entry.onnx_model_name,
    );
    kind.supports_native_streaming().then(|| Selection {
        model: id.to_string(),
        language: settings.model.realtime_language.clone(),
    })
}

pub(super) struct Companion {
    selected: Option<Selection>,
    engine: Option<Box<dyn Transcriber>>,
    generation: Option<u64>,
    failed_generation: Option<u64>,
    last_used: Instant,
}

impl Default for Companion {
    fn default() -> Self {
        Self {
            selected: None,
            engine: None,
            generation: None,
            failed_generation: None,
            last_used: Instant::now(),
        }
    }
}

impl Companion {
    pub(super) fn has_selection(&self) -> bool {
        self.selected.is_some()
    }
    pub(super) fn changed(&self, settings: &WinsttSettings) -> bool {
        self.selected != selection(settings)
    }

    pub(super) fn clear(&mut self) {
        *self = Self::default();
    }

    pub(super) fn model(&self) -> Option<String> {
        self.engine
            .as_ref()
            .filter(|engine| engine.is_ready())
            .map(|engine| engine.model_name().to_string())
    }

    pub(super) fn accept(
        &mut self,
        app: &AppHandle,
        settings: &WinsttSettings,
        generation: u64,
        pcm: &[f32],
    ) -> SttResult<Option<NativeStreamUpdate>> {
        self.accept_with(selection(settings), generation, pcm, |selected| {
            WinsttSttBackend
                .build_resolved(resolve(app, selected)?)
                .map(|(engine, _)| engine)
                .map_err(|e| SttError::Inference(e.to_string()))
        })
    }

    fn accept_with(
        &mut self,
        selected: Option<Selection>,
        generation: u64,
        pcm: &[f32],
        load: impl FnOnce(&Selection) -> SttResult<Box<dyn Transcriber>>,
    ) -> SttResult<Option<NativeStreamUpdate>> {
        if self.selected != selected {
            self.clear();
            self.selected = selected;
        }
        let Some(selected) = self.selected.as_ref() else {
            return Ok(None);
        };
        if self.failed_generation == Some(generation) {
            return Ok(None);
        }
        if self.engine.is_none() {
            match load(selected) {
                Ok(engine) => self.engine = Some(engine),
                Err(error) => {
                    self.failed_generation = Some(generation);
                    return Err(error);
                }
            }
        }
        let engine = self.engine.as_mut().expect("loaded above");
        if self.generation != Some(generation) {
            engine.stream_reset();
            self.generation = Some(generation);
        }
        self.last_used = Instant::now();
        match engine.stream_accept(pcm) {
            Ok(update) => Ok(Some(update)),
            Err(error) => {
                self.engine = None;
                self.failed_generation = Some(generation);
                Err(error)
            }
        }
    }

    pub(super) fn idle(&mut self, settings: &WinsttSettings) -> Option<Duration> {
        if self.changed(settings) {
            self.clear();
            return None;
        }
        let engine = self.engine.as_mut()?;
        if self.generation.take().is_some() {
            engine.stream_reset();
        }
        let seconds = match settings.global.model_unload_timeout {
            ModelUnloadTimeout::Immediately => 0,
            ModelUnloadTimeout::Never => return None,
            ModelUnloadTimeout::Min2 => 120,
            ModelUnloadTimeout::Min5 => 300,
            ModelUnloadTimeout::Min10 => 600,
            ModelUnloadTimeout::Min15 => 900,
            ModelUnloadTimeout::Hour1 => 3600,
        };
        let remaining = Duration::from_secs(seconds).saturating_sub(self.last_used.elapsed());
        if remaining.is_zero() {
            self.clear();
            None
        } else {
            Some(remaining)
        }
    }
}

fn resolve(
    app: &AppHandle,
    selected: &Selection,
) -> SttResult<crate::winstt::stt::backend::ResolvedSpec> {
    let entry = crate::winstt::catalog::find(&selected.model)
        .ok_or_else(|| SttError::Resolve("preview companion is not in the catalog".into()))?;
    // Main IQ4 and preview ONNX precisions are independent.
    let quant = if entry.available_quantizations.contains(&"int8") {
        "int8"
    } else {
        "auto"
    };
    WinsttSttBackend
        .resolve_catalog(
            app,
            &selected.model,
            Some(quant),
            Some(DeviceType::Cpu),
            Some(&selected.model),
        )
        .map_err(|e| SttError::Resolve(e.to_string()))
}

pub(super) fn validate_selection(app: &AppHandle, settings: &WinsttSettings) -> Result<(), String> {
    if settings.model.realtime_model.trim().is_empty() {
        return Ok(());
    }
    let selected = selection(settings).ok_or_else(|| {
        "A final-only model needs a native-streaming preview companion".to_string()
    })?;
    resolve(app, &selected)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winstt::stt::{EngineKind, TranscribeOptions, Transcription};

    #[derive(Default)]
    struct Stream(Vec<f32>);
    impl Transcriber for Stream {
        fn kind(&self) -> EngineKind {
            EngineKind::WhisperHf
        }
        fn model_name(&self) -> &str {
            "preview"
        }
        fn is_ready(&self) -> bool {
            true
        }
        fn active_providers(&self) -> &[String] {
            &[]
        }
        fn supports_native_streaming(&self) -> bool {
            true
        }
        fn transcribe(&mut self, _: &[f32], _: &TranscribeOptions) -> SttResult<Transcription> {
            panic!("a preview companion must never perform rolling batch decodes")
        }
        fn stream_accept(&mut self, pcm: &[f32]) -> SttResult<NativeStreamUpdate> {
            self.0.extend_from_slice(pcm);
            Ok(NativeStreamUpdate {
                text: format!("{:?}", self.0),
                is_final: false,
            })
        }
        fn stream_reset(&mut self) {
            self.0.clear();
        }
    }

    fn settings() -> WinsttSettings {
        let mut settings = WinsttSettings::default();
        settings.model.model = crate::winstt::stt::prompting::NEMOTRON_TRANSCRIBE_ID.into();
        settings.model.realtime_model = "streaming-nemotron-3.5-multi-1120ms-int8".into();
        settings.model.onnx_quantization = "q4".into();
        settings
    }

    #[test]
    fn lightweight_preview_remains_stateful_and_resets_between_recordings() {
        let settings = settings();
        let mut preview = Companion::default();
        let first = preview
            .accept_with(selection(&settings), 1, &[0.25], |_| {
                Ok(Box::<Stream>::default())
            })
            .unwrap()
            .unwrap();
        assert_eq!(first.text, "[0.25]");
        let second = preview
            .accept_with(selection(&settings), 1, &[0.5], |_| {
                panic!("must reuse the loaded preview")
            })
            .unwrap()
            .unwrap();
        assert_eq!(second.text, "[0.25, 0.5]");
        let next_recording = preview
            .accept_with(selection(&settings), 2, &[0.75], |_| {
                panic!("keep the same worker between recordings")
            })
            .unwrap()
            .unwrap();
        assert_eq!(next_recording.text, "[0.75]");
        let mut immediate = settings;
        immediate.global.model_unload_timeout = ModelUnloadTimeout::Immediately;
        assert!(preview.idle(&immediate).is_none());
        assert!(preview.engine.is_none());
    }

    #[test]
    fn a_preview_load_failure_does_not_loop_or_change_the_main_selection() {
        let settings = settings();
        let mut preview = Companion::default();
        assert!(
            preview
                .accept_with(selection(&settings), 1, &[0.25], |_| Err(
                    SttError::Resolve("missing cached preview".into())
                ))
                .is_err()
        );
        assert!(
            preview
                .accept_with(selection(&settings), 1, &[0.5], |_| panic!(
                    "no load loop within one recording"
                ))
                .unwrap()
                .is_none()
        );
        assert!(
            preview
                .accept_with(selection(&settings), 2, &[0.75], |_| Ok(
                    Box::<Stream>::default()
                ))
                .unwrap()
                .is_some()
        );
        assert_eq!(
            settings.model.model,
            crate::winstt::stt::prompting::NEMOTRON_TRANSCRIBE_ID
        );
    }

    #[test]
    fn ordinary_streaming_and_listen_modes_keep_the_existing_shared_path() {
        let mut settings = settings();
        settings.general.recording_mode = RecordingMode::Listen;
        assert!(selection(&settings).is_none());
        settings.general.recording_mode = RecordingMode::Ptt;
        settings.model.model = settings.model.realtime_model.clone();
        assert!(selection(&settings).is_none());
    }
}
