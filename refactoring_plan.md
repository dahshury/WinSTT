# WinSTT Vertical Slice Architecture Refactoring Plan

## Executive Summary

This document presents a comprehensive refactoring strategy that transforms WinSTT from its current mixed architecture into a clean, maintainable desktop application using **Vertical Slice Architecture** with **Domain-Driven Design** (DDD) principles and **MediatR patterns**, building upon the existing **UIContainer** dependency injection system and **PyQt worker patterns**.

**Key Benefits:**

- 🏗️ **Vertical Slices**: Self-contained features with complete functionality
- 🧩 **Domain-Driven Design**: Rich domain models with business logic
- 🔧 **MediatR Pattern**: Commands/queries for all business operations
- 🧪 **Enhanced Testability**: Clean separation and dependency injection
- 📈 **Feature Independence**: Minimal cross-feature dependencies
- ⚡ **Existing Pattern Integration**: Builds on current UIContainer and PyQt workers

## Current State Analysis

### Architecture Issues Identified

| Component | Current Issues | Impact | Priority |
|-----------|---------------|--------|----------|
| **src/main.py** (147 lines) | Mixed startup, UI, and infrastructure concerns | High | Critical |
| **utils/listener.py** (575 lines) | Direct hardware access, mixed business logic | Very High | Critical |
| **utils/transcribe.py** (978 lines) | ML logic mixed with infrastructure | Very High | Critical |
| **src/ui/window_methods.py** (1454 lines) | Massive procedural file, tight coupling | Very High | Critical |
| **src/ui/settings_dialog.py** (1744 lines) | Business logic mixed with UI | High | High |
| **src/workers/worker_classes.py** (306 lines) | Threading concerns mixed with business logic | High | High |

### Existing Strengths to Preserve

| Component | Strengths | Preservation Strategy |
|-----------|----------|---------------------|
| **UIContainer** | Professional IoC container with lifecycle management | Extend for feature registration |
| **PyQt Worker Pattern** | Clean signal-based async operations | Adapt for feature handlers |
| **Resource Management** | Organized cache structure and resource paths | Integrate into infrastructure layer |
| **Single Instance Pattern** | Robust application instance management | Incorporate into application shell |
| **Event System** | Existing Qt signal infrastructure | Enhance with domain events |

### Total Technical Debt

- **Lines of Code to Refactor**: ~4,200 lines
- **Architectural Violations**: 15+ major violations
- **Dependency Direction Issues**: UI → Infrastructure (should be reversed)
- **Testing Challenges**: Hard dependencies, no mocking capabilities

## Target Architecture: Vertical Slice Design with Existing Patterns

### Core Architectural Principles

1. **Vertical Slice Architecture**
   - Features organized as self-contained slices
   - Each slice contains all layers needed for the feature
   - Minimal cross-slice dependencies
   - Business capability-focused organization

2. **Domain-Driven Design (DDD)**
   - Rich domain models with business logic
   - Aggregate roots for consistency boundaries
   - Value objects for type safety
   - Domain events for decoupling

3. **MediatR Pattern with PyQt Integration**
   - Commands for state changes
   - Queries for data retrieval
   - Handlers integrate with existing PyQt workers
   - Clean separation of concerns

4. **Enhanced UIContainer Pattern**
   - Extend existing UIContainer for feature registration
   - Service lifetime management (Singleton, Transient, Scoped)
   - Automatic constructor injection
   - Thread-safe service resolution

### Project Structure

