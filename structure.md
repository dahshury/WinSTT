### Application layer (src/application)

```text
src/application/
├─ application_config.py
├─ application_orchestrator.py
├─ application_lifecycle/
│  ├─ activate_window_use_case.py
│  ├─ check_single_instance_use_case.py
│  ├─ manage_dialog_lifecycle_use_case.py
│  ├─ shutdown_application_use_case.py
│  └─ startup_application_use_case.py
├─ audio_recording/
│  ├─ configure_audio_use_case.py
│  ├─ get_recording_status_use_case.py
│  ├─ pause_recording_use_case.py
│  ├─ resume_recording_use_case.py
│  ├─ start_recording_use_case.py
│  └─ stop_recording_use_case.py
├─ audio_visualization/
│  ├─ normalize_audio_use_case.py
│  ├─ process_audio_data_use_case.py
│  ├─ start_visualization_use_case.py
│  ├─ stop_visualization_use_case.py
│  └─ update_waveform_use_case.py
├─ configuration/
│  ├─ load_configuration_use_case.py
│  ├─ save_configuration_use_case.py
│  ├─ update_llm_config_use_case.py
│  └─ update_model_config_use_case.py
├─ events/
│  ├─ application_events.py
│  └─ event_publisher_service.py
├─ external_services/
│  ├─ commands/
│  │  └─ call_external_service_command.py
│  └─ handlers/
│     └─ call_external_service_command_handler.py
├─ interfaces/
│  ├─ animation_service.py
│  ├─ main_window_service.py
│  ├─ ui_coordination_service.py
│  ├─ widget_service.py
│  └─ window_management_service.py
├─ listener/
│  ├─ audio_to_text_config.py
│  └─ audio_to_text_service.py
├─ main_window/
│  ├─ commands/
│  │  └─ update_ui_text_command.py
│  ├─ configure_window_use_case.py
│  ├─ create_main_window_use_case.py
│  ├─ handlers/
│  │  ├─ get_ui_text_state_query_handler.py
│  │  └─ update_ui_text_command_handler.py
│  ├─ initialize_main_window_use_case.py
│  ├─ integrate_visualization_use_case.py
│  ├─ manage_opacity_effects_use_case.py
│  ├─ manage_window_state_use_case.py
│  ├─ queries/
│  │  ├─ get_hardware_capabilities_use_case.py
│  │  └─ get_ui_text_state_query.py
│  ├─ setup_ui_layout_use_case.py
│  └─ update_ui_text_use_case.py
├─ main_window_coordination/
│  └─ main_window_controller.py
├─ media_processing/
│  ├─ batch_transcribe_use_case.py
│  ├─ convert_video_use_case.py
│  ├─ process_media_files_use_case.py
│  ├─ process_next_file_use_case.py
│  └─ transcribe_audio_data_use_case.py
├─ progress_management/
│  ├─ complete_progress_use_case.py
│  ├─ reparent_progress_bar_use_case.py
│  ├─ start_progress_session_use_case.py
│  └─ update_progress_use_case.py
├─ services/
│  └─ application_startup_service.py
├─ settings/
│  ├─ apply_settings_use_case.py
│  ├─ export_settings_use_case.py
│  ├─ import_settings_use_case.py
│  ├─ load_settings_use_case.py
│  ├─ reset_settings_use_case.py
│  ├─ reset_sound_settings_use_case.py
│  ├─ save_settings_use_case.py
│  ├─ update_hotkey_use_case.py
│  ├─ update_sound_settings_use_case.py
│  └─ validate_settings_use_case.py
├─ system_integration/
│  ├─ enable_drag_drop_use_case.py
│  ├─ initialize_system_tray_use_case.py
│  ├─ install_event_filter_use_case.py
│  ├─ manage_geometry_use_case.py
│  ├─ process_drag_drop_use_case.py
│  ├─ process_key_event_use_case.py
│  └─ setup_worker_threads_use_case.py
├─ transcription/
│  ├─ cancel_transcription_use_case.py
│  ├─ configure_model_use_case.py
│  ├─ get_transcription_history_use_case.py
│  ├─ get_transcription_result_use_case.py
│  ├─ start_transcription_use_case.py
│  └─ validate_model_use_case.py
├─ ui_widgets/
│  ├─ commands/
│  │  └─ handle_widget_event_command.py
│  ├─ handlers/
│  │  ├─ get_widget_state_query_handler.py
│  │  └─ handle_widget_event_command_handler.py
│  ├─ queries/
│  │  └─ get_widget_state_query.py
│  └─ update_widget_state_use_case.py
└─ worker_management/
   ├─ cleanup_worker_use_case.py
   ├─ initialize_llm_worker_use_case.py
   └─ initialize_workers_use_case.py
```

### Application files overview