```
src/
├── domain/                           # Pure business logic (follows project rules)
│   ├── common/                       # DDD base classes and patterns
│   │   ├── aggregate_root.py         # Base aggregate root with domain events
│   │   ├── entity.py                 # Base entity with identity
│   │   ├── value_object.py           # Base value object with equality
│   │   ├── domain_event.py           # Domain event system
│   │   ├── result.py                 # Result pattern for fallible operations
│   │   └── repository.py             # Repository contracts
│   ├── audio/                        # Audio domain
│   │   ├── entities/
│   │   │   ├── audio_session.py      # AudioSession aggregate (from listener.py logic)
│   │   │   └── recording_state.py    # Recording state entity
│   │   ├── value_objects/
│   │   │   ├── audio_config.py       # Audio configuration (PyAudio settings)
│   │   │   ├── duration.py           # Time duration with validation
│   │   │   ├── sample_rate.py        # Sample rate with invariants
│   │   │   └── audio_quality.py      # Quality settings
│   │   ├── events/
│   │   │   ├── recording_started.py  # Recording started domain event
│   │   │   ├── recording_stopped.py  # Recording stopped domain event
│   │   │   └── audio_processed.py    # Audio processed domain event
│   │   └── contracts/
│   │       ├── audio_repository.py   # Audio data repository contract
│   │       └── audio_service.py      # Audio processing service contract
│   ├── transcription/                # Transcription domain
│   │   ├── entities/
│   │   │   ├── transcription_result.py # Transcription result aggregate
│   │   │   └── model_instance.py     # Model instance entity (ONNX models)
│   │   ├── value_objects/
│   │   │   ├── model_config.py       # Model configuration (whisper settings)
│   │   │   ├── language.py           # Language settings with validation
│   │   │   ├── confidence_score.py   # Confidence metrics
│   │   │   └── quantization_type.py  # Quantization type (Full/Quantized)
│   │   ├── events/
│   │   │   ├── model_loaded.py       # Model loaded domain event
│   │   │   ├── transcription_completed.py # Transcription completed event
│   │   │   └── model_download_progress.py # Download progress event
│   │   └── contracts/
│   │       ├── model_repository.py   # Model storage repository contract
│   │       └── transcription_service.py # Transcription service contract
│   ├── llm/                          # LLM processing domain
│   │   ├── entities/
│   │   │   ├── llm_request.py        # LLM request aggregate
│   │   │   └── processing_result.py  # Processing result entity
│   │   ├── value_objects/
│   │   │   ├── prompt_template.py    # Prompt templates with validation
│   │   │   ├── model_type.py         # LLM model types (gemma variants)
│   │   │   └── processing_options.py # Processing options
│   │   ├── events/
│   │   │   ├── text_processed.py     # Text processed domain event
│   │   │   └── llm_model_changed.py  # Model changed domain event
│   │   └── contracts/
│   │       └── llm_service.py        # LLM processing service contract
│   └── settings/                     # Settings domain
│       ├── entities/
│       │   ├── user_preferences.py   # User preferences aggregate
│       │   └── hotkey_binding.py     # Hotkey binding entity
│       ├── value_objects/
│       │   ├── key_combination.py    # Key combination with validation
│       │   ├── file_path.py          # File path handling with validation
│       │   └── theme_settings.py     # UI theme settings
│       ├── events/
│       │   ├── settings_changed.py   # Settings changed domain event
│       │   └── hotkey_updated.py     # Hotkey updated domain event
│       └── contracts/
│           └── settings_repository.py # Settings persistence contract
├── features/                         # Vertical feature slices (self-contained)
│   ├── audio_recording/              # Audio recording feature slice
│   │   ├── commands/
│   │   │   ├── start_recording.py    # Start recording command
│   │   │   ├── stop_recording.py     # Stop recording command
│   │   │   └── configure_audio.py    # Configure audio command
│   │   ├── queries/
│   │   │   ├── get_recording_status.py # Get status query
│   │   │   ├── get_audio_devices.py  # Get devices query
│   │   │   └── get_audio_levels.py   # Get audio levels query
│   │   ├── handlers/
│   │   │   ├── start_recording_handler.py # Command handler (uses PyQt workers)
│   │   │   ├── stop_recording_handler.py  # Command handler
│   │   │   └── audio_status_handler.py    # Query handler
│   │   ├── ui/
│   │   │   ├── recording_controls.py  # Recording UI controls (PyQt widgets)
│   │   │   ├── audio_visualizer.py    # Audio visualization widget
│   │   │   └── device_selector.py     # Device selection UI
│   │   ├── infrastructure/
│   │   │   ├── pyaudio_service.py     # PyAudio implementation
│   │   │   ├── vad_service.py         # VAD implementation (VaDetector integration)
│   │   │   ├── audio_repository.py    # Audio data persistence
│   │   │   └── qt_audio_worker.py     # PyQt worker for audio operations
│   │   └── api.py                     # Feature public API
│   ├── transcription/                # Transcription feature slice
│   │   ├── commands/
│   │   │   ├── transcribe_audio.py    # Transcribe command
│   │   │   ├── load_model.py          # Load model command
│   │   │   └── download_model.py      # Download model command
│   │   ├── queries/
│   │   │   ├── get_transcription_history.py # History query
│   │   │   ├── get_available_models.py      # Models query
│   │   │   └── get_model_status.py          # Model status query
│   │   ├── handlers/
│   │   │   ├── transcribe_handler.py         # Transcription handler (integrates ModelWorker)
│   │   │   ├── model_management_handler.py   # Model handler
│   │   │   └── transcription_query_handler.py # Query handler
│   │   ├── ui/
│   │   │   ├── transcription_progress.py     # Progress display widget
│   │   │   ├── model_selector.py            # Model selection widget
│   │   │   └── result_display.py            # Result display widget
│   │   ├── infrastructure/
│   │   │   ├── onnx_transcription_service.py # ONNX implementation (WhisperONNXTranscriber)
│   │   │   ├── model_download_service.py     # Model downloads with progress
│   │   │   ├── model_cache_service.py        # Model caching (organized cache structure)
│   │   │   ├── transcription_repository.py   # Result persistence
│   │   │   └── qt_transcription_worker.py    # PyQt worker for transcription
│   │   └── api.py                            # Feature public API
│   ├── llm_processing/               # LLM processing feature slice
│   │   ├── commands/
│   │   │   ├── process_text.py        # Process text command
│   │   │   ├── configure_llm.py       # Configure LLM command
│   │   │   └── load_llm_model.py      # Load LLM model command
│   │   ├── queries/
│   │   │   ├── get_processing_history.py # History query
│   │   │   ├── get_llm_models.py         # LLM models query
│   │   │   └── get_prompt_templates.py   # Templates query
│   │   ├── handlers/
│   │   │   ├── text_processing_handler.py # Processing handler (integrates LLMWorker)
│   │   │   ├── llm_config_handler.py      # Config handler
│   │   │   └── llm_query_handler.py       # Query handler
│   │   ├── ui/
│   │   │   ├── processing_options.py      # Processing options UI
│   │   │   ├── prompt_editor.py           # Prompt editor widget
│   │   │   └── result_formatter.py        # Result formatting widget
│   │   ├── infrastructure/
│   │   │   ├── onnx_llm_service.py        # ONNX LLM implementation (gemma integration)
│   │   │   ├── prompt_template_service.py # Template management
│   │   │   ├── llm_repository.py          # LLM data persistence
│   │   │   └── qt_llm_worker.py           # PyQt worker for LLM operations
│   │   └── api.py                         # Feature public API
│   ├── settings_management/          # Settings management feature slice
│   │   ├── commands/
│   │   │   ├── update_preferences.py     # Update preferences command
│   │   │   ├── set_hotkey.py             # Set hotkey command
│   │   │   └── reset_settings.py         # Reset settings command
│   │   ├── queries/
│   │   │   ├── get_current_settings.py   # Current settings query
│   │   │   ├── get_default_settings.py   # Default settings query
│   │   │   └── validate_settings.py      # Settings validation query
│   │   ├── handlers/
│   │   │   ├── settings_update_handler.py # Update handler
│   │   │   ├── hotkey_handler.py          # Hotkey handler
│   │   │   └── settings_query_handler.py  # Query handler
│   │   ├── ui/
│   │   │   ├── settings_dialog.py         # Settings dialog (refactored from current)
│   │   │   ├── hotkey_editor.py           # Hotkey editor widget
│   │   │   └── preferences_panel.py       # Preferences panel widget
│   │   ├── infrastructure/
│   │   │   ├── json_settings_repository.py # JSON persistence (get_config integration)
│   │   │   ├── hotkey_service.py           # Hotkey handling (pynput integration)
│   │   │   └── validation_service.py       # Settings validation
│   │   └── api.py                          # Feature public API
│   ├── file_processing/              # File processing feature slice
│   │   ├── commands/
│   │   │   ├── process_file.py           # Process file command
│   │   │   ├── batch_process.py          # Batch process command
│   │   │   └── save_transcription.py     # Save result command
│   │   ├── queries/
│   │   │   ├── get_supported_formats.py  # Formats query
│   │   │   ├── get_processing_queue.py   # Queue status query
│   │   │   └── get_file_info.py          # File info query
│   │   ├── handlers/
│   │   │   ├── file_processing_handler.py # Processing handler
│   │   │   ├── batch_handler.py           # Batch handler
│   │   │   └── file_query_handler.py      # Query handler
│   │   ├── ui/
│   │   │   ├── file_drop_zone.py         # Drag & drop UI (integrates dragEnterEvent)
│   │   │   ├── batch_progress.py         # Batch progress widget
│   │   │   └── file_browser.py           # File browser widget
│   │   ├── infrastructure/
│   │   │   ├── file_system_service.py    # File system operations
│   │   │   ├── audio_file_service.py     # Audio file handling
│   │   │   └── export_service.py         # Export functionality (SRT support)
│   │   └── api.py                        # Feature public API
│   └── application_shell/            # Application shell feature slice
│       ├── commands/
│       │   ├── startup_app.py            # Application startup command
│       │   ├── shutdown_app.py           # Application shutdown command
│       │   └── show_notification.py      # Show notification command
│       ├── queries/
│       │   ├── get_app_status.py         # App status query
│       │   ├── get_system_info.py        # System info query
│       │   └── get_performance_metrics.py # Performance query
│       ├── handlers/
│       │   ├── app_lifecycle_handler.py  # Lifecycle handler
│       │   ├── notification_handler.py   # Notification handler
│       │   └── app_query_handler.py      # Query handler
│       ├── ui/
│       │   ├── main_window.py            # Main window (refactored from current)
│       │   ├── system_tray.py            # System tray (integrates existing tray_icon)
│       │   └── splash_screen.py          # Splash screen widget
│       ├── infrastructure/
│       │   ├── single_instance_service.py # Single instance (integrates existing pattern)
│       │   ├── system_integration_service.py # OS integration (win32gui integration)
│       │   └── notification_service.py    # System notifications
│       └── api.py                         # Feature public API
├── shared/                           # Cross-cutting concerns (enhanced existing patterns)
│   ├── mediator/                     # MediatR implementation
│   │   ├── mediator.py               # Main mediator (integrates with UIContainer)
│   │   ├── command.py                # Command base classes
│   │   ├── query.py                  # Query base classes
│   │   ├── handler.py                # Handler base classes (PyQt worker integration)
│   │   └── registry.py               # Handler registry (extends UIContainer)
│   ├── di/                           # Extended dependency injection
│   │   ├── container_extensions.py   # Extensions to existing UIContainer
│   │   ├── feature_registration.py   # Feature service registration
│   │   └── lifecycle_manager.py      # Enhanced service lifetimes
│   ├── events/                       # Enhanced event system
│   │   ├── domain_event_bus.py       # Domain event bus (extends UIEventSystem)
│   │   ├── qt_event_adapter.py       # Qt signal to domain event adapter
│   │   └── event_dispatcher.py       # Event dispatcher
│   ├── utils/                        # Shared utilities (enhanced existing)
│   │   ├── logging.py                # Logging utilities (integrates logger module)
│   │   ├── validation.py             # Validation helpers
│   │   ├── resource_paths.py         # Resource path helpers (integrates resource_path)
│   │   └── threading.py              # Threading utilities (PyQt worker patterns)
│   └── exceptions/                   # Shared exceptions
│       ├── domain_exception.py       # Domain exceptions
│       ├── application_exception.py  # Application exceptions
│       └── infrastructure_exception.py # Infrastructure exceptions
├── infrastructure/                   # Technical implementations (organized existing code)
│   ├── audio/
│   │   ├── pyaudio_adapter.py        # PyAudio adapter (from listener.py)
│   │   ├── audio_device_manager.py   # Device management
│   │   └── audio_format_converter.py # Format conversion
│   ├── ml/
│   │   ├── onnx_runtime_adapter.py   # ONNX runtime adapter (from transcribe.py)
│   │   ├── model_downloader.py       # Model download service (organized cache)
│   │   ├── inference_engine.py       # Inference engine
│   │   └── gemma_adapter.py          # Gemma model adapter (from gemma_inference)
│   ├── persistence/
│   │   ├── json_repository.py        # JSON file repository (integrates get_config)
│   │   ├── file_repository.py        # File system repository
│   │   └── cache_repository.py       # Cache repository (organized cache structure)
│   ├── ui/
│   │   ├── qt_adapter.py             # Qt framework adapter
│   │   ├── theme_manager.py          # Theme management
│   │   ├── widget_factory.py         # Widget factory
│   │   └── worker_factory.py         # PyQt worker factory
│   └── system/
│       ├── clipboard_service.py      # Clipboard operations
│       ├── hotkey_manager.py         # Global hotkey handling (pynput integration)
│       ├── file_watcher.py           # File system watching
│       └── single_instance_manager.py # Single instance management (socket-based)
└── main.py                           # Application entry point (refactored)
```

## Detailed Migration Plan

### Phase 1: Domain Foundation & Enhanced Infrastructure (Week 1-2) - 25% Complete

#### Enhanced UIContainer Integration

| 🗹 | Task | Target Location | Effort | Status |
|---|------|-----------------|--------|--------|
| 🗹 | **Extend UIContainer for Features** | `shared/di/container_extensions.py` | Medium | 0% |
| 🗹 | **Feature Registration System** | `shared/di/feature_registration.py` | Medium | 0% |
| 🗹 | **MediatR-UIContainer Integration** | `shared/mediator/mediator.py` | High | 0% |
| 🗹 | **PyQt Worker Pattern Adaptation** | `shared/utils/threading.py` | Medium | 0% |

#### Domain Common Infrastructure

| 🗹 | Task | Target Location | Effort | Status |
|---|------|-----------------|--------|--------|
| 🗹 | **Create Domain Base Classes** | `domain/common/` | Medium | 0% |
| 🗹 | **Implement Result Pattern** | `domain/common/result.py` | Medium | 0% |
| 🗹 | **Create Domain Events System** | `domain/common/domain_event.py` | Medium | 0% |
| 🗹 | **Define Repository Contracts** | `domain/common/repository.py` | Low | 0% |

#### Audio Domain Extraction