| File | Type | Purpose | Used by (examples) | Notes |
|---|---|---|---|---|
| src/application/application_config.py | Config | App-wide env/logging/platform path configuration via ports | `src/composition_root/container_configuration.py` | No direct logging/env side-effects in app layer |
| src/application/application_orchestrator.py | Orchestrator | Coordinates startup/shutdown via startup service | `src/composition_root/container_configuration.py` | Delegates to `IApplicationStartupService` |
| src/application/services/application_startup_service.py | Service | Initializes app, single-instance check, creates/shows main window, starts loop | `src/application/application_orchestrator.py`, `src/composition_root/container_configuration.py` | Uses domain ports and `IMainWindowService` |
| src/application/application_lifecycle/startup_application_use_case.py | UseCase | Startup flow (domain-level integration) | `ApplicationStartupService` | Wraps `ApplicationLifecyclePort` |
| src/application/application_lifecycle/check_single_instance_use_case.py | UseCase | Ensures single instance, optional activation | `ApplicationStartupService` | Uses `SingleInstancePort` |
| src/application/application_lifecycle/activate_window_use_case.py | UseCase | Brings existing window to foreground | Presentation controllers | Window management port |
| src/application/application_lifecycle/manage_dialog_lifecycle_use_case.py | UseCase | Dialog open/close lifecycle | Presentation dialog flows | — |
| src/application/application_lifecycle/shutdown_application_use_case.py | UseCase | Graceful shutdown | `ApplicationStartupService` | Uses `ShutdownConfiguration` |
| src/application/audio_recording/configure_audio_use_case.py | UseCase | Configure input device/format | `main_window_controller.py` | — |
| src/application/audio_recording/get_recording_status_use_case.py | UseCase | Query recording state | `main_window_controller.py` | Referenced multiple times |
| src/application/audio_recording/pause_recording_use_case.py | UseCase | Pause recording | `main_window_controller.py` | — |
| src/application/audio_recording/resume_recording_use_case.py | UseCase | Resume recording | `main_window_controller.py` | — |
| src/application/audio_recording/start_recording_use_case.py | UseCase | Start recording | `main_window_controller.py`, `src/main.py` | — |
| src/application/audio_recording/stop_recording_use_case.py | UseCase | Stop recording | `main_window_controller.py` | Exposes `StopRecordingRequest` |
| src/application/audio_visualization/start_visualization_use_case.py | UseCase | Start waveform/spectrum | Main window integration | — |
| src/application/audio_visualization/stop_visualization_use_case.py | UseCase | Stop visualization | Main window integration | — |
| src/application/audio_visualization/process_audio_data_use_case.py | UseCase | Process chunks for visuals | Visualization pipeline | — |
| src/application/audio_visualization/update_waveform_use_case.py | UseCase | Update waveform model | Visualization pipeline | — |
| src/application/audio_visualization/normalize_audio_use_case.py | UseCase | Normalize audio for UI | Visualization pipeline | `infrastructure/audio_normalization_service.py` adapter counterpart |
| src/application/configuration/load_configuration_use_case.py | UseCase | Load persisted settings | Settings flows | — |
| src/application/configuration/save_configuration_use_case.py | UseCase | Persist settings | Settings flows | — |
| src/application/configuration/update_model_config_use_case.py | UseCase | Change STT model config | Settings dialog | Referenced by Qt settings widgets |
| src/application/configuration/update_llm_config_use_case.py | UseCase | Change LLM config | Settings dialog | — |
| src/application/events/application_events.py | Events | App event definitions | `application/*/handlers`, `external_services/handlers`, `main_window/handlers` | Referenced explicitly by handlers |
| src/application/events/event_publisher_service.py | Service | Publishes app events | Evented flows | — |
| src/application/external_services/commands/call_external_service_command.py | Command | Invoke external service | `external_services/handlers/*` | — |
| src/application/external_services/handlers/call_external_service_command_handler.py | Handler | Handle external call command, publish events | `application_events.py` | — |
| src/application/interfaces/animation_service.py | Interface | UI animation abstraction | `presentation/qt/services/animation_service_impl.py`, `presentation/core/patterns.py` | Adapter in presentation layer |
| src/application/interfaces/ui_coordination_service.py | Interface | UI coordination abstraction | `presentation/qt/services/ui_coordination_service_impl.py`, `presentation/ui_coordination/*` | — |
| src/application/interfaces/widget_service.py | Interface | Widget operations abstraction | `infrastructure/ui_widgets/widget_service_impl.py`, `presentation/ui_widgets/*` | — |
| src/application/interfaces/window_management_service.py | Interface | Window mgmt abstraction | `infrastructure/system/window_management_service_impl.py` | — |
| src/application/interfaces/main_window_service.py | Interface | Main window abstraction | `infrastructure/main_window/main_window_service_impl.py` | Used by `ApplicationStartupService` |
| src/application/listener/audio_to_text_config.py | Config | Listener/STT configuration | `infrastructure/audio/pyqt_audio_adapter.py`, `infrastructure/adapters/audio_to_text_bridge_adapter.py` | — |
| src/application/listener/audio_to_text_service.py | Service | High-level audio→text coordination | Same as above | — |
| src/application/main_window/configure_window_use_case.py | UseCase | Apply window config | Main window setup | — |
| src/application/main_window/create_main_window_use_case.py | UseCase | Create main window | `infrastructure/main_window/main_window_factory_service.py` | — |
| src/application/main_window/initialize_main_window_use_case.py | UseCase | Initialize widgets/state | Startup flow | — |
| src/application/main_window/integrate_visualization_use_case.py | UseCase | Hook visualization into UI | Main window setup | — |
| src/application/main_window/manage_opacity_effects_use_case.py | UseCase | UI opacity effects | Main window effects | — |
| src/application/main_window/manage_window_state_use_case.py | UseCase | Min/Max/Restore, focus | Window controllers | — |
| src/application/main_window/setup_ui_layout_use_case.py | UseCase | Compose layout | Main window setup | — |
| src/application/main_window/update_ui_text_use_case.py | UseCase | Update UI text resources | `main_window/commands/`, `handlers/`, `queries/` | Central to UI text CQRS |
| src/application/main_window/commands/update_ui_text_command.py | Command | Command for updating UI text | `main_window/handlers/update_ui_text_command_handler.py` | — |
| src/application/main_window/handlers/get_ui_text_state_query_handler.py | Handler | Handle UI text state query | `main_window/queries/get_ui_text_state_query.py` | — |
| src/application/main_window/handlers/update_ui_text_command_handler.py | Handler | Handle update UI text command | `application_events.py` | — |
| src/application/main_window/queries/get_hardware_capabilities_use_case.py | UseCase | Probe HW for UI decisions | `presentation/main_window/main_window.py` | — |
| src/application/main_window/queries/get_ui_text_state_query.py | Query | Read current UI text state | `presentation/main_window/main_window.py`, handler above | — |
| src/application/main_window_coordination/main_window_controller.py | Controller | Orchestrates recording/UI actions | `src/main.py`, `presentation/main_window/main_window.py` | Imports audio_recording use cases |
| src/application/media_processing/batch_transcribe_use_case.py | UseCase | Batch STT for multiple files | Media processing flows | — |
| src/application/media_processing/convert_video_use_case.py | UseCase | Convert video to audio | Media processing flows | — |
| src/application/media_processing/process_media_files_use_case.py | UseCase | Iterate and process files | Media processing flows | — |
| src/application/media_processing/process_next_file_use_case.py | UseCase | Pipeline step runner | Media processing flows | — |
| src/application/media_processing/transcribe_audio_data_use_case.py | UseCase | STT for in-memory audio | Listener/media pipelines | — |
| src/application/progress_management/complete_progress_use_case.py | UseCase | Mark progress complete | Progress UI flows | — |
| src/application/progress_management/reparent_progress_bar_use_case.py | UseCase | Move progress UI | Progress UI flows | — |
| src/application/progress_management/start_progress_session_use_case.py | UseCase | Begin progress session | Progress UI flows | — |
| src/application/progress_management/update_progress_use_case.py | UseCase | Update progress value | Progress UI flows | — |
| src/application/settings/apply_settings_use_case.py | UseCase | Apply settings to system | Settings dialog flows | — |
| src/application/settings/export_settings_use_case.py | UseCase | Export settings to file | Settings dialog flows | — |
| src/application/settings/import_settings_use_case.py | UseCase | Import settings from file | Settings dialog flows | — |
| src/application/settings/load_settings_use_case.py | UseCase | Load settings | Settings dialog flows | — |
| src/application/settings/reset_settings_use_case.py | UseCase | Reset all settings | Settings dialog flows | — |
| src/application/settings/reset_sound_settings_use_case.py | UseCase | Reset audio settings | Settings dialog flows | — |
| src/application/settings/save_settings_use_case.py | UseCase | Save settings | Settings dialog flows | — |
| src/application/settings/update_hotkey_use_case.py | UseCase | Change global hotkey | Settings + window controllers | — |
| src/application/settings/update_sound_settings_use_case.py | UseCase | Change audio settings | Settings dialog flows | — |
| src/application/settings/validate_settings_use_case.py | UseCase | Validate settings | Settings dialog flows | — |
| src/application/system_integration/enable_drag_drop_use_case.py | UseCase | Enable DnD on window | `presentation/.../drag_drop_coordination_controller.py` | — |
| src/application/system_integration/initialize_system_tray_use_case.py | UseCase | Setup system tray | System tray flows | — |
| src/application/system_integration/install_event_filter_use_case.py | UseCase | Install Qt event filter | Main window controllers | — |
| src/application/system_integration/manage_geometry_use_case.py | UseCase | Save/restore geometry | Window controllers | — |
| src/application/system_integration/process_drag_drop_use_case.py | UseCase | Handle DnD events | `presentation/.../drag_drop_coordination_controller.py` | Referenced via import |
| src/application/system_integration/process_key_event_use_case.py | UseCase | Handle key events | Window controllers | — |
| src/application/system_integration/setup_worker_threads_use_case.py | UseCase | Setup worker threads | Worker integration | — |
| src/application/transcription/cancel_transcription_use_case.py | UseCase | Cancel running STT | Model worker flows | — |
| src/application/transcription/configure_model_use_case.py | UseCase | Configure STT model | Settings/model flows | — |
| src/application/transcription/get_transcription_history_use_case.py | UseCase | Retrieve past results | UI/history panels | — |
| src/application/transcription/get_transcription_result_use_case.py | UseCase | Get latest result | UI polling | — |
| src/application/transcription/start_transcription_use_case.py | UseCase | Start STT job | Worker/model flows | — |
| src/application/transcription/validate_model_use_case.py | UseCase | Validate model runtime | Settings/model flows | — |
| src/application/ui_widgets/commands/handle_widget_event_command.py | Command | Widget event command | `ui_widgets/handlers/handle_widget_event_command_handler.py` | — |
| src/application/ui_widgets/handlers/get_widget_state_query_handler.py | Handler | Handle widget state query | `ui_widgets/queries/get_widget_state_query.py` | — |
| src/application/ui_widgets/handlers/handle_widget_event_command_handler.py | Handler | Handle widget event command | `application_events.py` | — |
| src/application/ui_widgets/queries/get_widget_state_query.py | Query | Query widget state | UI widgets | — |
| src/application/ui_widgets/update_widget_state_use_case.py | UseCase | Change widget state | UI widgets | — |
| src/application/worker_management/cleanup_worker_use_case.py | UseCase | Cleanup workers | Worker integration | — |
| src/application/worker_management/initialize_llm_worker_use_case.py | UseCase | Init LLM worker | Worker integration | — |
| src/application/worker_management/initialize_workers_use_case.py | UseCase | Init all workers | `infrastructure/presentation/qt/worker_integration.py` | — |