| 🗹 | Task | Source File | Target Location | Effort | Status |
|---|------|-------------|-----------------|--------|--------|
| 🗹 | **Extract AudioSession Aggregate** | `utils/listener.py:127-575` | `domain/audio/entities/audio_session.py` | High | 0% |
| 🗹 | **Create AudioConfiguration VO** | `utils/listener.py:24-126` | `domain/audio/value_objects/audio_config.py` | Medium | 0% |
| 🗹 | **Create SampleRate VO** | Audio logic | `domain/audio/value_objects/sample_rate.py` | Low | 0% |
| 🗹 | **Define Audio Events** | New | `domain/audio/events/` | Medium | 0% |
| 🗹 | **Create Audio Contracts** | New | `domain/audio/contracts/` | Medium | 0% |

#### Transcription Domain Extraction

| 🗹 | Task | Source File | Target Location | Effort | Status |
|---|------|-------------|-----------------|--------|--------|
| 🗹 | **Extract TranscriptionResult Aggregate** | `utils/transcribe.py:37-978` | `domain/transcription/entities/transcription_result.py` | High | 0% |
| 🗹 | **Create ModelConfiguration VO** | `utils/transcribe.py:40-100` | `domain/transcription/value_objects/model_config.py` | Medium | 0% |
| 🗹 | **Create QuantizationType VO** | Worker quantization logic | `domain/transcription/value_objects/quantization_type.py` | Low | 0% |
| 🗹 | **Define Transcription Events** | New | `domain/transcription/events/` | Medium | 0% |
| 🗹 | **Create Transcription Contracts** | New | `domain/transcription/contracts/` | Medium | 0% |

### Phase 2: Enhanced Shared Infrastructure (Week 3) - 50% Complete

#### MediatR Pattern with PyQt Integration

| 🗹 | Task | Target Location | Effort | Status |
|---|------|-----------------|--------|--------|
| 🗹 | **Create Mediator Core** | `shared/mediator/mediator.py` | High | 0% |
| 🗹 | **Implement Command Base Classes** | `shared/mediator/command.py` | Medium | 0% |
| 🗹 | **Implement Query Base Classes** | `shared/mediator/query.py` | Medium | 0% |
| 🗹 | **Create Handler Registry** | `shared/mediator/registry.py` | Medium | 0% |
| 🗹 | **PyQt Worker Handler Adapter** | `shared/mediator/handler.py` | High | 0% |

#### Enhanced Event System

| 🗹 | Task | Target Location | Effort | Status |
|---|------|-----------------|--------|--------|
| 🗹 | **Domain Event Bus** | `shared/events/domain_event_bus.py` | High | 0% |
| 🗹 | **Qt Signal Adapter** | `shared/events/qt_event_adapter.py` | Medium | 0% |
| 🗹 | **Event Dispatcher** | `shared/events/event_dispatcher.py` | Medium | 0% |

#### Infrastructure Layer Organization

| 🗹 | Task | Source Logic | Target Location | Effort | Status |
|---|------|-------------|-----------------|--------|--------|
| 🗹 | **PyAudio Adapter** | `utils/listener.py:24-124` | `infrastructure/audio/pyaudio_adapter.py` | High | 0% |
| 🗹 | **ONNX Runtime Adapter** | `utils/transcribe.py:186-446` | `infrastructure/ml/onnx_runtime_adapter.py` | High | 0% |
| 🗹 | **Model Downloader** | Transcribe download logic | `infrastructure/ml/model_downloader.py` | Medium | 0% |
| 🗹 | **Gemma Adapter** | `gemma_inference` module | `infrastructure/ml/gemma_adapter.py` | Medium | 0% |
| 🗹 | **JSON Repository** | Config handling | `infrastructure/persistence/json_repository.py` | Medium | 0% |

### Phase 3: Feature Slice Implementation (Week 4-7) - 75% Complete

#### Phase 3a: Audio Recording Feature Slice

| 🗹 | Task | Source Logic | Target Location | Effort | Status |
|---|------|-------------|-----------------|--------|--------|
| 🗹 | **Start Recording Command** | `src/ui/window_methods.py:1200-1300` | `features/audio_recording/commands/start_recording.py` | High | 0% |
| 🗹 | **Audio Status Query** | `utils/listener.py:200-300` | `features/audio_recording/queries/get_recording_status.py` | Medium | 0% |
| 🗹 | **Recording Handler** | Scattered logic | `features/audio_recording/handlers/start_recording_handler.py` | High | 0% |
| 🗹 | **Qt Audio Worker** | `src/workers/worker_classes.py:PyQtAudioToText` | `features/audio_recording/infrastructure/qt_audio_worker.py` | High | 0% |
| 🗹 | **Recording UI Controls** | `src/ui/window_methods.py:800-1200` | `features/audio_recording/ui/recording_controls.py` | High | 0% |
| 🗹 | **PyAudio Service** | `utils/listener.py:24-124` | `features/audio_recording/infrastructure/pyaudio_service.py` | High | 0% |
| 🗹 | **VAD Service** | `VaDetector` integration | `features/audio_recording/infrastructure/vad_service.py` | Medium | 0% |

#### Phase 3b: Transcription Feature Slice

| 🗹 | Task | Source Logic | Target Location | Effort | Status |
|---|------|-------------|-----------------|--------|--------|
| 🗹 | **Transcribe Command** | `src/workers/worker_classes.py:93-133` | `features/transcription/commands/transcribe_audio.py` | High | 0% |
| 🗹 | **Model Status Query** | `utils/transcribe.py:100-200` | `features/transcription/queries/get_model_status.py` | Medium | 0% |
| 🗹 | **Transcription Handler** | `utils/transcribe.py:688-978` | `features/transcription/handlers/transcribe_handler.py` | High | 0% |
| 🗹 | **Qt Transcription Worker** | `src/workers/worker_classes.py:ModelWorker` | `features/transcription/infrastructure/qt_transcription_worker.py` | High | 0% |
| 🗹 | **Progress UI** | Worker UI logic | `features/transcription/ui/transcription_progress.py` | Medium | 0% |
| 🗹 | **ONNX Service** | `utils/transcribe.py:186-446` | `features/transcription/infrastructure/onnx_transcription_service.py` | High | 0% |
| 🗹 | **Model Cache Service** | Organized cache logic | `features/transcription/infrastructure/model_cache_service.py` | Medium | 0% |

#### Phase 3c: LLM Processing Feature Slice

| 🗹 | Task | Source Logic | Target Location | Effort | Status |
|---|------|-------------|-----------------|--------|--------|
| 🗹 | **Process Text Command** | LLM processing logic | `features/llm_processing/commands/process_text.py` | Medium | 0% |
| 🗹 | **LLM Status Query** | LLM worker status | `features/llm_processing/queries/get_llm_models.py` | Medium | 0% |
| 🗹 | **Text Processing Handler** | LLM logic | `features/llm_processing/handlers/text_processing_handler.py` | High | 0% |
| 🗹 | **Qt LLM Worker** | `src/workers/worker_classes.py:LLMWorker` | `features/llm_processing/infrastructure/qt_llm_worker.py` | High | 0% |
| 🗹 | **Processing Options UI** | LLM settings UI | `features/llm_processing/ui/processing_options.py` | Medium | 0% |
| 🗹 | **ONNX LLM Service** | Gemma integration | `features/llm_processing/infrastructure/onnx_llm_service.py` | High | 0% |

#### Phase 3d: Settings Management Feature Slice

| 🗹 | Task | Source Logic | Target Location | Effort | Status |
|---|------|-------------|-----------------|--------|--------|
| 🗹 | **Update Settings Command** | `src/ui/settings_dialog.py:1600-1700` | `features/settings_management/commands/update_preferences.py` | Medium | 0% |
| 🗹 | **Settings Query** | `src/ui/settings_dialog.py:800-1000` | `features/settings_management/queries/get_current_settings.py` | Medium | 0% |
| 🗹 | **Settings Handler** | `src/ui/settings_dialog.py:1000-1600` | `features/settings_management/handlers/settings_update_handler.py` | High | 0% |
| 🗹 | **Settings Dialog UI** | `src/ui/settings_dialog.py:1-800` | `features/settings_management/ui/settings_dialog.py` | High | 0% |
| 🗹 | **JSON Settings Repository** | Config integration | `features/settings_management/infrastructure/json_settings_repository.py` | Medium | 0% |
| 🗹 | **Hotkey Service** | Hotkey handling | `features/settings_management/infrastructure/hotkey_service.py` | Medium | 0% |

#### Phase 3e: File Processing Feature Slice

| 🗹 | Task | Source Logic | Target Location | Effort | Status |
|---|------|-------------|-----------------|--------|--------|
| 🗹 | **Process File Command** | File processing logic | `features/file_processing/commands/process_file.py` | Medium | 0% |
| 🗹 | **Batch Process Command** | Queue processing | `features/file_processing/commands/batch_process.py` | Medium | 0% |
| 🗹 | **File Processing Handler** | File logic | `features/file_processing/handlers/file_processing_handler.py` | High | 0% |
| 🗹 | **File Drop Zone UI** | `src/ui/window_methods.py:dragEnterEvent` | `features/file_processing/ui/file_drop_zone.py` | Medium | 0% |
| 🗹 | **Export Service** | SRT export logic | `features/file_processing/infrastructure/export_service.py` | Medium | 0% |

### Phase 4: Application Shell & Integration (Week 8-9) - 90% Complete

#### Phase 4a: Application Shell Implementation

| 🗹 | Task | Source Logic | Target Location | Effort | Status |
|---|------|-------------|-----------------|--------|--------|
| 🗹 | **Application Startup** | `src/main.py` | `features/application_shell/commands/startup_app.py` | High | 0% |
| 🗹 | **Main Window** | `src/ui/main_window.py` | `features/application_shell/ui/main_window.py` | High | 0% |
| 🗹 | **System Tray** | `src/ui/window_methods.py:400-800` | `features/application_shell/ui/system_tray.py` | Medium | 0% |
| 🗹 | **Single Instance Service** | `src/main.py:socket logic` | `features/application_shell/infrastructure/single_instance_service.py` | Medium | 0% |
| 🗹 | **System Integration** | `win32gui` logic | `features/application_shell/infrastructure/system_integration_service.py` | Medium | 0% |

#### Phase 4b: Enhanced Main Entry Point

| 🗹 | Task | Source Logic | Target Location | Effort | Status |
|---|------|-------------|-----------------|--------|--------|
| ☐ | **Refactor main.py** | Current startup logic | `main.py` | High | 0% |
| ☐ | **Feature Registration** | New | `main.py:configure_features()` | Medium | 0% |
| ☐ | **Container Configuration** | UIContainer setup | `main.py:configure_container()` | Medium | 0% |
| ☐ | **Event Bus Setup** | Event system init | `main.py:configure_events()` | Medium | 0% |

#### Phase 4c: Cross-Feature Integration

| 🗹 | Task | Description | Implementation | Status |
|---|------|-------------|----------------|--------|
| ☐ | **Feature API Registration** | Register all feature APIs | Each feature's `api.py` | 0% |
| ☐ | **Enhanced UIContainer Configuration** | Service registration | `shared/di/container_extensions.py` | 0% |
| ☐ | **Domain Event Integration** | Cross-feature communication | `shared/events/domain_event_bus.py` | 0% |
| ☐ | **PyQt Worker Integration** | Worker pattern adaptation | `shared/utils/threading.py` | 0% |

### Phase 5: Testing & Optimization (Week 10) - 100% Complete

#### Testing Implementation

| 🗹 | Task | Target | Coverage | Status |
|---|------|--------|----------|--------|
| ☐ | **Domain Unit Tests** | All domain entities and VOs | 95%+ | 0% |
| ☐ | **Feature Integration Tests** | Complete feature slices | 90%+ | 0% |
| ☐ | **Handler Tests** | All command/query handlers | 90%+ | 0% |
| ☐ | **PyQt Worker Tests** | Worker integration | 85%+ | 0% |
| ☐ | **UIContainer Tests** | DI container functionality | 90%+ | 0% |

## Implementation Guidelines

### Feature Slice Structure with Existing Patterns