Notes
- The “Used by” column lists representative locations (not exhaustive) based on imports and known wiring. We can expand with exact references per file on request.


### Composition root (src/composition_root)

```text
src/composition_root/
├─ __init__.py
└─ container_configuration.py
```

| File | Type | Purpose | Used by (examples) | Notes |
|---|---|---|---|---|
| src/composition_root/__init__.py | Package | Exposes composition root exports | Import convenience | Minimal |
| src/composition_root/container_configuration.py | Composition Root | Builds DI container; registers domain, application, infrastructure, and presentation services; exposes `configure_global_container`, `get_service` | Referenced internally by itself; resolved at app bootstrap; used indirectly via service retrieval | Central DI wiring. Registers orchestrator and startup service; worker services; UI adapters/patterns |

### Domain layer (src/domain)

```text
src/domain/
├─ ui_text.py
├─ ui_widget_operations.py
├─ window_state_management.py
├─ application_lifecycle/
├─ audio/
├─ audio_visualization/
├─ common/
├─ file_operations/
├─ llm/
├─ main_window/
├─ media/
├─ progress_management/
├─ settings/
├─ system_integration/
├─ transcription/
├─ ui_coordination/
├─ ui_widgets/
├─ window_management/
└─ worker_management/
```

| File/Module | Kind | Purpose | Used by (examples) | Notes |
|---|---|---|---|---|
| src/domain/ui_text.py | Value objects/DTOs | UI text update phases and results | `application/main_window/update_ui_text_use_case.py`, `application/events/application_events.py` | Direct imports found |
| src/domain/ui_widget_operations.py | Value objects | Widget operation abstractions | `presentation/ui_widgets/handle_widget_event_presenter.py` | — |
| src/domain/window_state_management.py | Value objects | Window state helpers | Window mgmt use cases | — |
| src/domain/common/* | Kernel (ports, results, entities) | Cross-cutting ports (logging, time, FS), `Result`, base types | Widespread: infra adapters, presentation controllers, application services | Extensive usage throughout |
| src/domain/audio/* | Entities/VO/ports | Audio data, formats, recorder, operations | `infrastructure/audio/*`, listener services | Heavy infra usage |
| src/domain/audio_visualization/* | Entities/VO/ports | Waveform, visualization settings, processor | `infrastructure/audio_visualization/*`, `presentation/main_window/controllers/ui_state_controller.py` | — |
| src/domain/file_operations/* | Ports/VO | File system abstractions | Infra FS adapters | — |
| src/domain/llm/* | VO | LLM configs/types | `application/worker_management/initialize_llm_worker_use_case.py` | — |
| src/domain/main_window/* | VO/ports | Window-specific domain concepts | Main window use cases | — |
| src/domain/media/* | VO | Media pipeline concepts | Media processing use cases | — |
| src/domain/progress_management/* | VO/ports | Progress callbacks | `infrastructure/common/progress_callback.py`, app progress use cases | — |
| src/domain/settings/entities/settings_configuration.py | Entity | Aggregates settings and persistence behavior | `infrastructure/presentation/qt/model_config_widget.py`, config adapters | Imports `src/domain/common` |
| src/domain/settings/value_objects/model_configuration.py | Value object | Model selection, params | Same as above | Used by UI and adapters |
| src/domain/settings/* (others) | VO/entities | Key combinations, audio config, etc. | `infrastructure/audio/*`, keyboard service | — |
| src/domain/system_integration/* | Ports/VO | Drag-drop, system tray, platform specifics | `presentation/main_window/controllers/drag_drop_coordination_controller.py`, infra system adapters | — |
| src/domain/transcription/ports.py | Ports | STT pipeline ports | `infrastructure/transcription/onnx_transcription_service.py` | — |
| src/domain/transcription/value_objects/* | VO | Model, language, request/result | `infrastructure/transcription/*`, `application/worker_management/*` | Many imports found |
| src/domain/transcription/entities/* | Entities | Model instance, session, result | Infra model workers | — |
| src/domain/ui_coordination/* | VO/ports | Window state/size/position, layout, event system | Presentation UI coordination services | Multiple imports in presentation |
| src/domain/ui_widgets/* | VO/entities/events | Widget events and state | `presentation/ui_widgets/*` | — |
| src/domain/window_management/* | VO | Window activation/state, layout types | Window mgmt use cases | — |
| src/domain/worker_management/* | Ports/VO/entities | Worker configuration/imports, threads, instances | `infrastructure/worker/worker_imports_configuration.py`, app worker mgmt use cases | — |

Notes
- The domain table groups many files by module due to large breadth. We can expand any module into per-file rows if you want more granularity.

### Infrastructure layer (src/infrastructure)

```text
src/infrastructure/
├─ __init__.py
├─ audio_normalization_service.py
├─ adapters/
├─ audio/
├─ audio_visualization/
├─ common/
├─ container/
├─ llm/
├─ main_window/
├─ media/
├─ presentation/
├─ progress_management/
├─ settings/
├─ system/
├─ system_integration/
├─ transcription/
├─ ui/
├─ ui_widgets/
└─ worker/
```

| Module/Path | Purpose | Key files (examples) | Used by (examples) | Notes |
|---|---|---|---|---|
| src/infrastructure/__init__.py | Package export of infra modules | `__all__` for audio, llm, media, settings, system, transcription, ui, worker | Import convenience | — |
| src/infrastructure/audio | Audio device IO, recording/playback, PyAudio integration, worker | `audio_processing_service.py`, `consolidated_listener_service.py`, `pyaudio_service.py`, `pyaudio_core_service.py`, `pyaudio_recorder.py`, `pyaudio_protocols.py`, `pyaudio_types.py`, `sounddevice_sound_player_adapter.py`, `keyboard_service.py`, `vad_worker_service.py`, `service_factory.py` | `application/listener/audio_to_text_service.py`, `presentation/main_window/controllers/ui_state_controller.py` (via visualization), worker orchestration | Heavily uses domain audio value objects; central to runtime audio stack |
| src/infrastructure/audio_visualization | Audio visualization compute and controllers | `audio_processor_service.py`, `visualization_controller_service.py`, `audio_normalization_service.py`, `buffer_management_service.py`, `resource_cleanup_service.py` | `presentation/main_window/controllers/ui_state_controller.py`, `presentation/qt/voice_visualizer.py` | Depends on `system/logging_service.py` |
| src/infrastructure/adapters | Bridges to application layer abstractions | `audio_to_text_bridge_adapter.py`, `transcription_adapter.py`, `configuration_adapter.py`, `keyboard_adapter.py`, `sound_player_adapter.py` | `main.py`, `application/listener/audio_to_text_service.py`, presentation controllers | Provide app-facing facades over infra services |
| src/infrastructure/common | Shared infra utilities (config, resources, tasking) | `configuration_service.py`, `ui_status_dispatch.py`, `progress_callback.py`, `task_manager.py`, `unit_of_work.py`, `resource_service.py` | `composition_root/container_configuration.py`, presentation services, settings dialogs | Hosts process-wide services used across layers |
| src/infrastructure/container | Infra service registry helpers | `infrastructure_service_registry.py` | Presentation/infra code that needs late binding | Provides `get_service` helpers |
| src/infrastructure/llm | LLM runtime services | `llm_service.py`, `llm_pyqt_worker_service.py` | `infrastructure/presentation/qt/worker_integration.py`, worker initialization | Integrates LLM workers |
| src/infrastructure/main_window | Main window service implementations/factory | `main_window_service_impl.py`, `main_window_factory_service.py` | `application/services/application_startup_service.py` | Implements `IMainWindowService` |
| src/infrastructure/media | Media conversion and probes | `video_conversion_service.py`, `media_conversion_service.py`, `media_info_service.py` | Drag-drop controllers, batch processing use cases | Used by presentation drag/drop pipeline |
| src/infrastructure/presentation | Qt UI composition components and glue | `qt/main_window.py`, `qt/application_bootstrap.py`, `qt/worker_integration.py`, widgets/components under `qt/` | Top-level app UI, settings dialogs, worker integration | Abstractions in `presentation/qt/ui_core_*` used by composition root |
| src/infrastructure/progress_management | Progress tracking and UI reparenting | `progress_tracking_service.py`, `progress_bar_reparenting_service.py`, `ui_state_management_service.py`, `timer_management_service.py` | `presentation/qt/services/progress_ui_service.py`, app progress use cases | — |
| src/infrastructure/settings | Settings repositories, validators, FS | `json_settings_repository.py`, `settings_file_repository.py`, `settings_repository.py`, `settings_migration_service.py`, `settings_validator.py`, `file_system_service.py`, `hotkey_recording_service.py` | `presentation/qt/settings_dialog.py`, `qt/model_config_widget.py` | Persist/read settings and migrations |
| src/infrastructure/system | OS/platform, logging, lifecycle, tray, processes, env | `platform_service.py`, `logging_service.py`, `application_lifecycle_service.py`, `single_instance_service.py`, `subprocess_service.py`, `tray_icon_service.py`, `hardware_capabilities_adapter.py`, `window_activation_service.py`, `window_management_service_impl.py` | `application/services/application_startup_service.py`, `presentation/qt/window_config_component.py` | Implements many domain ports |
| src/infrastructure/system_integration | Keyboard clipboard hooks, delegation | `keyboard_hook_adapter.py`, `pynput_keyboard_adapter.py`, `pyperclip_adapter.py`, `method_delegation_service.py` | `application/listener/audio_to_text_service.py`, `presentation` controllers | Input integration and system bridges |
| src/infrastructure/transcription | Model runner, worker, file repo | `onnx_transcription_service.py`, `model_worker_service.py`, `transcription_file_repository.py` | `adapters/transcription_adapter.py`, worker integration | Uses domain transcription ports/VOs |
| src/infrastructure/ui | UI abstractions for patterns/themes | `ui_core_abstractions.py`, `ui_core_patterns.py` (under presentation bridge) | Composition root registration | Bridge between infra and presentation core |
| src/infrastructure/ui_widgets | Implementations of widget services | `widget_service_impl.py` | Presentation widgets | Implements `IWidgetService` |
| src/infrastructure/worker | Worker threads and registries | `worker_imports_configuration.py`, `worker_thread_management_service.py` | Worker orchestration and setup | Coordinates model/audio/LLM workers |
| src/infrastructure/audio_normalization_service.py | Thin facade for normalization | — | Used by visualization pipeline | Delegates to specialized services under audio_visualization |

Notes
- The table groups files by submodule with representative “Key files”. Ask to expand any submodule to a per-file list with usages if needed.

### Presentation layer (src/presentation)

```text
src/presentation/
├─ __init__.py
├─ value_objects.py
├─ adapters/
│  └─ ui_status_adapter.py
├─ core/
│  ├─ abstractions.py
│  ├─ abstractions_deprecated.py
│  ├─ container.py
│  ├─ events.py
│  └─ patterns.py
├─ main_window/
│  ├─ main_window.py
│  ├─ builders/
│  │  └─ main_window_builder.py
│  ├─ components/
│  │  ├─ progress_indicator_component.py
│  │  └─ status_display_component.py
│  ├─ controllers/
│  │  ├─ drag_drop_coordination_controller.py
│  │  ├─ drag_drop_event_controller.py
│  │  ├─ settings_controller.py
│  │  ├─ tray_coordination_controller.py
│  │  ├─ ui_construction_controller.py
│  │  ├─ ui_state_controller.py
│  │  └─ window_minimize_controller.py
│  └─ value_objects/
│     ├─ icon_path.py
│     ├─ opacity_effects.py
│     ├─ opacity_level.py
│     ├─ ui_layout.py
│     ├─ ui_text.py
│     ├─ visualization_integration.py
│     ├─ window_configuration.py
│     ├─ window_operations.py
│     ├─ window_state_management.py
│     └─ z_order_level.py
├─ qt/
│  ├─ settings_dialog.py
│  ├─ settings_dialog_impl.py
│  ├─ settings_dialog_coordinator.py
│  ├─ toggle_switch_widget.py
│  ├─ voice_visualizer.py
│  └─ services/
│     ├─ animation_service_impl.py
│     ├─ drag_drop_service.py
│     ├─ event_system_service.py
│     ├─ file_dialog_service.py
│     ├─ message_display_service.py
│     ├─ opacity_effects_service.py
│     ├─ progress_ui_service.py
│     ├─ state_management_service.py
│     ├─ ui_coordination_service_impl.py
│     ├─ ui_layout_service.py
│     ├─ ui_text_management_service.py
│     ├─ visualization_integration_service.py
│     └─ window_configuration_service.py
├─ shared/
│  ├─ resource_helpers.py
│  └─ ui_theme_service.py
├─ system/
│  └─ user_notification_service.py
├─ ui_coordination/
│  ├─ animation_controller.py
│  ├─ animation_controller_deprecated.py
│  ├─ ui_coordinator.py
│  ├─ ui_coordinator_deprecated.py
│  └─ value_objects/
│     ├─ animation_state.py
│     ├─ element_type.py
│     ├─ event_system.py
│     ├─ message_display.py
│     ├─ state_management.py
│     ├─ timer_management.py
│     └─ ui_element_state.py
└─ ui_widgets/
   ├─ create_toggle_widget_presenter.py
   ├─ handle_widget_event_presenter.py
   ├─ toggle_widget.py
   ├─ toggle_widget_deprecated.py
   └─ value_objects/
      ├─ ui_widget_operations.py
      ├─ widget_dimensions.py
      ├─ widget_events.py
      └─ widget_styling.py
```

| Module/Path | Purpose | Key files (examples) | Used by (examples) | Notes |
|---|---|---|---|---|
| src/presentation/__init__.py | Package marker | — | Import convenience | — |
| src/presentation/core | Presentation foundations: container, patterns, abstractions, events | `container.py`, `patterns.py`, `abstractions.py` | `composition_root/container_configuration.py` (registers patterns and abstractions) | Core building blocks for UI services |
| src/presentation/main_window | Top-level window, controllers, components | `main_window.py`, controllers under `controllers/`, `builders/main_window_builder.py`, components | `main.py`, app orchestration and infra/presentation integration | Coordinates UI interactions and delegates to app layer |
| src/presentation/qt | Qt widgets/dialogs and services | `settings_dialog.py`, `toggle_switch_widget.py`, `voice_visualizer.py`, services under `qt/services/` | Infrastructure adapters and composition root; settings flows | Service implementations for app interfaces |
| src/presentation/shared | Theming and resource helpers | `ui_theme_service.py`, `resource_helpers.py` | Main window components, adapters | Styling and asset paths |
| src/presentation/system | User notifications | `user_notification_service.py` | Controllers/components | — |
| src/presentation/ui_coordination | UI coordination controllers and VO | `ui_coordinator.py`, `animation_controller.py`, VO under `value_objects/` | `qt/services/*`, controllers | Works with app `ui_coordination_service` interface |
| src/presentation/ui_widgets | Widget presenters and VO | `toggle_widget.py`, presenters, VO under `value_objects/` | `infrastructure/ui_widgets/widget_service_impl.py` and other widget flows | Presentation-side widget logic |

Notes
- The table groups per submodule for readability. We can expand to per-file rows for any section (e.g., `main_window/controllers`) on request.


### Complete src tree (generated by tree3 -g)

```text
src/
├── application/
│   ├── application_lifecycle/
│   │   ├── __init__.py
│   │   ├── activate_window_use_case.py
│   │   ├── check_single_instance_use_case.py
│   │   ├── manage_dialog_lifecycle_use_case.py
│   │   ├── shutdown_application_use_case.py
│   │   └── startup_application_use_case.py
│   ├── audio_recording/
│   │   ├── __init__.py
│   │   ├── configure_audio_use_case.py
│   │   ├── get_recording_status_use_case.py
│   │   ├── pause_recording_use_case.py
│   │   ├── resume_recording_use_case.py
│   │   ├── start_recording_use_case.py
│   │   └── stop_recording_use_case.py
│   ├── audio_visualization/
│   │   ├── __init__.py
│   │   ├── normalize_audio_use_case.py
│   │   ├── process_audio_data_use_case.py
│   │   ├── start_visualization_use_case.py
│   │   ├── stop_visualization_use_case.py
│   │   └── update_waveform_use_case.py
│   ├── configuration/
│   │   ├── __init__.py
│   │   ├── load_configuration_use_case.py
│   │   ├── save_configuration_use_case.py
│   │   ├── update_llm_config_use_case.py
│   │   └── update_model_config_use_case.py
│   ├── events/
│   │   ├── __init__.py
│   │   ├── application_events.py
│   │   └── event_publisher_service.py
│   ├── external_services/
│   │   ├── commands/
│   │   │   └── call_external_service_command.py
│   │   └── handlers/
│   │       ├── __init__.py
│   │       └── call_external_service_command_handler.py
│   ├── interfaces/
│   │   ├── __init__.py
│   │   ├── animation_service.py
│   │   ├── main_window_service.py
│   │   ├── ui_coordination_service.py
│   │   ├── widget_service.py
│   │   └── window_management_service.py
│   ├── listener/
│   │   ├── __init__.py
│   │   ├── audio_to_text_config.py
│   │   └── audio_to_text_service.py
│   ├── main_window/
│   │   ├── commands/
│   │   │   └── update_ui_text_command.py
│   │   ├── handlers/
│   │   │   ├── __init__.py
│   │   │   ├── get_ui_text_state_query_handler.py
│   │   │   └── update_ui_text_command_handler.py
│   │   ├── queries/
│   │   │   ├── get_hardware_capabilities_use_case.py
│   │   │   └── get_ui_text_state_query.py
│   │   ├── __init__.py
│   │   ├── configure_window_use_case.py
│   │   ├── create_main_window_use_case.py
│   │   ├── initialize_main_window_use_case.py
│   │   ├── integrate_visualization_use_case.py
│   │   ├── manage_opacity_effects_use_case.py
│   │   ├── manage_window_state_use_case.py
│   │   ├── setup_ui_layout_use_case.py
│   │   └── update_ui_text_use_case.py
│   ├── main_window_coordination/
│   │   ├── __init__.py
│   │   └── main_window_controller.py
│   ├── media_processing/
│   │   ├── __init__.py
│   │   ├── batch_transcribe_use_case.py
│   │   ├── convert_video_use_case.py
│   │   ├── process_media_files_use_case.py
│   │   ├── process_next_file_use_case.py
│   │   └── transcribe_audio_data_use_case.py
│   ├── progress_management/
│   │   ├── __init__.py
│   │   ├── complete_progress_use_case.py
│   │   ├── reparent_progress_bar_use_case.py
│   │   ├── start_progress_session_use_case.py
│   │   └── update_progress_use_case.py
│   ├── recording/
│   ├── services/
│   │   ├── __init__.py
│   │   └── application_startup_service.py
│   ├── settings/
│   │   ├── __init__.py
│   │   ├── apply_settings_use_case.py
│   │   ├── export_settings_use_case.py
│   │   ├── import_settings_use_case.py
│   │   ├── load_settings_use_case.py
│   │   ├── reset_settings_use_case.py
│   │   ├── reset_sound_settings_use_case.py
│   │   ├── save_settings_use_case.py
│   │   ├── update_hotkey_use_case.py
│   │   ├── update_sound_settings_use_case.py
│   │   └── validate_settings_use_case.py
│   ├── system_integration/
│   │   ├── __init__.py
│   │   ├── enable_drag_drop_use_case.py
│   │   ├── initialize_system_tray_use_case.py
│   │   ├── install_event_filter_use_case.py
│   │   ├── manage_geometry_use_case.py
│   │   ├── process_drag_drop_use_case.py
│   │   ├── process_key_event_use_case.py
│   │   └── setup_worker_threads_use_case.py
│   ├── transcription/
│   │   ├── __init__.py
│   │   ├── cancel_transcription_use_case.py
│   │   ├── configure_model_use_case.py
│   │   ├── get_transcription_history_use_case.py
│   │   ├── get_transcription_result_use_case.py
│   │   ├── start_transcription_use_case.py
│   │   └── validate_model_use_case.py
│   ├── ui_widgets/
│   │   ├── commands/
│   │   │   ├── __init__.py
│   │   │   └── handle_widget_event_command.py
│   │   ├── handlers/
│   │   │   ├── __init__.py
│   │   │   ├── get_widget_state_query_handler.py
│   │   │   └── handle_widget_event_command_handler.py
│   │   ├── queries/
│   │   │   ├── __init__.py
│   │   │   └── get_widget_state_query.py
│   │   ├── __init__.py
│   │   └── update_widget_state_use_case.py
│   ├── worker_management/
│   │   ├── __init__.py
│   │   ├── cleanup_worker_use_case.py
│   │   ├── initialize_llm_worker_use_case.py
│   │   └── initialize_workers_use_case.py
│   ├── __init__.py
│   ├── application_config.py
│   └── application_orchestrator.py
├── cache/
├── composition_root/
│   ├── __init__.py
│   └── container_configuration.py
├── domain/
│   ├── application_lifecycle/
│   │   ├── entities/
│   │   │   ├── __init__.py
│   │   │   ├── activation_configuration.py
│   │   │   ├── application_instance.py
│   │   │   ├── shutdown_configuration.py
│   │   │   ├── single_instance_configuration.py
│   │   │   ├── startup_configuration.py
│   │   │   └── window_info.py
│   │   ├── ports/
│   │   │   ├── __init__.py
│   │   │   ├── application_lifecycle_port.py
│   │   │   ├── single_instance_port.py
│   │   │   └── window_activation_port.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── enable_phase.py
│   │   │   ├── instance_check_method.py
│   │   │   ├── instance_check_result.py
│   │   │   ├── shutdown_phase.py
│   │   │   ├── shutdown_reason.py
│   │   │   ├── shutdown_result.py
│   │   │   ├── startup_phase.py
│   │   │   └── startup_result.py
│   │   └── __init__.py
│   ├── audio/
│   │   ├── entities/
│   │   │   ├── __init__.py
│   │   │   ├── audio_configuration.py
│   │   │   ├── audio_device.py
│   │   │   ├── audio_file.py
│   │   │   ├── audio_recorder.py
│   │   │   ├── audio_session.py
│   │   │   └── recording_state.py
│   │   ├── events/
│   │   │   └── __init__.py
│   │   ├── ports/
│   │   │   ├── audio_capture_port.py
│   │   │   └── audio_device_port.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── audio_configuration.py
│   │   │   ├── audio_data.py
│   │   │   ├── audio_format.py
│   │   │   ├── audio_operations.py
│   │   │   ├── audio_quality.py
│   │   │   ├── audio_samples.py
│   │   │   ├── audio_track.py
│   │   │   ├── channel_count.py
│   │   │   ├── duration.py
│   │   │   ├── listener_operations.py
│   │   │   ├── playback_mode.py
│   │   │   ├── playback_operation.py
│   │   │   ├── playback_result.py
│   │   │   ├── playback_state.py
│   │   │   ├── recording_operation.py
│   │   │   ├── recording_result.py
│   │   │   ├── recording_state.py
│   │   │   ├── sample_rate.py
│   │   │   ├── service_requests.py
│   │   │   ├── status_metrics.py
│   │   │   ├── stream_operations.py
│   │   │   ├── vad_operations.py
│   │   │   ├── validation.py
│   │   │   └── validation_operations.py
│   │   └── __init__.py
│   ├── audio_visualization/
│   │   ├── entities/
│   │   │   ├── __init__.py
│   │   │   ├── audio_processor.py
│   │   │   └── visualizer.py
│   │   ├── ports/
│   │   │   ├── __init__.py
│   │   │   ├── audio_data_provider_port.py
│   │   │   ├── integration_ports.py
│   │   │   ├── visualization_renderer_port.py
│   │   │   └── waveform_update_port.py
│   │   ├── protocols/
│   │   │   ├── __init__.py
│   │   │   ├── audio_buffer_protocol.py
│   │   │   ├── audio_conversion_protocol.py
│   │   │   ├── audio_normalization_protocol.py
│   │   │   ├── audio_processing_protocol.py
│   │   │   ├── audio_statistics_protocol.py
│   │   │   ├── audio_validation_protocol.py
│   │   │   ├── logger_protocol.py
│   │   │   └── signal_emission_protocol.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── audio_buffer.py
│   │   │   ├── normalization_configuration.py
│   │   │   ├── normalization_types.py
│   │   │   ├── processing_types.py
│   │   │   ├── visualization_configuration.py
│   │   │   ├── visualization_control.py
│   │   │   ├── visualization_data.py
│   │   │   ├── visualization_settings.py
│   │   │   └── waveform_data.py
│   │   └── __init__.py
│   ├── common/
│   │   ├── entities/
│   │   │   ├── __init__.py
│   │   │   ├── download_progress.py
│   │   │   └── processing_status.py
│   │   ├── errors/
│   │   │   └── domain_errors.py
│   │   ├── ports/
│   │   │   ├── __init__.py
│   │   │   ├── application_state_port.py
│   │   │   ├── cache_key_port.py
│   │   │   ├── command_line_port.py
│   │   │   ├── concurrency_management_port.py
│   │   │   ├── concurrency_port.py
│   │   │   ├── dependency_injection_port.py
│   │   │   ├── dialog_lifecycle_port.py
│   │   │   ├── environment_port.py
│   │   │   ├── error_callback_port.py
│   │   │   ├── event_publisher_port.py
│   │   │   ├── file_system_port.py
│   │   │   ├── id_generation_port.py
│   │   │   ├── logger_port.py
│   │   │   ├── logging_port.py
│   │   │   ├── progress_notification_port.py
│   │   │   ├── serialization_port.py
│   │   │   ├── text_paste_port.py
│   │   │   ├── threading_port.py
│   │   │   ├── time_management_port.py
│   │   │   ├── time_port.py
│   │   │   ├── ui_component_port.py
│   │   │   ├── ui_framework_port.py
│   │   │   └── ui_status_port.py
│   │   ├── __init__.py
│   │   ├── abstractions.py
│   │   ├── aggregate_root.py
│   │   ├── domain_result.py
│   │   ├── domain_utils.py
│   │   ├── entity.py
│   │   ├── errors.py
│   │   ├── events.py
│   │   ├── progress_callback.py
│   │   ├── result.py
│   │   ├── value_object.py
│   │   └── value_objects.py
│   ├── file_operations/
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── cleanup_level.py
│   │   │   ├── drop_action.py
│   │   │   ├── drop_zone_type.py
│   │   │   ├── file_operations.py
│   │   │   ├── file_type.py
│   │   │   ├── output_configuration.py
│   │   │   ├── processing_mode.py
│   │   │   └── validation_level.py
│   │   └── __init__.py
│   ├── llm/
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── llm_model_name.py
│   │   │   ├── llm_prompt.py
│   │   │   └── llm_quantization_level.py
│   │   └── __init__.py
│   ├── main_window/
│   │   ├── entities/
│   │   │   ├── __init__.py
│   │   │   ├── main_window.py
│   │   │   ├── main_window_instance.py
│   │   │   ├── ui_layout.py
│   │   │   ├── visualization_integration.py
│   │   │   └── window_configuration.py
│   │   ├── events/
│   │   │   └── window_events.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── color_palette.py
│   │   │   ├── icon_path.py
│   │   │   ├── opacity_level.py
│   │   │   └── z_order_level.py
│   │   └── __init__.py
│   ├── media/
│   │   ├── entities/
│   │   │   ├── __init__.py
│   │   │   ├── batch_processing_session.py
│   │   │   ├── conversion_job.py
│   │   │   └── media_file.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── conversion_operations.py
│   │   │   ├── conversion_quality.py
│   │   │   ├── file_format.py
│   │   │   ├── media_duration.py
│   │   │   ├── processing_operations.py
│   │   │   └── transcription_operations.py
│   │   └── __init__.py
│   ├── progress_management/
│   │   ├── entities/
│   │   │   ├── __init__.py
│   │   │   ├── download_progress.py
│   │   │   ├── progress_bar_lifecycle.py
│   │   │   └── progress_session.py
│   │   ├── ports/
│   │   │   ├── __init__.py
│   │   │   └── progress_callback_port.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── progress_info.py
│   │   │   ├── progress_percentage.py
│   │   │   └── progress_state.py
│   │   └── __init__.py
│   ├── settings/
│   │   ├── entities/
│   │   │   ├── __init__.py
│   │   │   ├── hotkey_binding.py
│   │   │   ├── settings_configuration.py
│   │   │   └── user_preferences.py
│   │   ├── events/
│   │   │   ├── __init__.py
│   │   │   └── settings_events.py
│   │   ├── ports/
│   │   │   ├── __init__.py
│   │   │   └── sound_settings_port.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── audio_configuration.py
│   │   │   ├── configuration_operations.py
│   │   │   ├── file_path.py
│   │   │   ├── key_combination.py
│   │   │   ├── llm_configuration.py
│   │   │   ├── load_strategy.py
│   │   │   ├── model_configuration.py
│   │   │   ├── settings_operations.py
│   │   │   └── update_operations.py
│   │   └── __init__.py
│   ├── system_integration/
│   │   ├── entities/
│   │   │   ├── __init__.py
│   │   │   ├── event_system_integration.py
│   │   │   ├── system_tray_integration.py
│   │   │   └── worker_thread_coordination.py
│   │   ├── ports/
│   │   │   ├── __init__.py
│   │   │   ├── drag_drop_port.py
│   │   │   ├── event_processing_port.py
│   │   │   ├── hardware_capabilities_port.py
│   │   │   ├── platform_service_port.py
│   │   │   ├── system_tray_port.py
│   │   │   └── ui_integration_ports.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── drag_drop_operations.py
│   │   │   ├── event_filtering.py
│   │   │   ├── geometry_management.py
│   │   │   ├── method_delegation.py
│   │   │   ├── system_operations.py
│   │   │   ├── thread_management.py
│   │   │   ├── thread_reference.py
│   │   │   └── tray_icon_path.py
│   │   └── __init__.py
│   ├── transcription/
│   │   ├── entities/
│   │   │   ├── __init__.py
│   │   │   ├── model_instance.py
│   │   │   ├── transcription_result.py
│   │   │   ├── transcription_segment.py
│   │   │   └── transcription_session.py
│   │   ├── events/
│   │   │   └── __init__.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── audio_data.py
│   │   │   ├── confidence_score.py
│   │   │   ├── download_progress.py
│   │   │   ├── language.py
│   │   │   ├── message_display_callback.py
│   │   │   ├── model_configuration.py
│   │   │   ├── model_name.py
│   │   │   ├── model_size.py
│   │   │   ├── model_type.py
│   │   │   ├── progress_callback.py
│   │   │   ├── quantization.py
│   │   │   ├── quantization_level.py
│   │   │   ├── transcription_configuration.py
│   │   │   ├── transcription_operations.py
│   │   │   ├── transcription_quality.py
│   │   │   ├── transcription_request.py
│   │   │   ├── transcription_result.py
│   │   │   ├── transcription_segment.py
│   │   │   ├── transcription_state.py
│   │   │   ├── transcription_status.py
│   │   │   └── transcription_text.py
│   │   ├── __init__.py
│   │   └── ports.py
│   ├── ui_coordination/
│   │   ├── entities/
│   │   │   └── __init__.py
│   │   ├── ports/
│   │   │   ├── __init__.py
│   │   │   ├── ui_layout_port.py
│   │   │   ├── ui_state_management_port.py
│   │   │   ├── widget_operation_port.py
│   │   │   └── window_management_port.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── drag_drop_operations.py
│   │   │   ├── event_system.py
│   │   │   ├── opacity_effects.py
│   │   │   ├── ui_abstractions.py
│   │   │   ├── ui_coordination_types.py
│   │   │   ├── ui_layout.py
│   │   │   ├── ui_state_management.py
│   │   │   ├── window_operations.py
│   │   │   ├── window_position.py
│   │   │   ├── window_size.py
│   │   │   └── window_state.py
│   │   └── __init__.py
│   ├── ui_widgets/
│   │   ├── entities/
│   │   │   └── __init__.py
│   │   ├── events/
│   │   │   └── widget_events.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   └── widget_events.py
│   │   └── __init__.py
│   ├── window_management/
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── activation_method.py
│   │   │   ├── activation_result.py
│   │   │   ├── layout_type.py
│   │   │   ├── reparent_direction.py
│   │   │   ├── restoration_mode.py
│   │   │   ├── widget_layering.py
│   │   │   └── window_state.py
│   │   └── __init__.py
│   ├── worker_management/
│   │   ├── entities/
│   │   │   ├── __init__.py
│   │   │   ├── thread_instance.py
│   │   │   └── worker_instance.py
│   │   ├── ports/
│   │   │   ├── __init__.py
│   │   │   ├── worker_communication_port.py
│   │   │   ├── worker_factory_port.py
│   │   │   ├── worker_lifecycle_port.py
│   │   │   ├── worker_management_port.py
│   │   │   └── worker_thread_ports.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── worker_configuration.py
│   │   │   ├── worker_imports.py
│   │   │   └── worker_operations.py
│   │   └── __init__.py
│   ├── __init__.py
│   ├── ui_text.py
│   ├── ui_widget_operations.py
│   └── window_state_management.py
├── infrastructure/
│   ├── adapters/
│   │   ├── application_lifecycle/
│   │   │   ├── __init__.py
│   │   │   └── pyqt_application_lifecycle_adapter.py
│   │   ├── pyqt6/
│   │   │   ├── __init__.py
│   │   │   └── widget_adapters.py
│   │   ├── ui/
│   │   │   ├── __init__.py
│   │   │   └── pyqt6_ui_adapter.py
│   │   ├── __init__.py
│   │   ├── audio_device_adapter.py
│   │   ├── audio_to_text_bridge_adapter.py
│   │   ├── configuration_adapter.py
│   │   ├── dependency_injection_adapter.py
│   │   ├── file_system_adapter.py
│   │   ├── keyboard_adapter.py
│   │   ├── listener_adapter.py
│   │   ├── logging_adapter.py
│   │   ├── model_worker_adapter.py
│   │   ├── qt_drag_drop_adapter.py
│   │   ├── qt_system_tray_adapter.py
│   │   ├── resource_adapter.py
│   │   ├── serialization_adapter.py
│   │   ├── sound_player_adapter.py
│   │   ├── text_paste_adapter.py
│   │   └── transcription_adapter.py
│   ├── audio/
│   │   ├── __init__.py
│   │   ├── audio_buffer_service.py
│   │   ├── audio_data_conversion_service.py
│   │   ├── audio_data_validation_service.py
│   │   ├── audio_device_service.py
│   │   ├── audio_file_repository.py
│   │   ├── audio_file_service.py
│   │   ├── audio_normalization_service.py
│   │   ├── audio_playback_service.py
│   │   ├── audio_processing_service.py
│   │   ├── audio_processor.py
│   │   ├── audio_recording_service.py
│   │   ├── audio_stream_service.py
│   │   ├── audio_validation_service.py
│   │   ├── consolidated_listener_service.py
│   │   ├── keyboard_service.py
│   │   ├── listener_worker_service.py
│   │   ├── logger_service.py
│   │   ├── playback_validation_service.py
│   │   ├── pyaudio_core_service.py
│   │   ├── pyaudio_protocols.py
│   │   ├── pyaudio_recorder.py
│   │   ├── pyaudio_service.py
│   │   ├── pyaudio_types.py
│   │   ├── pyqt_audio_adapter.py
│   │   ├── recording_validation_service.py
│   │   ├── service_factory.py
│   │   ├── signal_emission_service.py
│   │   ├── sounddevice_sound_player_adapter.py
│   │   └── vad_worker_service.py
│   ├── audio_visualization/
│   │   ├── __init__.py
│   │   ├── audio_data_provider_service.py
│   │   ├── audio_normalization_service.py
│   │   ├── audio_processor_service.py
│   │   ├── audio_stream_service.py
│   │   ├── buffer_management_service.py
│   │   ├── resource_cleanup_service.py
│   │   └── visualization_controller_service.py
│   ├── common/
│   │   ├── bytes_io_adapter.py
│   │   ├── configuration_service.py
│   │   ├── event_bus.py
│   │   ├── file_audio_writer.py
│   │   ├── progress_callback.py
│   │   ├── repository_base.py
│   │   ├── resource_service.py
│   │   ├── sync_service.py
│   │   ├── task_manager.py
│   │   ├── threading_service.py
│   │   ├── time_service.py
│   │   ├── ui_status_dispatch.py
│   │   └── unit_of_work.py
│   ├── container/
│   │   ├── infrastructure_service_registry.py
│   │   └── service_registration.py
│   ├── llm/
│   │   ├── __init__.py
│   │   ├── gemma_inference_service.py
│   │   ├── llm_pyqt_worker_service.py
│   │   └── llm_worker_service.py
│   ├── main_window/
│   │   ├── __init__.py
│   │   ├── main_window_factory_service.py
│   │   └── main_window_service_impl.py
│   ├── media/
│   │   ├── __init__.py
│   │   ├── batch_processor_service.py
│   │   ├── file_validation_service.py
│   │   ├── folder_scanning_service.py
│   │   ├── media_conversion_service.py
│   │   ├── media_info_service.py
│   │   ├── media_scanner_service.py
│   │   └── video_conversion_service.py
│   ├── presentation/
│   │   ├── qt/
│   │   │   ├── __init__.py
│   │   │   ├── animation_strategies.py
│   │   │   ├── application_bootstrap.py
│   │   │   ├── hotkey_config_widget.py
│   │   │   ├── llm_config_widget.py
│   │   │   ├── main_window.py
│   │   │   ├── model_config_widget.py
│   │   │   ├── progress_management_widget.py
│   │   │   ├── resource_management_component.py
│   │   │   ├── settings_dialog.py
│   │   │   ├── settings_dialog_coordinator.py
│   │   │   ├── settings_event_filter.py
│   │   │   ├── settings_lifecycle.py
│   │   │   ├── sound_config_widget.py
│   │   │   ├── toggle_switch_widget.py
│   │   │   ├── translation_component.py
│   │   │   ├── ui_core_abstractions.py
│   │   │   ├── ui_core_patterns.py
│   │   │   ├── ui_setup_component.py
│   │   │   ├── visualization_component.py
│   │   │   ├── voice_visualizer.py
│   │   │   ├── widget_layout_component.py
│   │   │   ├── window_config_component.py
│   │   │   ├── worker_integration.py
│   │   │   └── worker_integration_orchestrator.py
│   │   ├── system/
│   │   │   ├── __init__.py
│   │   │   └── error_handling_service.py
│   │   └── __init__.py
│   ├── progress_management/
│   │   ├── __init__.py
│   │   ├── progress_bar_reparenting_service.py
│   │   ├── progress_tracking_service.py
│   │   ├── timer_management_service.py
│   │   └── ui_state_management_service.py
│   ├── settings/
│   │   ├── __init__.py
│   │   ├── file_system_service.py
│   │   ├── hotkey_recording_service.py
│   │   ├── json_settings_repository.py
│   │   ├── settings_file_repository.py
│   │   ├── settings_migration_service.py
│   │   ├── settings_repository.py
│   │   └── settings_validator.py
│   ├── system/
│   │   ├── __init__.py
│   │   ├── application_lifecycle_service.py
│   │   ├── environment_service.py
│   │   ├── hardware_capabilities_adapter.py
│   │   ├── logging_service.py
│   │   ├── platform_service.py
│   │   ├── single_instance_service.py
│   │   ├── subprocess_service.py
│   │   ├── tray_icon_service.py
│   │   ├── window_activation_service.py
│   │   └── window_management_service_impl.py
│   ├── system_integration/
│   │   ├── __init__.py
│   │   ├── keyboard_hook_adapter.py
│   │   ├── method_delegation_service.py
│   │   ├── pynput_keyboard_adapter.py
│   │   └── pyperclip_adapter.py
│   ├── transcription/
│   │   ├── __init__.py
│   │   ├── model_worker_service.py
│   │   ├── onnx_transcription_service.py
│   │   └── transcription_file_repository.py
│   ├── ui/
│   │   └── __init__.py
│   ├── ui_widgets/
│   │   ├── __init__.py
│   │   └── widget_service_impl.py
│   ├── worker/
│   │   ├── __init__.py
│   │   └── worker_imports_configuration.py
│   ├── __init__.py
│   └── audio_normalization_service.py
├── presentation/
│   ├── adapters/
│   │   ├── __init__.py
│   │   ├── pyqtgraph_renderer_adapter.py
│   │   └── ui_status_adapter.py
│   ├── core/
│   │   ├── abstractions.py
│   │   ├── abstractions_deprecated.py
│   │   ├── container.py
│   │   ├── events.py
│   │   ├── patterns.py
│   │   └── ui_abstractions.py
│   ├── main_window/
│   │   ├── builders/
│   │   │   ├── __init__.py
│   │   │   └── main_window_builder.py
│   │   ├── components/
│   │   │   ├── __init__.py
│   │   │   ├── progress_indicator_component.py
│   │   │   └── status_display_component.py
│   │   ├── controllers/
│   │   │   ├── __init__.py
│   │   │   ├── drag_drop_coordination_controller.py
│   │   │   ├── drag_drop_event_controller.py
│   │   │   ├── settings_controller.py
│   │   │   ├── tray_coordination_controller.py
│   │   │   ├── ui_construction_controller.py
│   │   │   ├── ui_state_controller.py
│   │   │   └── window_minimize_controller.py
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── color_palette.py
│   │   │   ├── icon_path.py
│   │   │   ├── opacity_effects.py
│   │   │   ├── opacity_level.py
│   │   │   ├── ui_layout.py
│   │   │   ├── ui_text.py
│   │   │   ├── visualization_integration.py
│   │   │   ├── window_configuration.py
│   │   │   ├── window_operations.py
│   │   │   ├── window_state_management.py
│   │   │   └── z_order_level.py
│   │   ├── __init__.py
│   │   └── main_window.py
│   ├── qt/
│   │   ├── services/
│   │   │   ├── animation_service_impl.py
│   │   │   ├── drag_drop_service.py
│   │   │   ├── event_system_service.py
│   │   │   ├── file_dialog_service.py
│   │   │   ├── message_display_service.py
│   │   │   ├── opacity_effects_service.py
│   │   │   ├── progress_ui_service.py
│   │   │   ├── state_management_service.py
│   │   │   ├── ui_coordination_service_impl.py
│   │   │   ├── ui_layout_service.py
│   │   │   ├── ui_text_management_service.py
│   │   │   ├── visualization_integration_service.py
│   │   │   ├── widget_layering_service.py
│   │   │   └── window_configuration_service.py
│   │   ├── __init__.py
│   │   ├── settings_dialog.py
│   │   ├── settings_dialog_coordinator.py
│   │   ├── settings_dialog_impl.py
│   │   ├── toggle_switch_widget.py
│   │   └── voice_visualizer.py
│   ├── shared/
│   │   ├── __init__.py
│   │   ├── resource_helpers.py
│   │   └── ui_theme_service.py
│   ├── system/
│   │   └── user_notification_service.py
│   ├── ui_coordination/
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── animation_state.py
│   │   │   ├── element_type.py
│   │   │   ├── event_system.py
│   │   │   ├── message_display.py
│   │   │   ├── state_management.py
│   │   │   ├── timer_management.py
│   │   │   └── ui_element_state.py
│   │   ├── __init__.py
│   │   ├── animation_controller.py
│   │   ├── animation_controller_deprecated.py
│   │   ├── ui_coordinator.py
│   │   └── ui_coordinator_deprecated.py
│   ├── ui_widgets/
│   │   ├── value_objects/
│   │   │   ├── __init__.py
│   │   │   ├── ui_widget_operations.py
│   │   │   ├── widget_dimensions.py
│   │   │   ├── widget_events.py
│   │   │   └── widget_styling.py
│   │   ├── __init__.py
│   │   ├── create_toggle_widget_presenter.py
│   │   ├── handle_widget_event_presenter.py
│   │   ├── toggle_widget.py
│   │   ├── toggle_widget_deprecated.py
│   │   └── widget_state.py
│   ├── __init__.py
│   └── value_objects.py
├── resources/
│   ├── Command-Reset-256.png
│   ├── edit.png
│   ├── gear.png
│   ├── open-folder.png
│   ├── splash.wav
│   ├── stop.png
│   ├── switch-off.png
│   ├── switch-on.png
│   ├── Untitled-1.png
│   ├── untitled.png
│   └── Windows 1 Theta.png
├── __init__.py
└── main.py
```