Each feature slice follows this enhanced pattern:

```python
# features/audio_recording/api.py - Public feature API
from typing import Optional
from shared.mediator import IMediator
from domain.common.result import Result
from domain.audio.value_objects import AudioConfig
from .commands.start_recording import StartRecordingCommand
from .queries.get_recording_status import GetRecordingStatusQuery

class AudioRecordingAPI:
    def __init__(self, mediator: IMediator):
        self._mediator = mediator
    
    async def start_recording(self, config: AudioConfig) -> Result[str]:
        """Start audio recording with the specified configuration."""
        command = StartRecordingCommand(config)
        return await self._mediator.send(command)
    
    async def get_status(self) -> Result[RecordingStatus]:
        """Get current recording status."""
        query = GetRecordingStatusQuery()
        return await self._mediator.send(query)

# features/audio_recording/commands/start_recording.py
from dataclasses import dataclass
from typing import Optional
from domain.audio.value_objects import AudioConfig

@dataclass
class StartRecordingCommand:
    """Command to start audio recording."""
    audio_config: AudioConfig
    session_id: Optional[str] = None

# features/audio_recording/handlers/start_recording_handler.py
from PyQt6.QtCore import QObject
from shared.mediator import ICommandHandler
from domain.audio.contracts import IAudioService
from domain.common.result import Result
from ..commands.start_recording import StartRecordingCommand
from ..infrastructure.qt_audio_worker import QtAudioWorker

class StartRecordingHandler(QObject, ICommandHandler[StartRecordingCommand, str]):
    def __init__(self, audio_service: IAudioService, container: UIContainer):
        super().__init__()
        self._audio_service = audio_service
        self._container = container
    
    async def handle(self, command: StartRecordingCommand) -> Result[str]:
        """Handle start recording command using PyQt worker pattern."""
        try:
            # Create domain entity
            session_result = AudioSession.create(command.audio_config)
            if not session_result.is_success:
                return Result.failure(session_result.error)
            
            # Use PyQt worker for audio operations
            worker = self._container.get_service(QtAudioWorker)
            recording_result = await worker.start_recording_async(session_result.value)
            
            return recording_result
        except Exception as e:
            return Result.failure(f"Failed to start recording: {e}")
```

### Enhanced UIContainer Integration

```python
# shared/di/container_extensions.py
from src.ui.core.container import UIContainer, UIContainerBuilder
from typing import Type, TypeVar

T = TypeVar('T')

class FeatureContainerExtensions:
    """Extensions to UIContainer for feature registration."""
    
    @staticmethod
    def register_feature_api(container: UIContainer, feature_api_type: Type[T]) -> None:
        """Register a feature API with automatic dependency resolution."""
        container.register_singleton(feature_api_type, feature_api_type)
    
    @staticmethod
    def register_handlers_from_module(container: UIContainer, module) -> None:
        """Register all handlers from a feature module."""
        import inspect
        
        for name, obj in inspect.getmembers(module):
            if (inspect.isclass(obj) and 
                hasattr(obj, '__annotations__') and
                'ICommandHandler' in str(obj.__annotations__) or 
                'IQueryHandler' in str(obj.__annotations__)):
                container.register_transient(obj, obj)

# main.py - Enhanced entry point
def configure_container() -> UIContainer:
    """Configure the enhanced UIContainer with all features."""
    builder = UIContainerBuilder()
    
    # Register infrastructure services
    builder.add_singleton(IAudioService, PyAudioService)
    builder.add_singleton(ITranscriptionService, ONNXTranscriptionService)
    builder.add_singleton(ILLMService, ONNXLLMService)
    
    # Register PyQt workers
    builder.add_transient(QtAudioWorker, QtAudioWorker)
    builder.add_transient(QtTranscriptionWorker, QtTranscriptionWorker)
    builder.add_transient(QtLLMWorker, QtLLMWorker)
    
    # Register feature APIs
    builder.add_singleton(AudioRecordingAPI, AudioRecordingAPI)
    builder.add_singleton(TranscriptionAPI, TranscriptionAPI)
    builder.add_singleton(LLMProcessingAPI, LLMProcessingAPI)
    builder.add_singleton(SettingsManagementAPI, SettingsManagementAPI)
    builder.add_singleton(FileProcessingAPI, FileProcessingAPI)
    builder.add_singleton(ApplicationShellAPI, ApplicationShellAPI)
    
    # Auto-register handlers from feature modules
    from features.audio_recording import handlers as audio_handlers
    builder.auto_register_from_module(audio_handlers)
    
    return builder.build()

def main():
    """Enhanced main entry point."""
    # Setup logging (preserve existing pattern)
    logger = setup_logger()
    
    # Create PyQt application
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setWindowIcon(QIcon(resource_path("resources/Windows 1 Theta.png")))
    
    # Check single instance (preserve existing pattern)
    if is_already_running():
        # Handle existing instance activation
        handle_existing_instance()
        sys.exit(0)
    
    try:
        # Configure dependency injection
        container = configure_container()
        
        # Configure domain event bus
        event_bus = configure_events(container)
        
        # Create and setup main window
        main_window_api = container.get_service(ApplicationShellAPI)
        startup_result = await main_window_api.startup_application()
        
        if not startup_result.is_success:
            raise Exception(startup_result.error)
        
        logger.info("WinSTT application started successfully")
        sys.exit(app.exec())
        
    except Exception as e:
        logger.exception(f"Failed to start application: {e}")
        QMessageBox.critical(None, "WinSTT Error", f"Failed to start application: {e}")
        sys.exit(1)
```

### PyQt Worker Pattern Integration

```python
# shared/utils/threading.py
from PyQt6.QtCore import QObject, QThread, pyqtSignal
from abc import ABC, abstractmethod
from typing import TypeVar, Generic
import asyncio

T = TypeVar('T')
R = TypeVar('R')

class AsyncWorkerBase(QObject, ABC, Generic[T, R]):
    """Base class for async PyQt workers following existing patterns."""
    
    result_ready = pyqtSignal(object)  # Result[R]
    error_occurred = pyqtSignal(str)
    progress_updated = pyqtSignal(int)  # 0-100
    
    def __init__(self):
        super().__init__()
        self._running = False
    
    @abstractmethod
    async def execute_async(self, input_data: T) -> R:
        """Execute the async operation."""
        pass
    
    def run_async(self, input_data: T) -> None:
        """Run the async operation in a way compatible with PyQt."""
        try:
            self._running = True
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            result = loop.run_until_complete(self.execute_async(input_data))
            self.result_ready.emit(Result.success(result))
            
        except Exception as e:
            self.error_occurred.emit(str(e))
        finally:
            self._running = False
    
    def stop(self):
        """Stop the worker."""
        self._running = False

# features/transcription/infrastructure/qt_transcription_worker.py
from shared.utils.threading import AsyncWorkerBase
from domain.transcription.entities import TranscriptionResult
from domain.audio.value_objects import AudioData

class QtTranscriptionWorker(AsyncWorkerBase[AudioData, TranscriptionResult]):
    """PyQt worker for transcription operations."""
    
    def __init__(self, transcription_service: ITranscriptionService):
        super().__init__()
        self._transcription_service = transcription_service
    
    async def execute_async(self, audio_data: AudioData) -> TranscriptionResult:
        """Execute transcription operation."""
        return await self._transcription_service.transcribe_async(audio_data)
```

### Domain-Driven Design Implementation

```python
# domain/audio/entities/audio_session.py
from dataclasses import dataclass
from typing import List, Optional
from datetime import datetime
from domain.common.aggregate_root import AggregateRoot
from domain.common.result import Result
from domain.audio.value_objects import AudioConfig, Duration
from domain.audio.events import RecordingStartedEvent, RecordingStoppedEvent

class RecordingState(Enum):
    IDLE = "idle"
    RECORDING = "recording"
    PAUSED = "paused"
    STOPPED = "stopped"

class AudioSession(AggregateRoot[str]):
    """Audio session aggregate root managing recording lifecycle."""
    
    def __init__(self, session_id: str, config: AudioConfig):
        super().__init__(session_id)
        self._config = config
        self._state = RecordingState.IDLE
        self._start_time: Optional[datetime] = None
        self._duration: Optional[Duration] = None
        self._audio_data: List[bytes] = []
    
    @classmethod
    def create(cls, config: AudioConfig) -> Result['AudioSession']:
        """Factory method to create a new audio session."""
        # Validate configuration
        validation_result = cls._validate_config(config)
        if not validation_result.is_success:
            return Result.failure(validation_result.error)
        
        session_id = f"session_{datetime.utcnow().timestamp()}"
        session = cls(session_id, config)
        
        return Result.success(session)
    
    def start_recording(self) -> Result[None]:
        """Start recording if valid state transition."""
        if self._state != RecordingState.IDLE:
            return Result.failure(f"Cannot start recording from {self._state} state")
        
        self._state = RecordingState.RECORDING
        self._start_time = datetime.utcnow()
        
        # Publish domain event
        self.add_domain_event(RecordingStartedEvent(
            session_id=self.id,
            config=self._config,
            start_time=self._start_time
        ))
        
        return Result.success(None)
    
    def stop_recording(self) -> Result[Duration]:
        """Stop recording and return duration."""
        if self._state != RecordingState.RECORDING:
            return Result.failure(f"Cannot stop recording from {self._state} state")
        
        end_time = datetime.utcnow()
        duration_seconds = (end_time - self._start_time).total_seconds()
        
        duration_result = Duration.create(duration_seconds)
        if not duration_result.is_success:
            return Result.failure(duration_result.error)
        
        self._duration = duration_result.value
        self._state = RecordingState.STOPPED
        
        # Publish domain event
        self.add_domain_event(RecordingStoppedEvent(
            session_id=self.id,
            duration=self._duration,
            end_time=end_time
        ))
        
        return Result.success(self._duration)
    
    @staticmethod
    def _validate_config(config: AudioConfig) -> Result[None]:
        """Validate audio configuration."""
        if config.sample_rate.value < 8000:
            return Result.failure("Sample rate must be at least 8000 Hz")
        
        if config.channels not in [1, 2]:
            return Result.failure("Channels must be 1 (mono) or 2 (stereo)")
        
        return Result.success(None)
    
    # Properties
    @property
    def state(self) -> RecordingState:
        return self._state
    
    @property
    def config(self) -> AudioConfig:
        return self._config
    
    @property
    def duration(self) -> Optional[Duration]:
        return self._duration

# domain/audio/value_objects/sample_rate.py
from dataclasses import dataclass
from domain.common.value_object import ValueObject
from domain.common.result import Result

@dataclass(frozen=True)
class SampleRate(ValueObject):
    """Sample rate value object with validation."""
    value: int
    
    @classmethod
    def create(cls, value: int) -> Result['SampleRate']:
        """Create sample rate with validation."""
        validation_result = cls._validate(value)
        if not validation_result.is_success:
            return Result.failure(validation_result.error)
        
        return Result.success(cls(value))
    
    @staticmethod
    def _validate(value: int) -> Result[None]:
        """Validate sample rate value."""
        valid_rates = [8000, 16000, 22050, 44100, 48000, 96000]
        
        if value not in valid_rates:
            return Result.failure(f"Sample rate {value} is not supported. Valid rates: {valid_rates}")
        
        return Result.success(None)
    
    def _get_equality_components(self):
        return (self.value,)
    
    def __invariants__(self) -> Result[None]:
        return self._validate(self.value)
```

## Testing Strategy

### Domain Testing (95%+ Coverage)

```python
# tests/domain/audio/test_audio_session.py
import pytest
from domain.audio.entities.audio_session import AudioSession, RecordingState
from domain.audio.value_objects import AudioConfig, SampleRate
from domain.audio.events import RecordingStartedEvent

class TestAudioSession:
    def test_create_with_valid_config_succeeds(self):
        # Arrange
        sample_rate = SampleRate.create(44100).value
        config = AudioConfig(sample_rate=sample_rate, channels=2)
        
        # Act
        result = AudioSession.create(config)
        
        # Assert
        assert result.is_success
        assert result.value.state == RecordingState.IDLE
        assert result.value.config == config

    def test_start_recording_publishes_domain_event(self):
        # Arrange
        config = self._create_valid_config()
        session = AudioSession.create(config).value
        
        # Act
        result = session.start_recording()
        
        # Assert
        assert result.is_success
        assert len(session.domain_events) == 1
        assert isinstance(session.domain_events[0], RecordingStartedEvent)
        assert session.state == RecordingState.RECORDING

    def test_start_recording_from_recording_state_fails(self):
        # Arrange
        config = self._create_valid_config()
        session = AudioSession.create(config).value
        session.start_recording()  # Already recording
        
        # Act
        result = session.start_recording()
        
        # Assert
        assert not result.is_success
        assert "Cannot start recording from recording state" in result.error

    def _create_valid_config(self) -> AudioConfig:
        sample_rate = SampleRate.create(44100).value
        return AudioConfig(sample_rate=sample_rate, channels=2)
```

### Feature Integration Testing (90%+ Coverage)

```python
# tests/features/audio_recording/test_recording_feature.py
import pytest
from unittest.mock import Mock, AsyncMock
from features.audio_recording.api import AudioRecordingAPI
from features.audio_recording.handlers.start_recording_handler import StartRecordingHandler
from domain.audio.value_objects import AudioConfig, SampleRate
from shared.mediator import Mediator

class TestAudioRecordingFeature:
    @pytest.fixture
    def setup_dependencies(self):
        # Setup mocked dependencies
        audio_service = Mock()
        container = Mock()
        mediator = Mediator(container)
        
        # Register handler
        handler = StartRecordingHandler(audio_service, container)
        mediator.register_handler(StartRecordingCommand, handler)
        
        return {
            'mediator': mediator,
            'audio_service': audio_service,
            'container': container
        }

    async def test_complete_recording_workflow(self, setup_dependencies):
        # Arrange
        deps = setup_dependencies
        api = AudioRecordingAPI(deps['mediator'])
        
        sample_rate = SampleRate.create(44100).value
        config = AudioConfig(sample_rate=sample_rate, channels=2)
        
        # Act
        start_result = await api.start_recording(config)
        status_result = await api.get_status()
        stop_result = await api.stop_recording(start_result.value)
        
        # Assert
        assert start_result.is_success
        assert status_result.value.state == RecordingState.RECORDING
        assert stop_result.is_success
```

## Migration Timeline & Success Metrics

### Timeline Overview

| Phase | Duration | Key Deliverables | Risk Level |
|-------|----------|------------------|------------|
| **Phase 1: Domain Foundation & Enhanced Infrastructure** | 2 weeks | Domain models, enhanced UIContainer, infrastructure adapters | Low |
| **Phase 2: Enhanced Shared Infrastructure** | 1 week | MediatR with PyQt, event system, utilities | Medium |
| **Phase 3: Feature Slices** | 4 weeks | Complete feature implementations with PyQt workers | High |
| **Phase 4: Application Shell & Integration** | 2 weeks | Enhanced main.py, feature integration, event bus | High |
| **Phase 5: Testing & Polish** | 1 week | Testing, optimization, cleanup | Low |
| **Total Project** | **10 weeks** | **Complete refactored application** | **Medium** |

### Success Metrics

#### Technical Metrics

- [ ] **Feature Independence**: Each feature can be modified without affecting others
- [ ] **Test Coverage**: >95% domain, >90% feature handlers, >85% PyQt workers, >75% overall
- [ ] **Command/Query Separation**: All business operations use MediatR pattern
- [ ] **Dependency Direction**: No feature → infrastructure dependencies
- [ ] **UIContainer Integration**: All services registered and resolved properly
- [ ] **PyQt Worker Integration**: All async operations use worker pattern

#### Quality Metrics

- [ ] **Maintainability**: New features can be added in single feature slice
- [ ] **Performance**: No regression vs. current implementation
- [ ] **Code Quality**: Consistent patterns across all features
- [ ] **Documentation**: All public APIs documented
- [ ] **Event System**: Domain events properly integrated with Qt signals

## Tools & Technologies

### Architecture Patterns

- **Vertical Slice Architecture**: Self-contained feature slices
- **Domain-Driven Design**: Rich domain models with business logic
- **MediatR Pattern**: Commands/queries for all operations
- **Enhanced Dependency Injection**: Extended UIContainer with feature registration
- **Event-Driven**: Domain events integrated with PyQt signals

### Implementation Tools

- **Testing**: pytest, unittest.mock, PyQt test utilities
- **Code Quality**: ruff, mypy, pre-commit hooks
- **Type Safety**: Comprehensive type hints with mypy
- **Dependency Injection**: Enhanced UIContainer with feature extensions
- **Event System**: Domain event bus integrated with Qt signals
- **Package Management**: uv (as per project memory)

## Conclusion

This enhanced vertical slice refactoring plan provides:

**Architectural Excellence:**

- **Self-Contained Features**: Each feature slice is independent and complete
- **Clean Domain Models**: Business logic centralized in rich domain entities
- **Consistent Patterns**: MediatR pattern for all business operations
- **Enhanced UIContainer**: Builds on existing professional IoC container
- **PyQt Integration**: Preserves and enhances existing worker patterns

**Development Benefits:**

- **Feature Velocity**: New features developed in isolated slices
- **Parallel Development**: Multiple developers can work on different features
- **Easy Testing**: Complete feature testing in isolation
- **Clear Boundaries**: Obvious places for new functionality
- **Existing Pattern Preservation**: Builds on current strengths

**Long-Term Value:**

- **Maintainability**: Features can be modified without affecting others
- **Extensibility**: New features follow established patterns
- **Testability**: High test coverage with clear testing strategies
- **Evolution**: Architecture supports future requirements and changes
- **Performance**: No regression, enhanced through better separation

**Key Enhancements Over Original Plan:**

- **UIContainer Integration**: Extends existing professional DI container
- **PyQt Worker Preservation**: Adapts existing async patterns
- **Resource Management**: Maintains organized cache and resource structure
- **Single Instance Pattern**: Preserves robust application instance management
- **Qt Signal Integration**: Bridges domain events with existing Qt infrastructure

**Total Investment**: 10 weeks for a complete architectural transformation
**Expected ROI**: 3-5x improvement in development velocity and maintenance efficiency
**Future-Proof**: Solid foundation for years of feature development and enhancement
**Risk Mitigation**: Builds on existing strengths while addressing architectural debt
