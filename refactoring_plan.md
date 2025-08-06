# WinSTT Hexagonal Architecture Refactoring Plan

## Executive Summary

This document presents a comprehensive refactoring strategy that transforms WinSTT from its current mixed architecture into a clean, maintainable desktop application using **Hexagonal Architecture** (Clean Architecture) with **Domain-Driven Design** (DDD) principles, building upon the existing **UIContainer** dependency injection system and **PyQt worker patterns**.

**Key Benefits:**

- 🏗️ **Hexagonal Architecture**: Clear separation between domain, application, and infrastructure layers
- 🧩 **Domain-Driven Design**: Rich domain models with business logic
- 🔧 **Clean Dependencies**: Domain at the center, infrastructure at the edges
- 🧪 **Enhanced Testability**: Clean separation and dependency injection
- 📈 **Layer Independence**: Each layer can evolve independently
- ⚡ **Existing Pattern Integration**: Builds on current UIContainer and PyQt workers

## Current State Analysis

### Complete File Inventory & Functionality Mapping

| File Path | Lines | Current Responsibility | Domain Logic | Infrastructure Code | UI Code | Refactoring Priority |
|-----------|-------|------------------------|--------------|---------------------|---------|---------------------|
| **src/main.py** | 146 | **Application entry point with multiple infrastructure concerns:** | | | | Critical |
| └── Environment Setup | 22 | Environment variables, logging config, path manipulation | ❌ | ✅ System configuration | ❌ | Critical |
| └── Platform Detection | 8 | Windows-specific feature detection (win32gui) | ❌ | ✅ Platform abstraction | ❌ | Critical |
| └── Subprocess Utils | 7 | Subprocess console suppression patches | ❌ | ✅ System utilities | ❌ | Critical |
| └── Single Instance | 17 | Socket-based instance detection and cleanup | ❌ | ✅ Application lifecycle | ❌ | Critical |
| └── Framework Bootstrap | 6 | PyQt imports with patches | ❌ | ✅ Framework initialization | ✅ PyQt setup | Critical |
| └── Application Orchestration | 19 | Main workflow, logger setup, QApplication config | ✅ Application flow | ✅ App lifecycle | ✅ UI initialization | Critical |
| └── Window Activation | 33 | Complex window enumeration, platform-specific activation | ❌ | ✅ Window management | ✅ User notifications | Critical |
| └── Lifecycle Management | 12 | Window creation, execution loop, error handling | ✅ Application coordination | ✅ Resource cleanup | ✅ Error dialogs | Critical |
| └── Entry Point | 2 | Main function invocation | ✅ Application startup | ❌ | ❌ | Critical |
| **utils/listener.py** | 575 | Consolidated listener for audio recording, hotkey handling, VAD integration, file operations | ✅ Recording business rules, state management | ✅ PyAudio, keyboard hooks, file I/O | ❌ | Critical |
| **src/core/utils/listener.py** | 68 | **Placeholder AudioToText implementation with basic audio processing interface:** | | | | Medium |
| └── AudioToText Placeholder | 68 | **Basic audio processing placeholder with minimal functionality including:** | | | | Medium |
| ├── Recording State Management | 12 | Basic is_recording state toggle and logging (lines 14, 21-22, 48-49, 52-53) | ✅ Basic recording state rules | ✅ State management logic | ✅ Logging integration | **MERGE** |
| ├── Key Event Handling | 10 | Default key handler with recording toggle (lines 15, 18-22, 24-27, 29-31) | ✅ Key binding rules | ✅ Event handling logic | ✅ State change coordination | **MERGE** |
| ├── Audio Transcription Interface | 8 | Placeholder transcription methods (lines 33-36, 56-58) | ✅ Transcription interface | ✅ Placeholder implementation | ✅ Logging integration | **MERGE** |
| ├── Audio Processing Setup | 15 | Pygame initialization, model/VAD configuration (lines 38-40, 60-68) | ✅ Audio setup rules | ✅ Placeholder initialization | ✅ Configuration management | **MERGE** |
| └── Recording Controls | 13 | Start/stop recording methods with state management (lines 46-54) | ✅ Recording control rules | ✅ State coordination logic | ✅ Logging integration | **MERGE** |
| **utils/transcribe.py** | 978 | Whisper ONNX transcription, model management, caching, download progress | ✅ Transcription logic, model configuration | ✅ ONNX runtime, model loading, caching | ❌ | Critical |
| **src/core/utils/transcribe.py** | 102 | **Placeholder WhisperONNXTranscriber implementation with basic transcription interface:** | | | | Medium |
| └── WhisperONNXTranscriber Placeholder | 102 | **Basic transcription placeholder with minimal functionality including:** | | | | Medium |
| ├── Model Initialization | 29 | Placeholder model loading with signal integration (lines 13-24, 26-54) | ✅ Model setup rules | ✅ PyQt signal integration | ✅ Progress tracking interface | **MERGE** |
| ├── Audio Transcription | 35 | Multi-format audio handling with placeholder results (lines 55-91) | ✅ Transcription interface | ✅ Input type handling | ✅ Error handling patterns | **MERGE** |
| ├── Segment Management | 12 | Timestamp-based transcription segments (lines 77-84, 92-94) | ✅ Segment structure rules | ✅ Data structure management | ✅ Result formatting | **MERGE** |
| └── Configuration Interface | 6 | Language and task configuration methods (lines 96-102) | ✅ Configuration rules | ✅ Settings management | ✅ Logging integration | **MERGE** |
| **logger/logger.py** | 33 | **Centralized logging infrastructure with date-based file management:** | | | | Medium |
| └── Logging Setup Utility | 33 | **Complete logging configuration utility including:** | | | | Medium |
| ├── Date-Based File Management | 11 | Log file path creation with daily rotation (lines 7-11) | ✅ File naming rules | ✅ Directory management | ❌ | **PRESERVE** |
| ├── Handler Configuration | 12 | File and stream handler setup with level configuration (lines 19-30) | ✅ Logging level rules | ✅ Handler management | ❌ | **PRESERVE** |
| ├── Format Configuration | 3 | Logging format and timestamp configuration (lines 21, 26) | ✅ Format consistency rules | ✅ Message formatting | ❌ | **PRESERVE** |
| └── Duplicate Prevention | 7 | Handler existence checking to prevent duplicates (lines 17-18, 28-30) | ✅ Handler uniqueness rules | ✅ Logger state management | ❌ | **PRESERVE** |
| **src/ui/main_window.py** | 423 | **Main window with 2 distinct classes and 10+ responsibilities:** | | | | Critical |
| └── Ui_MainWindow UI Setup | 249 | **Massive UI setup class with mixed responsibilities including:** | | | | Critical |
| ├── Widget Creation & Layout | ~80 | Complex widget creation, positioning, styling, and configuration | ❌ | ✅ Widget instantiation, geometry | ✅ PyQt6 widget management | High |
| ├── Window Configuration | ~50 | Window sizing, icon setup, palette management, size policies | ✅ Window behavior rules | ✅ Platform window integration | ✅ Window appearance management | High |
| ├── Voice Visualizer Integration | ~25 | PyQtGraph integration, waveform plotting, transparency effects | ✅ Visualization coordination | ✅ PyQtGraph integration, plotting | ✅ Real-time visualization UI | Critical |
| ├── Opacity Effects System | ~40 | Complex opacity effects for multiple UI elements during recording | ✅ Visual state coordination | ✅ Graphics effects management | ✅ Animation and effects UI | High |
| ├── UI Element Layering | ~15 | Widget z-order management and raising sequences | ❌ | ✅ Widget layering logic | ✅ UI element stacking | Medium |
| └── UI Text & Translation | ~39 | Dynamic text updates, translation support, recording key display | ✅ Text formatting rules | ✅ Translation system integration | ✅ Dynamic text UI | Medium |
| └── Window Main Class | 174 | **Window class with 7+ distinct responsibilities including:** | | | | Critical |
| ├── Configuration Management | ~52 | Config loading, default values, settings override, state management | ✅ Configuration business rules | ✅ JSON configuration, file I/O | ✅ Settings integration | Critical |
| ├── Worker Thread Setup | ~20 | Thread initialization, worker class references, threading preparation | ✅ Worker coordination rules | ✅ QThread management, worker setup | ✅ Worker integration UI | Critical |
| ├── System Tray Integration | ~15 | Tray icon creation, menu actions, system integration | ✅ Tray behavior rules | ✅ System tray API integration | ✅ System integration UI | High |
| ├── Event System Setup | ~10 | Event filter installation, event handling preparation | ❌ | ✅ Event system integration | ✅ Event handling UI | Medium |
| ├── Method Delegation Pattern | ~40 | Importing and delegating methods from window_methods (architectural violation) | ❌ | ✅ Method delegation | ✅ Facade pattern implementation | Critical |
| ├── Drag & Drop Enablement | ~5 | Enabling drag and drop functionality for the main window | ❌ | ✅ Drag drop integration | ✅ File drop UI | Medium |
| └── Geometry Management | ~10 | Central widget geometry setup and window sizing | ❌ | ✅ Geometry calculations | ✅ Layout management | Medium |
| **src/ui/window_methods.py** | 1345 | **Main application logic with 20+ distinct responsibilities:** | | | | Critical |
| └── Configuration Management | 33 | Config loading, model settings, LLM settings, recording settings | ✅ Settings business rules | ✅ Configuration persistence | ❌ | Critical |
| └── Settings Dialog Integration | 20 | Settings dialog lifecycle, lazy initialization | ✅ Settings coordination | ✅ Dialog management | ✅ Settings UI integration | High |
| └── Worker Management | 91 | Complex worker initialization, cleanup, thread management | ✅ Worker lifecycle coordination | ✅ Thread management, memory cleanup | ✅ Progress reporting | Critical |
| └── Listener Initialization | 44 | Listener worker setup, signal connections, audio configuration | ✅ Recording workflow coordination | ✅ Audio system integration | ✅ Recording state signals | Critical |
| └── LLM Worker Management | 84 | LLM worker lifecycle, error handling, inference management | ✅ LLM workflow coordination | ✅ Model loading, inference execution | ✅ Progress tracking, error handling | Critical |
| └── Transcription Handling | 35 | Transcription processing, LLM integration, response formatting | ✅ Transcription workflow orchestration | ✅ LLM inference execution | ✅ Result display | Critical |
| └── UI Message Display | 130 | Complex message display with animations, progress tracking | ❌ | ✅ Animation management | ✅ UI state management, opacity effects | High |
| └── System Tray Management | 28 | Tray icon creation, context menu, window activation | ❌ | ✅ System integration | ✅ Tray UI, window management | Medium |
| └── File Operations | 47 | File dialog configuration, media file selection, folder scanning | ✅ File processing coordination | ✅ File system operations | ✅ File dialogs | High |
| └── Event Handling | 74 | Key events, mouse events, window events, event filtering | ❌ | ✅ System event handling | ✅ Window event management | Medium |
| └── Drag and Drop | 87 | File drag and drop, folder drop, media file validation | ✅ File processing coordination | ✅ File validation, folder scanning | ✅ Drag/drop UI feedback | High |
| └── Media File Processing | 65 | Audio/video file processing, media validation, queue management | ✅ Media processing coordination | ✅ File type validation | ✅ Progress tracking | Critical |
| └── Video Conversion | 34 | FFmpeg video conversion, audio extraction, error handling | ✅ Conversion workflow coordination | ✅ FFmpeg integration, subprocess management | ✅ Progress reporting | Critical |
| └── File Queue Processing | 117 | Batch file processing, queue management, progress tracking | ✅ Batch processing coordination | ✅ Queue persistence, progress calculation | ✅ UI progress updates | Critical |
| └── Progress Management | 14 | Safe progress updates, UI state management | ❌ | ✅ Progress calculation | ✅ Progress bar management | Medium |
| └── Time Formatting | 8 | SRT time format conversion | ✅ Time calculation business rules | ❌ | ❌ | Low |
| └── File Transcription | 66 | Individual file transcription, format selection, error handling | ✅ Transcription workflow coordination | ✅ File I/O, transcription execution | ✅ Progress updates | Critical |
| └── Transcription Callbacks | 56 | Completion handling, error handling, cleanup management | ✅ Transcription lifecycle coordination | ✅ Resource cleanup | ✅ UI state updates | Critical |
| └── Voice Visualization | 139 | Voice visualizer management, complex animations, recording state | ✅ Visualization coordination | ✅ Audio data processing | ✅ Complex animation management | High |
| └── Audio Data Transcription | 71 | In-memory audio transcription, BytesIO handling, result saving | ✅ Audio processing coordination | ✅ Memory management, file I/O | ✅ Progress tracking | Critical |
| └── Download Management | 41 | Download progress, UI state management, progress bar reparenting | ❌ | ✅ Download coordination | ✅ Complex UI state management | High |
| └── UI State Management | 15 | Instruction label updates, download state management | ❌ | ✅ State persistence | ✅ UI text management | Medium |
| **src/ui/settings_dialog.py** | 1613 | **Settings dialog with 2 distinct classes and 15+ responsibilities:** | | | | Critical |
| └── ToggleSwitch Widget | 85 | Custom PyQt toggle widget with styling, mouse events, paint handling | ✅ Widget behavior rules | ✅ PyQt event system, custom painting | ✅ Widget styling, visual states | High |
| └── SettingsDialog God Object | 1528 | **MASSIVE settings dialog with 15+ mixed responsibilities including:** | | | | Critical |
| ├── Configuration Management | ~200 | JSON settings loading/saving, default values, validation | ✅ Settings business rules | ✅ File I/O, JSON persistence | ✅ Form data binding | Critical |
| ├── UI Layout & Styling | ~400 | Complex multi-section layout, styling, widget creation | ❌ | ✅ Widget positioning, styling | ✅ PyQt layouts, group boxes | High |
| ├── Event Handling System | ~200 | Drag & drop, key recording, file browsing, signal management | ✅ Event coordination rules | ✅ Event filtering, file validation | ✅ PyQt event system | Critical |
| ├── Progress Bar Management | ~300 | Complex progress bar reparenting, lifecycle, download tracking | ✅ Progress coordination | ✅ Widget reparenting, timers | ✅ Progress UI state management | Critical |
| ├── Model Download Workflow | ~200 | Download initiation, progress tracking, UI state management | ✅ Download coordination | ✅ Worker communication, progress callbacks | ✅ Download UI feedback | Critical |
| ├── Settings Reset System | ~150 | Individual and bulk reset functionality, parent communication | ✅ Reset business rules | ✅ Settings restoration logic | ✅ Reset confirmation UI | High |
| ├── Parent Window Integration | ~100 | Bidirectional communication, worker updates, message display | ✅ Integration coordination | ✅ Worker management, signal delegation | ✅ Parent-child UI communication | Critical |
| ├── LLM Configuration | ~100 | LLM enable/disable, model selection, worker initialization | ✅ LLM configuration rules | ✅ LLM worker management | ✅ LLM settings UI | High |
| └── Dialog Lifecycle | ~100 | Show/hide events, close handling, progress bar cleanup | ✅ Dialog state management | ✅ Event lifecycle, resource cleanup | ✅ Dialog appearance management | High |
| **src/workers/worker_classes.py** | 290 | **PyQt worker wrappers with 5 distinct responsibilities:** | | | | Critical |
| └── Import Configuration | 15 | Logging setup, PyQt imports, utility dependencies | ❌ | ✅ Framework imports | ✅ PyQt threading setup | Critical |
| └── PyQtAudioToText Adapter | 56 | Adapter pattern bridging AudioToText with PyQt signals | ✅ Recording state management | ✅ Signal emission, property delegation | ✅ PyQt signal integration | Critical |
| └── VadWorker | 23 | Voice Activity Detection worker with threading | ✅ VAD lifecycle management | ✅ VaDetector integration, thread safety | ✅ PyQt signals for VAD events | High |
| └── ModelWorker | 69 | Whisper transcription model worker and file processing | ✅ Model lifecycle, transcription orchestration | ✅ ONNX model loading, file I/O handling | ✅ Progress reporting, error signals | Critical |
| └── ListenerWorker | 46 | Audio recording listener with PyQt integration | ✅ Recording workflow coordination | ✅ Thread management, resource cleanup | ✅ Recording state signals | Critical |
| └── LLMWorker | 78 | Large Language Model worker for text processing | ✅ LLM inference coordination | ✅ Model loading, tokenization, inference | ✅ Progress tracking, result signals | Critical |
| **src/ui/voice_visualizer.py** | 193 | **Audio visualization with 2 distinct classes and multiple responsibilities:** | | | | High |
| └── AudioProcessor Thread | 143 | PyAudio audio capture, buffer management, normalization algorithms, resource cleanup | ✅ Audio normalization business rules | ✅ PyAudio integration, threading, resource management | ✅ PyQt threading signals | Critical |
| └── VoiceVisualizer Controller | 38 | Processor lifecycle management, data handling, parent communication | ✅ Visualization coordination | ✅ Thread lifecycle management | ✅ UI data forwarding | High |
| **src/ui/core/container.py** | 406 | **Enterprise-level IoC container with comprehensive dependency injection capabilities:** | | | | **CRITICAL** |
| └── Dependency Injection System | 406 | **Complete enterprise IoC container implementation including:** | | | | **CRITICAL** |
| ├── Service Lifetime Management | 28 | ServiceLifetime enum (SINGLETON, TRANSIENT, SCOPED) with lifecycle management | ✅ Service lifetime business rules | ✅ Lifecycle management logic | ✅ Thread-safe container operations | **UTILIZE** |
| ├── Service Registration | 101 | ServiceDescriptor dataclass, registration methods (register_singleton, register_transient, register_scoped) | ✅ Service registration rules | ✅ Service descriptor validation | ✅ Fluent registration interface | **UTILIZE** |
| ├── Service Resolution | 127 | Thread-safe service resolution with circular dependency detection and automatic constructor injection | ✅ Dependency resolution rules | ✅ Constructor injection logic | ✅ Circular dependency detection | **UTILIZE** |
| ├── Exception Handling | 14 | Custom exceptions (ServiceResolutionException, CircularDependencyException, ServiceNotRegisteredException) | ✅ Exception handling rules | ✅ Error reporting logic | ✅ Service resolution diagnostics | **UTILIZE** |
| ├── Service Decorators | 27 | @injectable and @service_interface decorators for automatic service registration | ✅ Decorator pattern rules | ✅ Automatic registration logic | ✅ Service interface binding | **UTILIZE** |
| └── Container Builder | 44 | UIContainerBuilder with fluent interface and auto-registration from modules | ✅ Builder pattern rules | ✅ Module scanning logic | ✅ Fluent container configuration | **UTILIZE** |
| **src/ui/core/events.py** | 509 | **Comprehensive enterprise event system with advanced mediator implementation:** | | | | **CRITICAL** |
| └── Event-Driven Architecture | 509 | **Complete enterprise event system implementation including:** | | | | **CRITICAL** |
| ├── Event Priority System | 15 | EventPriority enum with LOW, NORMAL, HIGH, CRITICAL levels for processing order | ✅ Event prioritization rules | ✅ Priority-based processing logic | ✅ Thread-safe event ordering | **UTILIZE** |
| ├── Event Subscription Management | 102 | EventSubscription with observer, priority, filtering, async processing, and subscription lifecycle | ✅ Subscription business rules | ✅ Thread-safe subscription management | ✅ Weak reference cleanup | **UTILIZE** |
| ├── CQRS Implementation | 43 | ICommandHandler and IQueryHandler interfaces with mediator-based command/query separation | ✅ CQRS pattern rules | ✅ Command/query handling logic | ✅ Result pattern integration | **UTILIZE** |
| ├── UIEventSystem Core | 274 | Thread-safe event publishing, subscription, priority handling, async processing, filtering, history, metrics | ✅ Event coordination rules | ✅ Thread-safe event processing | ✅ Performance monitoring | **UTILIZE** |
| ├── Predefined UI Events | 50 | WidgetCreatedEvent, StateChangedEvent, UserActionEvent, ValidationFailedEvent, ProgressUpdatedEvent, ErrorOccurredEvent | ✅ UI event standardization | ✅ Event data structures | ✅ Type-safe event definitions | **UTILIZE** |
| └── Event Decorators | 48 | @event_handler, @command_handler, @query_handler decorators for automatic registration | ✅ Decorator pattern rules | ✅ Automatic handler registration | ✅ Type-safe event binding | **UTILIZE** |
| **src/ui/core/abstractions.py** | 462 | **Comprehensive architectural foundation with 13 critical design patterns:** | | | | **CRITICAL** |
| └── Architectural Patterns | 462 | **Complete DDD and SOLID pattern implementations including:** | | | | **CRITICAL** |
| ├── Result Pattern | 35 | Railway-oriented programming with functional error handling (success/failure) | ✅ Functional error handling | ❌ | ❌ | **UTILIZE** |
| ├── Domain Events | 25 | UIEvent base class and UIEventType enumeration with timestamp/ID generation | ✅ Event-driven architecture | ❌ | ❌ | **UTILIZE** |
| ├── Command Pattern (CQRS) | 21 | ICommand and IQuery protocols for command-query responsibility separation | ✅ CQRS pattern implementation | ❌ | ❌ | **UTILIZE** |
| ├── Observer Pattern | 22 | IObserver and IObservable protocols for event notifications | ✅ Observer pattern implementation | ❌ | ❌ | **UTILIZE** |
| ├── Mediator Pattern | 15 | IMediator protocol for decoupled communication between components | ✅ Mediator pattern implementation | ❌ | ❌ | **UTILIZE** |
| ├── Dependency Injection | 15 | IServiceProvider protocol with singleton and transient service registration | ✅ DI pattern implementation | ❌ | ❌ | **UTILIZE** |
| ├── UI Component Abstractions | 46 | IUIComponent, IUIState, IUIValidator, IUIFactory protocols for UI architecture | ✅ UI abstraction patterns | ❌ | ❌ | **UTILIZE** |
| ├── MVP Pattern | 26 | IView and IPresenter protocols for Model-View-Presenter architecture | ✅ MVP pattern implementation | ❌ | ❌ | **UTILIZE** |
| ├── Strategy Pattern | 7 | IStrategy protocol for behavior variations and algorithm selection | ✅ Strategy pattern implementation | ❌ | ❌ | **UTILIZE** |
| ├── Repository Pattern | 15 | IUIRepository protocol for UI state persistence and data access | ✅ Repository pattern implementation | ❌ | ❌ | **UTILIZE** |
| ├── Aggregate Root (DDD) | 32 | UIAggregateRoot base class with domain events and consistency management | ✅ DDD aggregate pattern | ❌ | ❌ | **UTILIZE** |
| ├── UI Value Objects | 36 | UIPosition, UISize, UIBounds value objects for UI geometry with validation | ✅ UI geometry validation | ❌ | ❌ | **UTILIZE** |
| └── Entity Base Class (DDD) | 43 | UIEntity base class with identity, timestamps, equality, and hash implementation | ✅ DDD entity pattern | ❌ | ❌ | **UTILIZE** |
| **src/ui/core/patterns.py** | 632 | **Comprehensive design patterns library with 5 enterprise-level implementations:** | | | | **CRITICAL** |
| └── Advanced Design Patterns | 632 | **Complete GoF and architectural pattern implementations including:** | | | | **CRITICAL** |
| ├── Factory Pattern | 175 | WidgetType enum, WidgetConfiguration, IWidgetFactory interface, UIWidgetFactory concrete implementation | ✅ Widget creation business rules | ✅ PyQt6 widget creation logic | ✅ Widget factory abstraction | **UTILIZE** |
| ├── Builder Pattern | 113 | UIComponentBuilder with fluent interface for complex UI component construction | ✅ Component composition rules | ✅ Step-by-step widget building | ✅ Fluent interface design | **UTILIZE** |
| ├── Strategy Pattern | 89 | AnimationStrategy base, FadeInStrategy, SlideInStrategy, AnimationContext for behavior variations | ✅ Animation behavior rules | ✅ PyQt6 animation integration | ✅ Animation strategy execution | **UTILIZE** |
| ├── Decorator Pattern | 86 | UIComponentDecorator base, TooltipDecorator, ValidationDecorator, LoggingDecorator for extending functionality | ✅ Component enhancement rules | ✅ Decorator composition logic | ✅ Component behavior extension | **UTILIZE** |
| └── Command Pattern | 96 | UICommand base class, ShowComponentCommand, UICommandInvoker with undo/redo support | ✅ Command execution rules | ✅ Command pattern implementation | ✅ Undo/redo functionality | **UTILIZE** |
| **src/ui/domain/value_objects.py** | 233 | **Comprehensive UI domain value objects with 9 well-structured components:** | | | | **CRITICAL** |
| └── Domain Value Objects | 233 | **Single source of truth for UI domain validation including:** | | | | **CRITICAL** |
| ├── WindowDimensions VO | 22 | Window dimensions validation (100-3840 width, 100-2160 height) with aspect ratio and area | ✅ Dimension validation rules | ❌ | ❌ | **UTILIZE** |
| ├── StyleConfiguration VO | 31 | UI styling with theme, colors, fonts validation (dark/light/auto themes) | ✅ Style validation rules | ❌ | ❌ | **UTILIZE** |
| ├── KeyCombination VO | 37 | Keyboard combinations with modifier validation and string parsing | ✅ Hotkey validation rules | ❌ | ❌ | **UTILIZE** |
| ├── AudioConfiguration VO | 21 | Audio config validation (sample rates, channels, bit depth, buffer size) | ✅ Audio validation rules | ❌ | ❌ | **UTILIZE** |
| ├── ModelType Enum | 4 | Model type enumeration (whisper-turbo, lite variants) | ✅ Model type rules | ❌ | ❌ | **UTILIZE** |
| ├── Quantization Enum | 3 | Quantization level enumeration (Full, Quantized) | ✅ Quantization rules | ❌ | ❌ | **UTILIZE** |
| ├── ModelConfiguration VO | 38 | Model configuration with compatibility validation and size estimation | ✅ Model validation rules | ❌ | ❌ | **UTILIZE** |
| ├── LLMConfiguration VO | 21 | LLM configuration with prompt validation and parameter limits | ✅ LLM validation rules | ❌ | ❌ | **UTILIZE** |
| └── OutputConfiguration VO | 17 | Output format validation (txt, srt, vtt, json) with directory validation | ✅ Output validation rules | ❌ | ❌ | **UTILIZE** |

### Total Technical Debt

- **Lines of Code to Refactor**: ~4,558+ lines (reduced due to preservation of well-structured architectural assets)
- **Architectural Violations**: 95+ violations across layers (includes all major UI files with mixed responsibilities)
- **Dependency Direction Issues**: UI → Business → Infrastructure (should be reversed)
- **Testing Challenges**: No unit tests, hard dependencies, no mocking capabilities
- **Well-Structured Assets**:
  - `src/ui/domain/value_objects.py` (233 lines) - Comprehensive domain value objects with validation
  - `src/ui/core/abstractions.py` (462 lines) - Complete architectural patterns foundation (Result, CQRS, DDD, MVP, Observer, Mediator, Strategy, Repository)
  - `src/ui/core/patterns.py` (632 lines) - Enterprise-level design patterns library (Factory, Builder, Strategy, Decorator, Command patterns with PyQt6 integration)
  - `src/ui/core/container.py` (406 lines) - Enterprise-level IoC container with thread-safe resolution, circular dependency detection, automatic constructor injection, service decorators, and fluent builder interface
  - `src/ui/core/events.py` (509 lines) - Comprehensive enterprise event system with mediator implementation, CQRS, priority-based processing, async handling, event history, and performance monitoring
  - `logger/logger.py` (33 lines) - Centralized logging infrastructure with date-based file management
- **Single Responsibility Violations**:
  - main.py contains 9 distinct responsibilities
  - worker_classes.py contains 5 worker classes with different domain concerns
  - window_methods.py contains 20+ distinct responsibilities in a single file
  - voice_visualizer.py contains audio processing, threading, and UI coordination mixed together
- **Duplicate Implementations**:
  - src/core/utils/listener.py (68 lines) - Placeholder AudioToText class to be merged with main utils/listener.py
  - src/core/utils/transcribe.py (102 lines) - Placeholder WhisperONNXTranscriber class to be merged with main utils/transcribe.py
  - settings_dialog.py contains 15+ distinct responsibilities in a massive 1613-line god object
  - main_window.py contains 10+ distinct responsibilities split across UI setup and window management
- **Platform Coupling**: Direct platform-specific code mixed with application logic
- **Worker Pattern Violations**: PyQt threading mixed with business logic and infrastructure concerns
- **God Object Anti-Pattern**:
  - window_methods.py is a 1345-line god object handling everything from configuration to animations
  - settings_dialog.py is a 1613-line god object handling everything from UI layout to download management
  - main_window.py has massive UI setup class (249 lines) with mixed widget creation, styling, and configuration
- **Audio Processing Violations**: Real-time audio processing mixed with UI threading and business logic
- **Settings Management Violations**: Configuration logic mixed with UI presentation and progress management
- **Progress Bar Violations**: Complex widget reparenting and lifecycle management mixed with business logic
- **UI Widget Violations**: Custom widget implementation mixed with business logic and styling concerns
- **Event Handling Violations**: Complex event filtering and routing mixed with domain logic
- **Dialog Lifecycle Violations**: Dialog state management mixed with business logic and resource management
- **UI Layout Violations**: Massive UI layout setup mixed with configuration and business logic
- **Method Delegation Violations**: Architectural anti-pattern of importing all methods from window_methods creating tight coupling
- **System Integration Violations**: System tray, worker threads, and event handling mixed with UI concerns

## Target Architecture: Hexagonal Architecture

### Core Architectural Principles

1. **Hexagonal Architecture (Clean Architecture)**

   - **Domain Layer**: Pure business logic, no external dependencies
   - **Application Layer**: Use cases and application services
   - **Infrastructure Layer**: External systems and frameworks
   - **Presentation Layer**: PyQt6 UI (separate from application layer)

1. **Domain-Driven Design (DDD)**

   - Rich domain models with business logic
   - Aggregate roots for consistency boundaries
   - Value objects for type safety
   - Domain events for decoupling

1. **Dependency Inversion**

   - Domain layer has no dependencies on infrastructure
   - Infrastructure implements domain interfaces
   - Application layer orchestrates use cases

1. **Enterprise UIContainer Utilization**

- mirror existing enterprise-level UIContainer with comprehensive dependency injection capabilities
  - Constructor injection throughout
  - Thread-safe service resolution

### Layer Structure

#### Domain Layer (Core)

```
src/domain/
├── audio/
│   ├── entities/
│   │   ├── audio_session.py        # Recording session aggregate
│   │   ├── recording_state.py      # Recording state entity
│   │   └── audio_file.py           # Audio file entity
│   ├── value_objects/
│   │   ├── audio_format.py         # Audio format (WAV, MP3, etc.)
│   │   ├── sample_rate.py          # Sample rate with validation
│   │   ├── bit_depth.py            # Bit depth value object
│   │   ├── duration.py             # Duration with business rules
│   │   └── audio_quality.py        # Quality settings
│   ├── events/
│   │   ├── recording_started.py     # Domain event
│   │   ├── recording_stopped.py     # Domain event
│   │   ├── audio_captured.py        # Domain event
│   │   └── audio_saved.py          # Domain event
│   ├── repositories/
│   │   └── audio_repository.py     # Repository interface
│   └── services/
│       └── audio_processing_service.py # Domain service
├── transcription/
│   ├── entities/
│   │   ├── transcription_result.py  # Transcription aggregate
│   │   ├── model_instance.py        # Model entity
│   │   └── transcription_segment.py # Segment entity
│   ├── value_objects/
│   │   ├── language.py              # Language with validation
│   │   ├── confidence_score.py      # Confidence value object
│   │   ├── **REFERENCE** `src/ui/domain/value_objects.py` **ModelType enum** # Use existing model type enumeration
│   │   ├── **REFERENCE** `src/ui/domain/value_objects.py` **Quantization enum** # Use existing quantization enumeration
│   │   └── transcription_text.py      # Text with validation
│   ├── events/
│   │   ├── model_loaded.py          # Domain event
│   │   ├── transcription_completed.py # Domain event
│   │   └── model_download_progress.py # Domain event
│   ├── repositories/
│   │   └── transcription_repository.py # Repository interface
│   └── services/
│       └── transcription_service.py   # Domain service
├── llm/
│   ├── entities/
│   │   ├── llm_request.py           # LLM request aggregate
│   │   └── processing_result.py     # Result entity
│   ├── value_objects/
│   │   ├── prompt_template.py       # Template validation
│   │   ├── **REFERENCE** `src/ui/domain/value_objects.py` **ModelType enum** # Use existing model type enumeration
│   │   ├── processing_options.py    # Processing configuration
│   │   └── processed_text.py        # Processed text value object
│   ├── events/
│   │   ├── text_processed.py        # Domain event
│   │   └── llm_configured.py      # Domain event
│   └── repositories/
│       └── llm_repository.py        # Repository interface
├── settings/
│   ├── entities/
│   │   ├── user_preferences.py      # Settings aggregate
│   │   └── hotkey_binding.py        # Hotkey entity
│   ├── value_objects/
│   │   ├── **REFERENCE** `src/ui/domain/value_objects.py` **KeyCombination VO** # Use existing keyboard combinations validation
│   │   ├── file_path.py             # Path validation
│   │   ├── theme_settings.py         # Theme configuration
│   │   └── audio_device.py           # Device configuration
│   ├── events/
│   │   ├── settings_changed.py       # Domain event
│   │   └── hotkey_updated.py         # Domain event
│   └── repositories/
│       └── settings_repository.py    # Repository interface
├── media/
│   ├── entities/
│   │   ├── media_file.py             # Media file aggregate
│   │   ├── conversion_job.py         # Conversion job entity
│   │   └── batch_processing_session.py # Batch processing entity
│   ├── value_objects/
│   │   ├── file_format.py            # File format validation
│   │   ├── media_duration.py         # Duration with business rules
│   │   ├── conversion_quality.py     # Quality settings
│   │   └── progress_percentage.py    # Progress validation
│   ├── events/
│   │   ├── conversion_started.py     # Domain event
│   │   ├── conversion_completed.py   # Domain event
│   │   ├── batch_processing_started.py # Domain event
│   │   └── transcription_batch_completed.py # Domain event
│   └── repositories/
│       └── media_repository.py       # Repository interface
├── ui_coordination/
│   ├── entities/
│   │   ├── ui_session.py             # UI session aggregate
│   │   └── animation_state.py        # Animation state entity
│   ├── value_objects/
│   │   ├── opacity_level.py          # Opacity validation
│   │   ├── animation_duration.py     # Duration validation
│   │   └── ui_message.py             # Message validation
│   ├── events/
│   │   ├── ui_state_changed.py       # Domain event
│   │   └── animation_completed.py    # Domain event
│   └── repositories/
│       └── ui_state_repository.py    # Repository interface
├── audio_visualization/
│   ├── entities/
│   │   ├── audio_visualization.py    # Audio visualization aggregate
│   │   ├── audio_buffer.py           # Audio buffer entity with rolling window management
│   │   └── audio_normalization.py   # Speech-specific normalization algorithms
│   ├── value_objects/
│   │   ├── sample_rate.py            # Sample rate validation (16kHz)
│   │   ├── chunk_size.py             # Chunk size validation (1024 samples)
│   │   ├── buffer_size.py            # Buffer size validation (100 chunks)
│   │   └── normalization_parameters.py # Normalization parameters (scale, clipping)
│   ├── events/
│   │   ├── visualization_started.py  # Domain event
│   │   ├── visualization_stopped.py  # Domain event
│   │   └── audio_data_processed.py   # Domain event
│   └── repositories/
│       └── visualization_repository.py # Repository interface
├── settings/
│   ├── entities/
│   │   ├── user_preferences.py       # User preferences aggregate with comprehensive default management
│   │   ├── settings_configuration.py # Settings configuration entity with validation
│   │   └── hotkey_binding.py         # Hotkey validation and key combination management
│   ├── value_objects/
│   │   ├── model_path.py             # Model path validation
│   │   ├── **REFERENCE** `src/ui/domain/value_objects.py` **Quantization enum** # Use existing quantization enumeration
│   │   ├── sound_file_path.py        # Sound file path validation with supported formats
│   │   ├── recording_key.py          # Recording key validation and format rules
│   │   └── **REFERENCE** `src/ui/domain/value_objects.py` **LLMConfiguration VO** # Use existing LLM configuration validation
│   ├── events/
│   │   ├── settings_changed.py       # Domain event
│   │   ├── hotkey_updated.py         # Domain event
│   │   └── configuration_reset.py    # Domain event
│   └── repositories/
│       └── settings_repository.py    # Repository interface
├── ui_widgets/
│   ├── entities/
│   │   ├── toggle_widget.py          # Toggle widget behavior and state management
│   │   └── widget_state.py           # Widget state management and visual coordination
│   ├── value_objects/
│   │   ├── widget_dimensions.py      # Widget size validation (23x11 pixels)
│   │   └── widget_styling.py         # Widget styling rules and CSS validation
│   ├── events/
│   │   ├── widget_state_changed.py   # Domain event
│   │   └── widget_clicked.py         # Domain event
│   └── repositories/
│       └── widget_repository.py      # Repository interface
├── progress_management/
│   ├── entities/
│   │   ├── progress_session.py       # Progress session coordination and lifecycle management
│   │   ├── progress_bar_lifecycle.py # Progress bar reparenting and lifecycle business rules
│   │   └── download_progress.py      # Download progress tracking and coordination business rules
│   ├── value_objects/
│   │   ├── progress_state.py          # Progress state validation (downloading flags)
│   │   └── progress_percentage.py     # Progress percentage validation (0-100)
│   ├── events/
│   │   ├── progress_started.py        # Domain event
│   │   ├── progress_updated.py        # Domain event
│   │   └── progress_completed.py      # Domain event
│   └── repositories/
│       └── progress_repository.py     # Repository interface
├── main_window/
│   ├── entities/
│   │   ├── main_window.py            # Main window coordination and lifecycle management
│   │   ├── window_configuration.py   # Window configuration business rules and validation
│   │   ├── ui_layout.py              # UI layout coordination and widget positioning business rules
│   │   └── visualization_integration.py # Voice visualizer integration and coordination business rules
│   ├── value_objects/
│   │   ├── **REFERENCE** `src/ui/domain/value_objects.py` **WindowDimensions VO** # Use existing window dimensions validation
│   │   ├── icon_path.py               # Icon path validation and resource management
│   │   ├── color_palette.py           # Color palette validation and theme rules
│   │   ├── opacity_level.py           # Opacity level validation (0.0-1.0)
│   │   └── z_order_level.py           # Z-order layering validation and rules
│   ├── events/
│   │   ├── window_shown.py            # Domain event
│   │   ├── window_configured.py       # Domain event
│   │   └── layout_initialized.py     # Domain event
│   └── repositories/
│       └── window_repository.py       # Repository interface
└── system_integration/
    ├── entities/
    │   ├── system_tray_integration.py # System tray integration and coordination business rules
    │   ├── worker_thread_coordination.py # Worker thread coordination and management business rules
    │   └── event_system_integration.py # Event system integration and filtering business rules
    ├── value_objects/
    │   ├── tray_icon_path.py          # Tray icon path validation
    │   └── thread_reference.py        # Thread reference validation and lifecycle rules
    ├── events/
    │   ├── tray_activated.py          # Domain event
    │   ├── workers_initialized.py     # Domain event
    │   └── event_filter_installed.py  # Domain event
    └── repositories/
        └── system_integration_repository.py # Repository interface
```

#### Application Layer (Use Cases)

```
src/application/
├── audio_recording/
│   ├── use_cases/
│   │   ├── start_recording_use_case.py     # Start recording
│   │   ├── stop_recording_use_case.py      # Stop recording
│   │   ├── configure_audio_use_case.py     # Configure audio
│   │   └── get_recording_status_use_case.py # Get status
│   ├── dto/
│   │   ├── recording_request_dto.py        # Request data
│   │   ├── recording_response_dto.py       # Response data
│   │   └── audio_config_dto.py             # Configuration data
│   └── interfaces/
│       └── audio_service_interface.py      # Service interface
├── transcription/
│   ├── use_cases/
│   │   ├── transcribe_audio_use_case.py    # Transcribe audio
│   │   ├── load_model_use_case.py          # Load model
│   │   ├── download_model_use_case.py      # Download model
│   │   └── get_transcription_history_use_case.py # History
│   ├── dto/
│   │   ├── transcription_request_dto.py    # Request data
│   │   ├── transcription_response_dto.py   # Response data
│   │   └── model_config_dto.py             # Model configuration
│   └── interfaces/
│       └── transcription_service_interface.py # Service interface
├── llm_processing/
│   ├── use_cases/
│   │   ├── process_text_use_case.py        # Process text
│   │   ├── configure_llm_use_case.py       # Configure LLM
│   │   └── load_llm_model_use_case.py      # Load LLM model
│   ├── dto/
│   │   ├── llm_request_dto.py              # Request data
│   │   └── processing_response_dto.py        # Response data
│   └── interfaces/
│       └── llm_service_interface.py        # Service interface
├── settings/
│   ├── use_cases/
│   │   ├── load_settings_use_case.py        # Load settings
│   │   ├── save_settings_use_case.py        # Save settings
│   │   ├── update_hotkey_use_case.py        # Update hotkey
│   │   └── reset_settings_use_case.py       # Reset settings
│   ├── dto/
│   │   ├── settings_dto.py                  # Settings data
│   │   └── hotkey_config_dto.py             # Hotkey configuration
│   └── interfaces/
│       └── settings_service_interface.py    # Service interface
└── application_lifecycle/
    ├── use_cases/
    │   ├── startup_application_use_case.py  # Application startup workflow
    │   ├── shutdown_application_use_case.py # Graceful application shutdown
    │   ├── check_single_instance_use_case.py # Single instance validation
    │   └── activate_existing_instance_use_case.py # Activate running instance
    ├── dto/
    │   ├── startup_config_dto.py            # Startup configuration
    │   ├── application_state_dto.py         # Application state data
    │   └── instance_info_dto.py             # Instance information
    └── interfaces/
        ├── lifecycle_service_interface.py   # Lifecycle service interface
        └── single_instance_service_interface.py # Single instance interface
├── configuration/
│   ├── use_cases/
│   │   ├── load_configuration_use_case.py   # Configuration loading workflow
│   │   ├── update_model_config_use_case.py  # Model configuration updates
│   │   └── update_llm_config_use_case.py    # LLM configuration updates
│   ├── dto/
│   │   ├── configuration_dto.py             # Configuration data
│   │   ├── model_config_dto.py              # Model configuration data
│   │   └── llm_config_dto.py                # LLM configuration data
│   └── interfaces/
│       └── configuration_service_interface.py # Configuration service interface
├── worker_management/
│   ├── use_cases/
│   │   ├── initialize_workers_use_case.py   # Worker initialization workflow
│   │   ├── cleanup_worker_use_case.py       # Worker cleanup workflow
│   │   └── initialize_llm_worker_use_case.py # LLM worker initialization
│   ├── dto/
│   │   ├── worker_config_dto.py             # Worker configuration data
│   │   └── worker_status_dto.py             # Worker status data
│   └── interfaces/
│       └── worker_management_service_interface.py # Worker management service interface
└── media_processing/
    ├── use_cases/
    │   ├── process_media_files_use_case.py  # Media file processing workflow
    │   ├── convert_video_use_case.py        # Video conversion workflow
    │   ├── batch_transcribe_use_case.py     # Batch transcription workflow
    │   ├── transcribe_file_use_case.py      # File transcription workflow
    │   └── transcribe_audio_data_use_case.py # Audio data transcription workflow
    ├── dto/
    │   ├── media_processing_request_dto.py  # Media processing request data
    │   ├── transcription_result_dto.py      # Transcription result data
    │   └── batch_progress_dto.py            # Batch processing progress data
    └── interfaces/
        └── media_processing_service_interface.py # Media processing service interface
├── audio_visualization/
│   ├── use_cases/
│   │   ├── start_visualization_use_case.py  # Visualization startup workflow
│   │   ├── stop_visualization_use_case.py   # Visualization shutdown workflow
│   │   ├── process_audio_data_use_case.py   # Audio data processing workflow
│   │   └── normalize_audio_use_case.py      # Audio normalization workflow
│   ├── dto/
│   │   ├── visualization_config_dto.py      # Visualization configuration data
│   │   ├── audio_data_dto.py                # Audio data transfer object
│   │   └── normalization_result_dto.py      # Normalization result data
│   └── interfaces/
│       └── audio_visualization_service_interface.py # Audio visualization service interface
├── settings/
│   ├── use_cases/
│   │   ├── load_settings_use_case.py        # Settings loading workflow with validation
│   │   ├── save_settings_use_case.py        # Settings saving workflow with validation
│   │   ├── update_hotkey_use_case.py        # Hotkey updating workflow with key validation
│   │   ├── reset_settings_use_case.py       # Settings reset workflow with validation
│   │   ├── validate_settings_use_case.py    # Settings validation workflow with business rules
│   │   └── apply_settings_use_case.py       # Settings application workflow with parent communication
│   ├── dto/
│   │   ├── settings_config_dto.py           # Settings configuration data
│   │   ├── hotkey_update_dto.py             # Hotkey update data
│   │   └── validation_result_dto.py         # Validation result data
│   └── interfaces/
│       └── settings_service_interface.py    # Settings service interface
├── ui_widgets/
│   ├── use_cases/
│   │   ├── create_toggle_widget_use_case.py # Toggle widget creation workflow
│   │   ├── update_widget_state_use_case.py  # Widget state update workflow
│   │   └── handle_widget_event_use_case.py  # Widget event handling workflow
│   ├── dto/
│   │   ├── widget_config_dto.py             # Widget configuration data
│   │   ├── widget_state_dto.py              # Widget state data
│   │   └── widget_event_dto.py              # Widget event data
│   └── interfaces/
│       └── widget_service_interface.py      # Widget service interface
├── progress_management/
│   ├── use_cases/
│   │   ├── start_progress_session_use_case.py # Progress session startup workflow
│   │   ├── update_progress_use_case.py       # Progress update workflow
│   │   ├── complete_progress_use_case.py     # Progress completion workflow
│   │   └── reparent_progress_bar_use_case.py # Progress bar reparenting workflow
│   ├── dto/
│   │   ├── progress_session_dto.py           # Progress session data
│   │   ├── progress_update_dto.py            # Progress update data
│   │   └── progress_lifecycle_dto.py         # Progress lifecycle data
│   └── interfaces/
│       └── progress_service_interface.py     # Progress service interface
├── main_window/
│   ├── use_cases/
│   │   ├── initialize_main_window_use_case.py # Main window initialization workflow
│   │   ├── configure_window_use_case.py      # Window configuration workflow
│   │   ├── setup_ui_layout_use_case.py       # UI layout setup workflow
│   │   ├── integrate_visualization_use_case.py # Voice visualizer integration workflow
│   │   ├── manage_opacity_effects_use_case.py # Opacity effects management workflow
│   │   └── update_ui_text_use_case.py        # Dynamic UI text update workflow
│   ├── dto/
│   │   ├── window_config_dto.py              # Window configuration data
│   │   ├── layout_config_dto.py              # Layout configuration data
│   │   └── visualization_config_dto.py       # Visualization configuration data
│   └── interfaces/
│       └── main_window_service_interface.py  # Main window service interface
└── system_integration/
    ├── use_cases/
    │   ├── initialize_system_tray_use_case.py # System tray initialization workflow
    │   ├── setup_worker_threads_use_case.py  # Worker thread setup workflow
    │   ├── install_event_filter_use_case.py  # Event filter installation workflow
    │   ├── enable_drag_drop_use_case.py      # Drag and drop enablement workflow
    │   └── manage_geometry_use_case.py       # Geometry management workflow
    ├── dto/
    │   ├── tray_config_dto.py                # Tray configuration data
    │   ├── worker_setup_dto.py               # Worker setup data
    │   └── event_filter_dto.py               # Event filter data
    └── interfaces/
        └── system_integration_service_interface.py # System integration service interface
```

#### Infrastructure Layer (External Systems)

```
src/infrastructure/
├── audio/
│   ├── pyaudio_service.py                # PyAudio implementation
│   ├── vad_service.py                    # VAD implementation (VaDetector)
│   ├── keyboard_service.py               # Keyboard hook implementation
│   ├── audio_file_repository.py          # Audio file persistence
│   ├── pyqt_audio_adapter.py             # PyQt signal adapter for AudioToText
│   ├── vad_worker_service.py             # VAD worker with PyQt threading
│   ├── listener_worker_service.py        # Audio listener worker with recording management
│   └── listener_service.py               # Consolidated listener service (merges utils/listener.py + src/core/utils/listener.py)
├── transcription/
│   ├── onnx_transcription_service.py     # Consolidated ONNX Whisper implementation (merges utils/transcribe.py + src/core/utils/transcribe.py)
│   ├── model_download_service.py         # Model download with progress
│   ├── model_cache_service.py            # Organized cache structure
│   ├── transcription_file_repository.py  # Transcription persistence
│   ├── model_repository.py               # Model storage
│   └── model_worker_service.py           # Transcription model worker with PyQt threading
├── llm/
│   ├── onnx_llm_service.py               # ONNX LLM implementation
│   ├── llm_file_repository.py            # LLM persistence
│   ├── llm_worker_service.py             # LLM worker with PyQt threading and inference
│   └── gemma_inference_service.py        # Gemma model loading and text generation service
├── settings/
│   ├── json_settings_repository.py       # JSON settings storage
│   └── file_system_service.py          # File system operations
├── system/
│   ├── environment_service.py            # Environment configuration and warnings
│   ├── platform_service.py               # Platform-specific operations (win32gui)
│   ├── subprocess_service.py             # Subprocess utilities and suppression
│   ├── single_instance_service.py        # Single instance management
│   ├── window_activation_service.py      # Window enumeration and activation
│   ├── resource_service.py               # Resource path management
│   ├── application_lifecycle_service.py  # Application startup and cleanup
│   ├── logging_service.py                # **mirror existing** logger/logger.py setup_logger function
│   ├── tray_icon_service.py              # System tray management
│   └── **REFERENCE** `src/ui/core/events.py` **UIEventSystem** # Use existing comprehensive enterprise event system with mediator pattern, CQRS, priority handling
├── media/
│   ├── file_validation_service.py        # Media file type validation
│   ├── video_conversion_service.py       # FFmpeg video conversion service
│   ├── media_scanner_service.py          # Folder scanning for media files
│   ├── batch_processor_service.py        # Batch file processing queue management
│   └── progress_tracking_service.py      # Progress calculation and tracking
├── ui/
│   ├── **REFERENCE** `src/ui/core/patterns.py` **Animation Strategies** # Use existing comprehensive animation patterns (FadeInStrategy, SlideInStrategy, AnimationContext)
│   ├── message_display_service.py        # Message display with effects
│   ├── drag_drop_service.py              # Drag and drop handling
│   ├── file_dialog_service.py            # File dialog configuration
│   ├── progress_ui_service.py            # Progress bar UI management
│   └── state_management_service.py       # UI state coordination
├── audio_visualization/
│   ├── audio_processor_service.py        # PyAudio-based audio processing with threading
│   ├── visualization_controller_service.py # Visualization lifecycle management
│   ├── audio_stream_service.py           # PyAudio stream management with fallback handling
│   ├── buffer_management_service.py      # Rolling buffer management
│   ├── audio_normalization_service.py    # Speech normalization algorithms
│   └── resource_cleanup_service.py       # Audio resource cleanup management
├── settings/
│   ├── settings_repository_service.py    # Settings persistence with JSON storage and progress tracking
│   ├── settings_validation_service.py    # Settings validation with business rules and progress callbacks
│   ├── hotkey_recording_service.py       # Key recording and combination validation with progress tracking
│   ├── file_dialog_service.py            # File browsing and validation with progress callbacks
│   ├── drag_drop_service.py              # Drag and drop handling with file type validation
│   └── settings_migration_service.py     # Settings migration and upgrade logic
├── ui_widgets/
│   ├── toggle_widget_service.py          # Toggle widget implementation with styling and event handling
│   ├── widget_styling_service.py         # Widget styling and CSS management
│   └── widget_event_service.py           # Widget event handling with mouse and paint events
├── progress_management/
│   ├── progress_bar_reparenting_service.py # Complex progress bar reparenting and lifecycle management
│   ├── progress_tracking_service.py      # Progress tracking with percentage calculation and callbacks
│   ├── ui_state_management_service.py    # UI element enable/disable with visual feedback and opacity effects
│   └── timer_management_service.py       # Debounce timer management and delayed operations
├── main_window/
│   ├── window_configuration_service.py   # Window configuration with palette, icon, and size management
│   ├── ui_layout_service.py              # Massive UI layout management with widget creation and positioning
│   ├── visualization_integration_service.py # PyQtGraph visualization integration with waveform plotting
│   ├── opacity_effects_service.py        # Complex opacity effects management for recording states
│   ├── ui_text_management_service.py     # Dynamic UI text updates with translation support
│   └── widget_layering_service.py        # Widget z-order management and raising sequences
├── system_integration/
│   ├── system_tray_service.py            # System tray integration with menu actions and icon management
│   ├── worker_thread_management_service.py # Worker thread coordination and reference management
│   ├── event_filter_service.py           # Event filter installation and system event handling
│   ├── drag_drop_integration_service.py  # Drag and drop enablement with file handling
│   ├── geometry_management_service.py    # Geometry management with central widget sizing
│   └── method_delegation_service.py      # Method delegation pattern (architectural refactoring required)
└── presentation/
    ├── qt/
    │   ├── main_window.py               # Main window coordinator (refactored)
    │   ├── ui_setup_component.py        # UI setup component (refactored)
    │   ├── window_config_component.py   # Window configuration UI section (refactored)
    │   ├── widget_layout_component.py   # Widget layout and styling UI section (refactored)
    │   ├── visualization_component.py   # Voice visualizer UI integration (refactored)
    │   ├── translation_component.py     # UI text and translation handling (refactored)
    │   ├── settings_dialog.py           # Settings dialog coordinator (refactored)
    │   ├── toggle_switch_widget.py      # Custom toggle widget UI (refactored)
    │   ├── model_config_widget.py       # Model configuration section UI (refactored)
    │   ├── llm_config_widget.py         # LLM configuration section UI (refactored)
    │   ├── sound_config_widget.py       # Sound configuration section UI (refactored)
    │   ├── hotkey_config_widget.py      # Hotkey configuration section UI (refactored)
    │   ├── progress_management_widget.py # Progress bar and download UI coordination (refactored)
    │   ├── voice_visualizer.py          # Audio visualization (refactored)
    │   ├── worker_integration.py        # PyQt worker integration orchestration
    │   ├── worker_imports.py            # Common worker imports and logging setup
    │   └── application_bootstrap.py     # QApplication setup and configuration
    └── system/
        └── error_handling_service.py    # Application-level error handling
```

## Detailed Refactoring Phases

### Phase 1: Foundation & Domain Layer (Week 1-2)

#### 1.1 Core Domain Infrastructure

| Task | File | Lines | Actions | Dependencies |
|------|------|-------|---------|--------------|
| - [x] **UIAggregateRoot Base Class** | **ALREADY EXISTS** | `src/ui/core/abstractions.py` | 301-331 | **mirror existing** - DDD aggregate root with domain events and consistency management |
| - [x] **UIEntity Base Class** | **ALREADY EXISTS** | `src/ui/core/abstractions.py` | 377-418 | **mirror existing** - DDD entity with identity, timestamps, equality, and hash implementation |
| - [x] **Create Value Object Base** | `src/domain/common/value_object.py` | 1-30 | Implement value object with equality and immutability | None |
| - [x] **UIEvent Base Class** | **ALREADY EXISTS** | `src/ui/core/abstractions.py` | 72-95 | **mirror existing** - Domain event base class with timestamp/ID generation and UIEventType enumeration |
| - [x] **Result Pattern** | **ALREADY EXISTS** | `src/ui/core/abstractions.py` | 33-66 | **mirror existing** - Railway-oriented programming with functional error handling (success/failure, map, bind operations) |
| - [x] **Create ProgressCallback Interface** | `src/domain/common/progress_callback.py` | 1-30 | Define progress callback for non-blocking operations | None |
| - [x] **Create ProcessingStatus Entity** | `src/domain/common/entities/processing_status.py` | 1-40 | Create processing status entity |
| - [x] **Create DownloadProgress Entity** | `src/domain/common/entities/download_progress.py` | 1-40 | Create download progress entity |
| - [x] **Create ProgressPercentage VO** | `src/domain/common/value_objects/progress_percentage.py` | 1-30 | Create progress percentage value object |
| - [x] **Utilize UI Abstractions** | **ALREADY EXISTS** | `src/ui/core/abstractions.py` | 1-462 | **mirror existing** - Comprehensive architectural patterns foundation (13 patterns including Result, CQRS, DDD, MVP, Observer, Mediator, Strategy, Repository) |
| - [x] **Utilize UI Patterns** | **ALREADY EXISTS** | `src/ui/core/patterns.py` | 1-632 | **mirror existing** - Comprehensive design patterns library (Factory, Builder, Strategy, Decorator, Command patterns with PyQt6 integration, Animation strategies, Widget creation, Component enhancement, Undo/redo functionality) |

#### 1.2 Audio Domain Entities

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **AudioSession Aggregate** | `utils/listener.py` | `src/domain/audio/entities/audio_session.py` | 100-200, 300-400 | Extract recording session state, business rules |
| - [x] **RecordingState Entity** | `utils/listener.py` | `src/domain/audio/entities/recording_state.py` | 150-250 | Extract recording state management |
| - [x] **AudioFormat VO** | `utils/listener.py` | `src/domain/audio/value_objects/audio_format.py` | 50-100 | Extract audio format validation |
| - [x] **SampleRate VO** | `utils/listener.py` | `src/domain/audio/value_objects/sample_rate.py` | 80-120 | Extract sample rate business rules |
| - [x] **Duration VO** | `utils/listener.py` | `src/domain/audio/value_objects/duration.py` | 200-250 | Extract duration calculations |

#### 1.3 Transcription Domain Entities

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **TranscriptionResult Aggregate** | `utils/transcribe.py` | `src/domain/transcription/entities/transcription_result.py` | 300-500, 700-800 | Extract transcription results, segments |
| - [x] **ModelInstance Entity** | `utils/transcribe.py` | `src/domain/transcription/entities/model_instance.py` | 100-200, 400-500 | Extract model management logic |
| - [x] **Language VO** | `utils/transcribe.py` | `src/domain/transcription/value_objects/language.py` | 150-200 | Extract language validation |
| - [x] **ConfidenceScore VO** | `utils/transcribe.py` | `src/domain/transcription/value_objects/confidence_score.py` | 600-700 | Extract confidence calculations |
| - [x] **Quantization Enum** | **ALREADY EXISTS** | `src/ui/domain/value_objects.py` | 139-142 | **mirror existing** - Quantization level enumeration (Full, Quantized) |

#### 1.4 Settings Domain Entities

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **UserPreferences Aggregate** | `src/ui/settings_dialog.py` | `src/domain/settings/entities/user_preferences.py` | 200-400, 800-1000 | Extract settings validation, business rules |
| - [x] **HotkeyBinding Entity** | `src/ui/settings_dialog.py` | `src/domain/settings/entities/hotkey_binding.py` | 500-600 | Extract hotkey validation logic |
| - [x] **KeyCombination VO** | **ALREADY EXISTS** | `src/ui/domain/value_objects.py` | 71-108 | **mirror existing** - Keyboard combinations with modifier validation and string parsing |
| - [x] **FilePath VO** | `src/ui/settings_dialog.py` | `src/domain/settings/value_objects/file_path.py` | 700-800 | Extract file path validation |
| - [x] **AudioDevice VO** | `src/ui/settings_dialog.py` | `src/domain/settings/value_objects/audio_device.py` | 1400-1450 | Extract device configuration validation |

#### 1.5 Media Domain Entities

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **MediaFile Aggregate** | `src/ui/window_methods.py` | `src/domain/media/entities/media_file.py` | 712-724, 738-776 | Extract media file business rules, validation, processing coordination |
| - [x] **ConversionJob Entity** | `src/ui/window_methods.py` | `src/domain/media/entities/conversion_job.py` | 778-811, 836-848 | Extract video conversion job management with business rules |
| - [x] **BatchProcessingSession Entity** | `src/ui/window_methods.py` | `src/domain/media/entities/batch_processing_session.py` | 813-929 | Extract batch processing coordination and progress management |
| - [x] **FileFormat VO** | `src/ui/window_methods.py` | `src/domain/media/value_objects/file_format.py` | 712-724 | Extract file format validation business rules |
| - [x] **MediaDuration VO** | `src/ui/window_methods.py` | `src/domain/media/value_objects/media_duration.py` | 946-953 | Extract duration calculations and SRT formatting rules |
| - [x] **ConversionQuality VO** | `src/ui/window_methods.py` | `src/domain/media/value_objects/conversion_quality.py` | 787 | Extract video conversion quality settings validation |

#### 1.6 UI Coordination Domain Entities

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **UISession Aggregate** | `src/ui/window_methods.py` | `src/domain/ui_coordination/entities/ui_session.py` | 1333-1345, 341-470 | Extract UI session state management and coordination business rules |
| - [x] **AnimationState Entity** | `src/ui/window_methods.py` | `src/domain/ui_coordination/entities/animation_state.py` | 1079-1217 | Extract animation state management and coordination business rules |
| - [x] **OpacityLevel VO** | `src/ui/window_methods.py` | `src/domain/ui_coordination/value_objects/opacity_level.py` | 1092-1096, 1153-1154 | Extract opacity level validation (0.0-1.0, 0.4 dimming rules) |
| - [x] **AnimationDuration VO** | `src/ui/window_methods.py` | `src/domain/ui_coordination/value_objects/animation_duration.py` | 1093, 1142, 1212-1213 | Extract animation duration validation (500ms, 1000ms) |
| - [x] **UIMessage VO** | `src/ui/window_methods.py` | `src/domain/ui_coordination/value_objects/ui_message.py` | 341-373, 375-377 | Extract UI message validation and formatting business rules |

#### 1.7 Audio Visualization Domain Entities

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **AudioVisualization Aggregate** | `src/ui/voice_visualizer.py` | `src/domain/audio_visualization/entities/audio_visualization.py` | 155-193, 163-183 | Extract visualization lifecycle coordination and state management business rules |
| - [x] **AudioBuffer Entity** | `src/ui/voice_visualizer.py` | `src/domain/audio_visualization/entities/audio_buffer.py` | 18-25, 114-119 | Extract audio buffer management with rolling window business rules |
| - [x] **AudioNormalization Entity** | `src/ui/voice_visualizer.py` | `src/domain/audio_visualization/entities/audio_normalization.py` | 131-153 | Extract speech-specific normalization algorithms and business rules |
| - [x] **SampleRate VO** | `src/ui/voice_visualizer.py` | `src/domain/audio_visualization/value_objects/sample_rate.py` | 18 | Extract sample rate validation (16kHz) |
| - [x] **ChunkSize VO** | `src/ui/voice_visualizer.py` | `src/domain/audio_visualization/value_objects/chunk_size.py` | 19 | Extract chunk size validation (1024 samples) |
| - [x] **BufferSize VO** | `src/ui/voice_visualizer.py` | `src/domain/audio_visualization/value_objects/buffer_size.py` | 20 | Extract buffer size validation (100 chunks) |
| - [x] **NormalizationParameters VO** | `src/ui/voice_visualizer.py` | `src/domain/audio_visualization/value_objects/normalization_parameters.py` | 139-147 | Extract normalization parameters (scale factors, clipping ranges) |

#### 1.8 Settings Management Domain Entities

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **UserPreferences Aggregate** | `src/ui/settings_dialog.py` | `src/domain/settings/entities/user_preferences.py` | 166-186, 1295-1318 | Extract settings coordination and validation business rules with comprehensive default management |
| - [x] **SettingsConfiguration Entity** | `src/ui/settings_dialog.py` | `src/domain/settings/entities/settings_configuration.py` | 1265-1294, 1303-1318 | Extract configuration loading/saving business rules and validation |
| - [x] **HotkeyBinding Entity** | `src/ui/settings_dialog.py` | `src/domain/settings/entities/hotkey_binding.py` | 867-969 | Extract hotkey validation logic and key combination management |
| - [x] **ModelPath VO** | `src/ui/settings_dialog.py` | `src/domain/settings/value_objects/model_path.py` | 122-124 | Extract model path validation |
| - [x] **Quantization Enum** | **ALREADY EXISTS** | `src/ui/domain/value_objects.py` | 139-142 | **mirror existing** - Quantization level enumeration (Full, Quantized) |
| - [x] **SoundFilePath VO** | `src/ui/settings_dialog.py` | `src/domain/settings/value_objects/sound_file_path.py` | 125, 670-680 | Extract sound file path validation with supported formats |
| - [x] **RecordingKey VO** | `src/ui/settings_dialog.py` | `src/domain/settings/value_objects/recording_key.py` | 127, 254-256 | Extract recording key validation and format rules |
| - [x] **LLMConfiguration VO** | **ALREADY EXISTS** | `src/ui/domain/value_objects.py` | 184-205 | **mirror existing** - LLM configuration with prompt validation and parameter limits |

#### 1.9 UI Widget Domain Entities

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **ToggleWidget Aggregate** | `src/ui/settings_dialog.py` | `src/domain/ui_widgets/entities/toggle_widget.py` | 27-112 | Extract toggle widget behavior and state management business rules |
| - [x] **WidgetState Entity** | `src/ui/settings_dialog.py` | `src/domain/ui_widgets/entities/widget_state.py` | 59-66, 68-106 | Extract widget state management and visual state coordination |
| - [x] **WidgetDimensions VO** | `src/ui/settings_dialog.py` | `src/domain/ui_widgets/value_objects/widget_dimensions.py` | 33 | Extract widget size validation (23x11 pixels) |
| - [x] **WidgetStyling VO** | `src/ui/settings_dialog.py` | `src/domain/ui_widgets/value_objects/widget_styling.py` | 36-57, 73-105 | Extract widget styling rules and CSS validation |

#### 1.10 Progress Management Domain Entities

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **ProgressSession Aggregate** | `src/ui/settings_dialog.py` | `src/domain/progress_management/entities/progress_session.py` | 135-151, 1571-1613 | Extract progress session coordination and lifecycle management |
| - [x] **ProgressBarLifecycle Entity** | `src/ui/settings_dialog.py` | `src/domain/progress_management/entities/progress_bar_lifecycle.py` | 1362-1409, 1571-1613 | Extract progress bar reparenting and lifecycle business rules |
| - [x] **DownloadProgress Entity** | `src/ui/settings_dialog.py` | `src/domain/progress_management/entities/download_progress.py` | 1187-1208 | Extract download progress tracking and coordination business rules |
| - [x] **ProgressState VO** | `src/ui/settings_dialog.py` | `src/domain/progress_management/value_objects/progress_state.py` | 136, 364, 1573 | Extract progress state validation (downloading flags) |
| - [x] **ProgressPercentage VO** | `src/ui/settings_dialog.py` | `src/domain/progress_management/value_objects/progress_percentage.py` | 1189-1198 | Extract progress percentage validation (0-100) |

#### 1.11 Main Window Domain Entities

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **MainWindow Aggregate** | `src/ui/main_window.py` | `src/domain/main_window/entities/main_window.py` | 278-342, 367-382 | Extract main window coordination and lifecycle management business rules |
| - [x] **WindowConfiguration Entity** | `src/ui/main_window.py` | `src/domain/main_window/entities/window_configuration.py` | 33-66, 324-333 | Extract window configuration business rules and validation |
| - [x] **UILayout Entity** | `src/ui/main_window.py` | `src/domain/main_window/entities/ui_layout.py` | 67-261 | Extract UI layout coordination and widget positioning business rules |
| - [x] **VisualizationIntegration Entity** | `src/ui/main_window.py` | `src/domain/main_window/entities/visualization_integration.py` | 192-210 | Extract voice visualizer integration and coordination business rules |
| - [x] **WindowDimensions VO** | **ALREADY EXISTS** | `src/ui/domain/value_objects.py` | 14-36 | **mirror existing** - Window dimensions validation with aspect ratio and area calculation |
| - [x] **IconPath VO** | `src/ui/main_window.py` | `src/domain/main_window/value_objects/icon_path.py` | 38-40 | Extract icon path validation and resource management |
| - [x] **ColorPalette VO** | `src/ui/main_window.py` | `src/domain/main_window/value_objects/color_palette.py` | 47-66 | Extract color palette validation and theme rules |
| - [x] **OpacityLevel VO** | `src/ui/main_window.py` | `src/domain/main_window/value_objects/opacity_level.py` | 210, 240 | Extract opacity level validation (0.0-1.0) |
| - [x] **ZOrderLevel VO** | `src/ui/main_window.py` | `src/domain/main_window/value_objects/z_order_level.py` | 249-259 | Extract z-order layering validation and rules |

#### 1.12 System Integration Domain Entities

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **SystemTrayIntegration Aggregate** | `src/ui/main_window.py` | `src/domain/system_integration/entities/system_tray_integration.py` | 354-361, 367-371 | Extract system tray integration and coordination business rules |
| - [x] **WorkerThreadCoordination Entity** | `src/ui/main_window.py` | `src/domain/system_integration/entities/worker_thread_coordination.py` | 341-351 | Extract worker thread coordination and management business rules |
| - [x] **EventSystemIntegration Entity** | `src/ui/main_window.py` | `src/domain/system_integration/entities/event_system_integration.py` | 378-381 | Extract event system integration and filtering business rules |
| - [x] **TrayIconPath VO** | `src/ui/main_window.py` | `src/domain/system_integration/value_objects/tray_icon_path.py` | 38-40 | Extract tray icon path validation |
| - [x] **ThreadReference VO** | `src/ui/main_window.py` | `src/domain/system_integration/value_objects/thread_reference.py` | 342-344 | Extract thread reference validation and lifecycle rules |

### Phase 2: Application Layer & Use Cases (Week 3-4)

#### 2.1 Audio Recording Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **StartRecordingUseCase** | `utils/listener.py` | `src/application/audio_recording/use_cases/start_recording_use_case.py` | 300-400, 450-550 | Create recording start logic with progress callbacks |
| - [x] **StopRecordingUseCase** | `utils/listener.py` | `src/application/audio_recording/use_cases/stop_recording_use_case.py` | 350-450, 500-600 | Create recording stop logic with progress tracking |
| - [x] **ConfigureAudioUseCase** | `utils/listener.py` | `src/application/audio_recording/use_cases/configure_audio_use_case.py` | 200-300 | Create audio configuration with progress callbacks |
| - [x] **GetRecordingStatusUseCase** | `utils/listener.py` | `src/application/audio_recording/use_cases/get_recording_status_use_case.py` | 400-500 | Create status checking with progress tracking |
| - [x] **PauseRecordingUseCase** | `utils/listener.py` | `src/application/audio_recording/use_cases/pause_recording_use_case.py` | 450-550 | Create pause recording with progress callbacks |
| - [x] **ResumeRecordingUseCase** | `utils/listener.py` | `src/application/audio_recording/use_cases/resume_recording_use_case.py` | 500-600 | Create resume recording with progress tracking |

#### 2.2 Transcription Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **StartTranscriptionUseCase** | `utils/transcribe.py` | `src/application/transcription/use_cases/start_transcription_use_case.py` | 600-800, 900-1000 | Create transcription startup workflow with model validation |
| - [x] **GetTranscriptionResultUseCase** | `utils/transcribe.py` | `src/application/transcription/use_cases/get_transcription_result_use_case.py` | 400-500, 700-800 | Create result retrieval workflow with progress tracking |
| - [x] **CancelTranscriptionUseCase** | `utils/transcribe.py` | `src/application/transcription/use_cases/cancel_transcription_use_case.py` | 800-900 | Create cancellation workflow with cleanup |
| - [x] **GetTranscriptionHistoryUseCase** | `utils/transcribe.py` | `src/application/transcription/use_cases/get_transcription_history_use_case.py` | 1000-1100 | Create history retrieval with progress tracking |
| - [x] **ConfigureModelUseCase** | `utils/transcribe.py` | `src/application/transcription/use_cases/configure_model_use_case.py` | 900-1000 | Create model configuration workflow with validation |
| - [x] **ValidateModelUseCase** | `utils/transcribe.py` | `src/application/transcription/use_cases/validate_model_use_case.py` | 750-850 | Create model validation workflow with system checks |

#### 2.3 Settings Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **LoadSettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/load_settings_use_case.py` | 100-200 | Create settings loading with progress callbacks |
| - [x] **SaveSettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/save_settings_use_case.py` | 300-400 | Create settings saving with progress tracking |
| - [x] **UpdateHotkeyUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/update_hotkey_use_case.py` | 500-600 | Create hotkey updating with progress callbacks |
| - [x] **ResetSettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/reset_settings_use_case.py` | 400-500 | Create settings reset with progress tracking |
| - [x] **ValidateSettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/validate_settings_use_case.py` | 500-600 | Create settings validation with business rules |
| - [x] **ApplySettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/apply_settings_use_case.py` | 1121-1263 | Create settings application with parent communication |
| - [x] **ExportSettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/export_settings_use_case.py` | 600-700 | Create settings export with progress callbacks |
| - [x] **ImportSettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/import_settings_use_case.py` | 700-800 | Create settings import with progress tracking |

#### 2.4 Application Lifecycle Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **StartupApplicationUseCase** | `src/main.py` | `src/application/application_lifecycle/use_cases/startup_application_use_case.py` | 77-96, 132-139 | Create application startup workflow with progress callbacks |
| - [x] **ShutdownApplicationUseCase** | `src/main.py` | `src/application/application_lifecycle/use_cases/shutdown_application_use_case.py` | 63-67 | Create graceful shutdown workflow with progress tracking |
| - [x] **CheckSingleInstanceUseCase** | `src/main.py` | `src/application/application_lifecycle/use_cases/check_single_instance_use_case.py` | 50-61, 98 | Create single instance validation with progress callbacks |
| - [x] **ActivateExistingInstanceUseCase** | `src/main.py` | `src/application/application_lifecycle/use_cases/activate_existing_instance_use_case.py` | 100-130 | Create window activation workflow with progress tracking |

#### 2.5 Configuration Management Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **LoadConfigurationUseCase** | `src/ui/window_methods.py` | `src/application/configuration/use_cases/load_configuration_use_case.py` | 35-50 | Create configuration loading workflow with progress callbacks |
| - [x] **UpdateModelConfigUseCase** | `src/ui/window_methods.py` | `src/application/configuration/use_cases/update_model_config_use_case.py` | 38-39, 146 | Create model configuration update with progress tracking |
| - [x] **UpdateLLMConfigUseCase** | `src/ui/window_methods.py` | `src/application/configuration/use_cases/update_llm_config_use_case.py` | 45-49, 244-245 | Create LLM configuration update with progress callbacks |
| - [x] **SaveConfigurationUseCase** | `src/ui/window_methods.py` | `src/application/configuration/use_cases/save_configuration_use_case.py` | N/A | Create configuration saving workflow with progress callbacks |

#### 2.6 Worker Lifecycle Management Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **InitializeWorkersUseCase** | `src/ui/window_methods.py` | `src/application/worker_management/use_cases/initialize_workers_use_case.py` | 84-174 | Create worker initialization workflow with progress tracking |
| - [x] **CleanupWorkerUseCase** | `src/ui/window_methods.py` | `src/application/worker_management/use_cases/cleanup_worker_use_case.py` | 95-143 | Create worker cleanup workflow with progress callbacks |
| - [x] **InitializeLLMWorkerUseCase** | `src/ui/window_methods.py` | `src/application/worker_management/use_cases/initialize_llm_worker_use_case.py` | 220-286 | Create LLM worker initialization with progress tracking |

#### 2.7 Media Processing Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **ProcessMediaFilesUseCase** | `src/ui/window_methods.py` | `src/application/media_processing/use_cases/process_media_files_use_case.py` | 738-776 | Create media file processing workflow with progress callbacks |
| - [x] **ConvertVideoUseCase** | `src/ui/window_methods.py` | `src/application/media_processing/use_cases/convert_video_use_case.py` | 778-811 | Create video conversion workflow with progress tracking |
| - [x] **BatchTranscribeUseCase** | `src/ui/window_methods.py` | `src/application/media_processing/use_cases/batch_transcribe_use_case.py` | 813-929 | Create batch transcription workflow with progress callbacks |
| - [x] **ProcessNextFileUseCase** | `src/ui/window_methods.py` | `src/application/media_processing/use_cases/process_next_file_use_case.py` | 813-929 | Create next file processing workflow with progress tracking |
| - [x] **TranscribeAudioDataUseCase** | `src/ui/window_methods.py` | `src/application/media_processing/use_cases/transcribe_audio_data_use_case.py` | 1219-1289 | Create audio data transcription workflow with progress callbacks |

#### 2.8 Audio Visualization Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **StartVisualizationUseCase** | `src/ui/voice_visualizer.py` | `src/application/audio_visualization/use_cases/start_visualization_use_case.py` | 163-169 | Create visualization startup workflow with progress callbacks |
| - [x] **StopVisualizationUseCase** | `src/ui/voice_visualizer.py` | `src/application/audio_visualization/use_cases/stop_visualization_use_case.py` | 171-183 | Create visualization shutdown workflow with progress tracking |
| - [x] **ProcessAudioDataUseCase** | `src/ui/voice_visualizer.py` | `src/application/audio_visualization/use_cases/process_audio_data_use_case.py` | 88-129, 185-189 | Create audio data processing workflow with progress callbacks |
| - [x] **NormalizeAudioUseCase** | `src/ui/voice_visualizer.py` | `src/application/audio_visualization/use_cases/normalize_audio_use_case.py` | 131-153 | Create audio normalization workflow with progress tracking |

#### 2.9 Settings Management Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **LoadSettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/load_settings_use_case.py` | 1265-1294 | Create settings loading workflow with validation and progress callbacks |
| - [x] **SaveSettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/save_settings_use_case.py` | 1295-1318 | Create settings saving workflow with validation and progress tracking |
| - [x] **UpdateHotkeyUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/update_hotkey_use_case.py` | 920-969 | Create hotkey updating workflow with key validation and progress callbacks |
| - [x] **ResetSettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/reset_settings_use_case.py` | 1081-1092 | Create settings reset workflow with validation and progress tracking |
| - [x] **ValidateSettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/validate_settings_use_case.py` | 1298-1302, 186 | Create settings validation workflow with business rules |
| - [x] **ApplySettingsUseCase** | `src/ui/settings_dialog.py` | `src/application/settings/use_cases/apply_settings_use_case.py` | 1121-1263 | Create settings application workflow with parent communication |

#### 2.10 UI Widget Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **CreateToggleWidgetUseCase** | `src/ui/settings_dialog.py` | `src/application/ui_widgets/use_cases/create_toggle_widget_use_case.py` | 27-58 | Create toggle widget creation workflow with styling and validation |
| - [x] **UpdateWidgetStateUseCase** | `src/ui/settings_dialog.py` | `src/application/ui_widgets/use_cases/update_widget_state_use_case.py` | 59-66, 68-106 | Create widget state update workflow with visual feedback |
| - [x] **HandleWidgetEventUseCase** | `src/ui/settings_dialog.py` | `src/application/ui_widgets/use_cases/handle_widget_event_use_case.py` | 59-66, 107-112 | Create widget event handling workflow with state management |

#### 2.11 Progress Management Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **StartProgressSessionUseCase** | `src/ui/settings_dialog.py` | `src/application/progress_management/use_cases/start_progress_session_use_case.py` | 1571-1613 | Create progress session startup workflow with UI state management |
| - [x] **UpdateProgressUseCase** | `src/ui/settings_dialog.py` | `src/application/progress_management/use_cases/update_progress_use_case.py` | 1187-1208 | Create progress update workflow with validation and callbacks |
| - [x] **CompleteProgressUseCase** | `src/ui/settings_dialog.py` | `src/application/progress_management/use_cases/complete_progress_use_case.py` | 1362-1409 | Create progress completion workflow with cleanup and state restoration |
| - [x] **ReparentProgressBarUseCase** | `src/ui/settings_dialog.py` | `src/application/progress_management/use_cases/reparent_progress_bar_use_case.py` | 1582-1613, 1420-1464 | Create progress bar reparenting workflow with lifecycle management |

#### 2.12 Main Window Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **InitializeMainWindowUseCase** | `src/ui/main_window.py` | `src/application/main_window/use_cases/initialize_main_window_use_case.py` | 278-342 | Create main window initialization workflow with configuration and setup |
| - [x] **ConfigureWindowUseCase** | `src/ui/main_window.py` | `src/application/main_window/use_cases/configure_window_use_case.py` | 33-66, 324-333 | Create window configuration workflow with validation and theme setup |
| - [x] **SetupUILayoutUseCase** | `src/ui/main_window.py` | `src/application/main_window/use_cases/setup_ui_layout_use_case.py` | 67-261 | Create UI layout setup workflow with widget positioning and styling |
| - [x] **IntegrateVisualizationUseCase** | `src/ui/main_window.py` | `src/application/main_window/use_cases/integrate_visualization_use_case.py` | 192-210 | Create voice visualizer integration workflow with PyQtGraph setup |
| - [x] **ManageOpacityEffectsUseCase** | `src/ui/main_window.py` | `src/application/main_window/use_cases/manage_opacity_effects_use_case.py` | 207-240 | Create opacity effects management workflow for recording states |
| - [x] **UpdateUITextUseCase** | `src/ui/main_window.py` | `src/application/main_window/use_cases/update_ui_text_use_case.py` | 264-276 | Create dynamic UI text update workflow with translation support |

#### 2.13 System Integration Use Cases (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **InitializeSystemTrayUseCase** | `src/ui/main_window.py` | `src/application/system_integration/use_cases/initialize_system_tray_use_case.py` | 354-361, 367-371 | Create system tray initialization workflow with menu setup |
| - [x] **SetupWorkerThreadsUseCase** | `src/ui/main_window.py` | `src/application/system_integration/use_cases/setup_worker_threads_use_case.py` | 341-351 | Create worker thread setup workflow with coordination |
| - [x] **InstallEventFilterUseCase** | `src/ui/main_window.py` | `src/application/system_integration/use_cases/install_event_filter_use_case.py` | 378-381 | Create event filter installation workflow with system integration |
| - [x] **EnableDragDropUseCase** | `src/ui/main_window.py` | `src/application/system_integration/use_cases/enable_drag_drop_use_case.py` | 286 | Create drag and drop enablement workflow with file handling |
| - [x] **ManageGeometryUseCase** | `src/ui/main_window.py` | `src/application/system_integration/use_cases/manage_geometry_use_case.py` | 373-374 | Create geometry management workflow with window sizing |

### Phase 3: Infrastructure Layer Implementation (Week 5-7)

#### 3.1 Audio Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **VADService** | `utils/listener.py` | `src/infrastructure/audio/vad_service.py` | 150-250 | Extract VaDetector integration with callback patterns |
| - [x] **AudioStreamService** | `utils/listener.py` | `src/infrastructure/audio/audio_stream_service.py` | 200-400 | Extract audio streaming with non-blocking patterns |
| - [x] **AudioRecordingService** | `utils/listener.py` | `src/infrastructure/audio/audio_recording_service.py` | 300-400 | Extract audio recording with progress tracking |
| - [x] **AudioPlaybackService** | `utils/listener.py` | `src/infrastructure/audio/audio_playback_service.py` | 250-350 | Extract audio playback with non-blocking patterns |
| - [x] **AudioValidationService** | `utils/listener.py` | `src/infrastructure/audio/audio_validation_service.py` | 150-250 | Extract audio validation with comprehensive rules |
| - [x] **PyAudioService** | `utils/listener.py` | `src/infrastructure/audio/pyaudio_service.py` | 200-400 | Extract PyAudio implementation with non-blocking patterns |
| - [x] **KeyboardService** | `utils/listener.py` | `src/infrastructure/audio/keyboard_service.py` | 100-150 | Extract keyboard hook implementation with event-driven patterns |
| - [x] **AudioFileRepository** | `utils/listener.py` | `src/infrastructure/audio/audio_file_repository.py` | 300-400 | Extract file persistence with progress tracking |
| - [x] **ListenerService** | `utils/listener.py` + `src/core/utils/listener.py` | `src/infrastructure/audio/consolidated_listener_service.py` | 1-575 + 1-68 | Merge full listener implementation (575 lines) with placeholder AudioToText class (68 lines), consolidating key handling, recording state, and audio processing interface |
| - [x] **AudioBufferService** | `utils/listener.py` | `src/infrastructure/audio/audio_buffer_service.py` | 100-200 | Extract audio buffering operations with circular buffer management |
| - [x] **AudioDeviceService** | `utils/listener.py` | `src/infrastructure/audio/audio_device_service.py` | 50-150 | Extract PyAudio device enumeration and selection with validation |
| - [x] **VADModelService** | `utils/listener.py` | `src/infrastructure/audio/vad_model_service.py` | 150-200 | Extract VAD model loading and management operations |
| - [x] **AudioDataConversionService** | `utils/listener.py` | `src/infrastructure/audio/audio_data_conversion_service.py` | 200-250 | Extract audio format conversion between different data types |
| - [x] **VADCalibrationService** | `utils/listener.py` | `src/infrastructure/audio/vad_calibration_service.py` | 100-150 | Extract VAD threshold calibration and noise level analysis |
| - [x] **AudioServiceFactory** | **NEW** | `src/infrastructure/audio/service_factory.py` | **NEW** | Create factory for audio services with proper dependency injection following Factory pattern |

#### 3.2 Transcription Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **ONNXTranscriptionService** | `utils/transcribe.py` + `src/core/utils/transcribe.py` | `src/infrastructure/transcription/onnx_transcription_service.py` | 500-700 + 1-102 | Merge full ONNX Whisper implementation (978 lines) with placeholder WhisperONNXTranscriber class (102 lines), consolidating transcription interface, signal integration, and error handling patterns |
| - [x] **ModelDownloadService** | `utils/transcribe.py` | `src/infrastructure/transcription/model_download_service.py` | 800-900 | Extract download management with progress tracking |
| - [x] **ModelCacheService** | `utils/transcribe.py` | `src/infrastructure/transcription/model_cache_service.py` | 450-550 | Extract cache organization with progress callbacks |
| - [x] **TranscriptionFileRepository** | `utils/transcribe.py` | `src/infrastructure/transcription/transcription_file_repository.py` | 1000-1100 | Extract transcription persistence with progress tracking |

#### 3.3 Settings Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **SettingsRepository** | `src/ui/settings_dialog.py` | `src/infrastructure/settings/settings_repository.py` | 200-400 | Extract settings persistence with progress tracking |
| - [x] **SettingsFileRepository** | `src/ui/settings_dialog.py` | `src/infrastructure/settings/settings_file_repository.py` | 300-500 | Extract file-based settings with progress callbacks |
| - [x] **SettingsValidator** | `src/ui/settings_dialog.py` | `src/infrastructure/settings/settings_validator.py` | 150-250 | Extract settings validation with progress tracking |
| - [x] **SettingsMigrationService** | `src/ui/settings_dialog.py` | `src/infrastructure/settings/settings_migration_service.py` | 100-200 | Implement settings migration with progress callbacks |
| - [x] **JSONSettingsRepository** | `src/ui/settings_dialog.py` | `src/infrastructure/settings/json_settings_repository.py` | 100-200, 300-400 | Extract JSON settings storage |
| - [x] **FileSystemService** | `src/ui/settings_dialog.py` | `src/infrastructure/settings/file_system_service.py` | 700-800 | Extract file system operations |
| - [x] **Extract LLM Worker** | `src/workers/worker_classes.py` | `src/infrastructure/llm/llm_worker_service.py` | 213-290 | Extract LLM worker implementation with non-blocking patterns |

#### 3.4 Worker Infrastructure Services Refactoring (PyQt Integration)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **PyQtAudioAdapter** | `src/workers/worker_classes.py` | `src/infrastructure/audio/pyqt_audio_adapter.py` | 17-73 | Extract PyQt signal adapter for AudioToText with property delegation |
| - [x] **VadWorkerService** | `src/workers/worker_classes.py` | `src/infrastructure/audio/vad_worker_service.py` | 74-96 | Extract VAD worker with PyQt threading and lifecycle management |
| - [x] **ModelWorkerService** | `src/workers/worker_classes.py` | `src/infrastructure/transcription/model_worker_service.py` | 97-165 | Extract transcription model worker with file processing and progress tracking |
| - [x] **ListenerWorkerService** | `src/workers/worker_classes.py` | `src/infrastructure/audio/listener_worker_service.py` | 167-212 | Extract audio listener worker with recording management and cleanup |
| - [x] **LLMPyQtWorkerService** | `src/workers/worker_classes.py` | `src/infrastructure/llm/llm_pyqt_worker_service.py` | 213-290 | Extract LLM worker with model loading and inference capabilities |
| - [x] **WorkerImportsConfiguration** | `src/workers/worker_classes.py` | `src/infrastructure/worker/worker_imports_configuration.py` | 1-15 | Extract common worker imports and logging configuration |
| - [x] **Missing Gemma Inference Module** | **MISSING** | `src/infrastructure/llm/gemma_inference_service.py` | **NEW** | Create missing gemma_inference module referenced in LLMWorker (lines 232, 278) |

#### 3.5 Media Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **FileValidationService** | `src/ui/window_methods.py` | `src/infrastructure/media/file_validation_service.py` | 712-724 | Extract media file type validation with progress callbacks |
| - [x] **VideoConversionService** | `src/ui/window_methods.py` | `src/infrastructure/media/media_conversion_service.py` | 778-811 | Extract FFmpeg video conversion with progress tracking |
| - [x] **MediaScannerService** | `src/ui/window_methods.py` | `src/infrastructure/media/folder_scanning_service.py` | 726-736 | Extract folder scanning for media files with progress callbacks |
| - [x] **BatchProcessorService** | `src/ui/window_methods.py` | `src/infrastructure/media/batch_processor_service.py` | 813-929 | Extract batch file processing queue management with progress tracking |
| - [x] **ProgressTrackingService** | `src/ui/window_methods.py`, `src/ui/settings_dialog.py` | `src/infrastructure/progress_management/progress_tracking_service.py` | 931-944, 1187-1208 | Extract consolidated progress calculation and tracking with callbacks, progress tracking with percentage calculation and callbacks |

#### 3.6 System Infrastructure Services Extended (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **TrayIconService** | `src/ui/window_methods.py` | `src/infrastructure/system/tray_icon_service.py` | 472-499 | Extract system tray management with window activation |
| - [x] **Comprehensive Event System** | **ALREADY EXISTS** | `src/ui/core/events.py` | 76-382 | **mirror existing** - Enterprise UIEventSystem with thread-safe event publishing, subscription, priority handling, async processing, filtering, history, metrics, CQRS, mediator pattern, and performance monitoring |

#### 3.7 UI Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **Animation Strategies** | `src/ui/core/patterns.py` | `src_refactored/infrastructure/presentation/qt/animation_strategies.py` | 331-419 | Comprehensive animation strategies (FadeInStrategy, SlideInStrategy, FadeOutStrategy, SlideOutStrategy, AnimationContext) with PyQt6 integration for opacity effects and transitions (refactored) |
| - [x] **MessageDisplayService** | `src/ui/window_methods.py` | `src/infrastructure/ui/message_display_service.py` | 341-470 | Extract message display with effects and progress callbacks |
| - [x] **DragDropService** | `src/ui/window_methods.py`, `src/ui/settings_dialog.py` | `src/infrastructure/ui/drag_drop_service.py` | 624-710, 806-857 | Extract consolidated drag and drop handling with file validation, progress tracking, and file type validation (consolidated from multiple sources) |
| - [x] **FileDialogService** | `src/ui/window_methods.py`, `src/ui/settings_dialog.py` | `src/infrastructure/ui/file_dialog_service.py` | 501-547, 1239-1263 | Extract consolidated file dialog configuration with media file selection, file browsing, validation, and progress callbacks (consolidated from multiple sources) |
| - [x] **ProgressUIService** | `src/ui/window_methods.py` | `src/infrastructure/ui/progress_ui_service.py` | 1291-1331 | Extract progress bar UI management with complex reparenting |
| - [x] **StateManagementService** | `src/ui/window_methods.py` | `src/infrastructure/ui/state_management_service.py` | 1333-1345 | Extract UI state coordination with download state management |

#### 3.8 Audio Visualization Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **AudioProcessorService** | `src/ui/voice_visualizer.py` | `src/infrastructure/audio_visualization/audio_processor_service.py` | 10-153 | Extract PyAudio-based audio processing with threading and progress callbacks |
| - [x] **VisualizationControllerService** | `src/ui/voice_visualizer.py` | `src/infrastructure/audio_visualization/visualization_controller_service.py` | 155-193 | Extract visualization lifecycle management with progress tracking |
| - [x] **AudioStreamService** | `src/ui/voice_visualizer.py` | `src/infrastructure/audio_visualization/audio_stream_service.py` | 26-62 | Extract PyAudio stream management with fallback handling and progress callbacks |
| - [x] **BufferManagementService** | `src/ui/voice_visualizer.py` | `src/infrastructure/audio_visualization/buffer_management_service.py` | 114-119, 20-25 | Extract rolling buffer management with progress tracking |
| - [x] **AudioNormalizationService** | `src/ui/voice_visualizer.py` | `src/infrastructure/audio_visualization/audio_normalization_service.py` | 131-153 | Extract speech normalization algorithms with progress callbacks |
| - [x] **ResourceCleanupService** | `src/ui/voice_visualizer.py` | `src/infrastructure/audio_visualization/resource_cleanup_service.py` | 70-86 | Extract audio resource cleanup management with progress tracking |

#### 3.9 Settings Management Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **SettingsRepositoryService** | `src/ui/settings_dialog.py` | `src/infrastructure/settings/settings_repository_service.py` | 1265-1318 | Extract settings persistence with JSON storage and progress tracking |
| - [x] **SettingsValidationService** | `src/ui/settings_dialog.py` | `src/infrastructure/settings/settings_validation_service.py` | 186, 1298-1302 | Extract settings validation with business rules and progress callbacks |
| - [x] **HotkeyRecordingService** | `src/ui/settings_dialog.py` | `src/infrastructure/settings/hotkey_recording_service.py` | 867-969 | Extract key recording and combination validation with progress tracking |


| - [x] **SettingsMigrationService** | `src/ui/settings_dialog.py` | `src/infrastructure/settings/settings_migration_service.py` | 1265-1294 | Extract settings migration and upgrade logic |

#### 3.10 UI Widget Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **ToggleWidgetService** | `src/ui/settings_dialog.py` | `src/infrastructure/ui_widgets/toggle_widget_service.py` | 27-112 | Extract toggle widget implementation with styling and event handling |
| - [x] **WidgetStylingService** | `src/ui/settings_dialog.py` | `src/infrastructure/ui_widgets/widget_styling_service.py` | 36-57, 73-105 | Extract widget styling and CSS management |
| - [x] **WidgetEventService** | `src/ui/settings_dialog.py` | `src/infrastructure/ui_widgets/widget_event_service.py` | 59-66, 107-112 | Extract widget event handling with mouse and paint events |

#### 3.11 Progress Management Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **ProgressBarReparentingService** | `src/ui/settings_dialog.py` | `src/infrastructure/progress_management/progress_bar_reparenting_service.py` | 1571-1613, 1362-1409, 1420-1464 | Extract complex progress bar reparenting and lifecycle management |

| - [x] **UIStateManagementService** | `src/ui/settings_dialog.py` | `src/infrastructure/progress_management/ui_state_management_service.py` | 1320-1361 | Extract UI element enable/disable with visual feedback and opacity effects |
| - [x] **TimerManagementService** | `src/ui/settings_dialog.py` | `src/infrastructure/progress_management/timer_management_service.py` | 146-148, 1407-1408 | Extract debounce timer management and delayed operations |

#### 3.12 Main Window Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **WindowConfigurationService** | `src/ui/main_window.py` | `src/infrastructure/main_window/window_configuration_service.py` | 33-66, 324-333 | Extract window configuration with palette, icon, and size management |
| - [x] **UILayoutService** | `src/ui/main_window.py` | `src/infrastructure/main_window/ui_layout_service.py` | 67-261 | Extract massive UI layout management with widget creation and positioning |
| - [x] **VisualizationIntegrationService** | `src/ui/main_window.py` | `src/infrastructure/main_window/visualization_integration_service.py` | 192-210 | Extract PyQtGraph visualization integration with waveform plotting |
| - [x] **OpacityEffectsService** | `src/ui/main_window.py` | `src/infrastructure/main_window/opacity_effects_service.py` | 207-240 | Extract complex opacity effects management for recording states |
| - [x] **UITextManagementService** | `src/ui/main_window.py` | `src/infrastructure/main_window/ui_text_management_service.py` | 264-276 | Extract dynamic UI text updates with translation support |
| - [x] **WidgetLayeringService** | `src/ui/main_window.py` | `src/infrastructure/main_window/widget_layering_service.py` | 249-259 | Extract widget z-order management and raising sequences |

#### 3.13 System Integration Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **SystemTrayService** | `src/ui/main_window.py` | `src/infrastructure/system_integration/system_tray_service.py` | 354-361, 367-371 | Extract system tray integration with menu actions and icon management |
| - [x] **WorkerThreadManagementService** | `src/ui/main_window.py` | `src/infrastructure/system_integration/worker_thread_management_service.py` | 341-351 | Extract worker thread coordination and reference management |
| - [x] **EventFilterService** | `src/ui/main_window.py` | `src/infrastructure/system_integration/event_filter_service.py` | 378-381 | Extract event filter installation and system event handling |
| - [x] **DragDropIntegrationService** | `src/ui/main_window.py` | `src/infrastructure/system_integration/drag_drop_integration_service.py` | 286 | Extract drag and drop enablement with file handling |
| - [x] **GeometryManagementService** | `src/ui/main_window.py` | `src/infrastructure/system_integration/geometry_management_service.py` | 373-374 | Extract geometry management with central widget sizing |
| - [x] **MethodDelegationService** | `src/ui/main_window.py` | `src/infrastructure/system_integration/method_delegation_service.py` | 384-423 | Extract method delegation pattern (architectural refactoring required) |

#### 3.14 System Infrastructure Services (Non-blocking Patterns)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **EnvironmentService** | `src/main.py` | `src/infrastructure/system/environment_service.py` | 1-22, 82-87 | Extract environment variable setup, warning suppression, logging configuration |
| - [x] **PlatformService** | `src/main.py` | `src/infrastructure/system/platform_service.py` | 24-31 | Extract platform-specific imports and feature detection |
| - [x] **SubprocessService** | `src/main.py` | `src/infrastructure/system/subprocess_service.py` | 34-40, 70, 90 | Extract subprocess patching and console suppression |
| - [x] **SingleInstanceService** | `src/main.py` | `src/infrastructure/system/single_instance_service.py` | 45-61, 98 | Extract socket-based single instance detection |
| - [x] **WindowActivationService** | `src/main.py` | `src/infrastructure/system/window_activation_service.py` | 100-130 | Extract window enumeration and activation logic |
| - [x] **ApplicationLifecycleService** | `src/main.py` | `src/infrastructure/system/application_lifecycle_service.py` | 63-67, 132-143 | Extract cleanup management and application lifecycle |
| - [x] **LoggingService** | `src/main.py` + `logger/logger.py` | `src/infrastructure/system/logging_service.py` | 12, 79-80 + **mirror existing** | Create service wrapper around existing logger/logger.py setup_logger function for dependency injection ✅ |
| - [x] **ApplicationBootstrap** | `src/main.py` | `src/infrastructure/presentation/qt/application_bootstrap.py` | 93-96 | Extract QApplication setup and configuration ✓ |
| - [x] **ErrorHandlingService** | `src/main.py` | `src/infrastructure/presentation/system/error_handling_service.py` | 126-130, 140-143 | Extract application-level error handling and user notifications ✓ |

### Consolidation Summary

**Services Consolidated During Implementation:**

1. **ProgressTrackingService** - Consolidated three implementations:
   - `src/infrastructure/media/progress_tracking_service.py` (deleted)
   - `src/infrastructure/audio/progress_tracking_service.py` (deleted)
   - `src/infrastructure/progress_management/progress_tracking_service.py` (consolidated implementation)

2. **AudioNormalizationService** - Consolidated two implementations:
   - `src/infrastructure/audio_visualization/audio_normalization_service.py` (deleted)
   - `src/infrastructure/audio/audio_normalization_service.py` (consolidated implementation with advanced features)

**Note:** All duplicate services have been consolidated to eliminate redundancy while preserving all functionality. The consolidated services include comprehensive features from all original implementations.

### Phase 4: Presentation Layer Refactoring (Week 7-8)

#### 4.1 Main Window Refactoring

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **MainWindow UI** | `src/ui/main_window.py` | `src/infrastructure/presentation/qt/main_window.py` | 278-423 | Extract main window coordinator (refactored to use new services) |
| - [x] **UI Setup Component** | `src/ui/main_window.py` | `src/infrastructure/presentation/qt/ui_setup_component.py` | 28-277 | Extract UI setup component (refactored to use new layout and configuration services) |
| - [x] **Window Configuration Component** | `src/ui/main_window.py` | `src/infrastructure/presentation/qt/window_config_component.py` | 33-66 | Extract window configuration UI section (refactored to use new configuration services) |
| - [x] **Widget Layout Component** | `src/ui/main_window.py` | `src/infrastructure/presentation/qt/widget_layout_component.py` | 67-261 | Extract widget layout and styling UI section (refactored to use new layout services) |
| - [x] **Visualization Component** | `src/ui/main_window.py` | `src/infrastructure/presentation/qt/visualization_component.py` | 192-210 | Extract voice visualizer UI integration (refactored to use new visualization services) |
| - [x] **Translation Component** | `src/ui/main_window.py` | `src/infrastructure/presentation/qt/translation_component.py` | 264-276 | Extract UI text and translation handling (refactored to use new text services) |
| - [x] **Worker Integration** | `src/ui/window_methods.py` | `src/infrastructure/presentation/qt/worker_integration.py` | 800-1000 | Extract worker coordination |
| - [x] **Resource Management** | `src/ui/window_methods.py` | `src/infrastructure/presentation/qt/resource_management_component.py` | 50-100 | Extract resource handling |

#### 4.2 Settings Dialog Refactoring

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **SettingsDialog UI** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/settings_dialog.py` | 114-1613 | Extract settings dialog UI coordinator (refactored to use new services) |
| - [x] **ToggleSwitch Widget UI** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/toggle_switch_widget.py` | 27-112 | Extract custom toggle widget UI (refactored to use new widget services) |
| - [x] **Model Configuration UI** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/model_config_widget.py` | 318-439 | Extract model configuration section UI (refactored to use new settings services) |
| - [x] **LLM Configuration UI** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/llm_config_widget.py` | 441-625 | Extract LLM configuration section UI (refactored to use new settings services) |
| - [x] **Sound Configuration UI** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/sound_config_widget.py` | 627-732 | Extract sound configuration section UI (refactored to use new settings services) |
| - [x] **Hotkey Configuration UI** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/hotkey_config_widget.py` | 243-310 | Extract hotkey configuration section UI (refactored to use new settings services) |
| - [x] **Progress Management UI** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/progress_management_widget.py` | 430-438, 1571-1613 | Extract progress bar and download UI coordination (refactored to use new progress services) |

#### 4.3 Voice Visualizer Refactoring

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **VoiceVisualizer UI** | `src/ui/voice_visualizer.py` | `src/infrastructure/presentation/qt/voice_visualizer.py` | 155-193 | Extract visualization UI controller (refactored to use new services) |
| - [x] **AudioProcessor Integration** | `src/ui/voice_visualizer.py` | `src/infrastructure/audio/audio_processor.py` | 10-153 | Extract PyQt audio processor integration (refactored to use new audio visualization services) |

#### 4.4 Settings Dialog Detailed Breakdown & Integration

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **Settings Dialog Coordinator** | `src/ui/settings_dialog.py` | `src_refactored/infrastructure/presentation/qt/settings_dialog_coordinator.py` | 114-204, 734-804 | Extract main dialog coordination and event handling integration (refactored) |
| - [x] **Toggle Switch Widget** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/toggle_switch_widget.py` | 27-112 | Extract custom toggle widget with PyQt integration (refactored to use widget services) |
| - [x] **Recording Key Section** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/hotkey_config_widget.py` | 243-310 | Extract hotkey configuration UI section (refactored to use settings services) |
| - [x] **Model Configuration Section** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/model_config_widget.py` | 312-439 | Extract model selection UI section (refactored to use settings services) |
| - [x] **LLM Configuration Section** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/llm_config_widget.py` | 441-625 | Extract LLM settings UI section (refactored to use settings services) |
| - [x] **Sound Configuration Section** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/sound_config_widget.py` | 627-732 | Extract sound settings UI section with drag/drop (refactored to use settings services) |
| - [x] **Progress Management Widget** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/progress_management_widget.py` | 430-438, 1571-1613 | Extract progress UI coordination and reparenting (refactored to use progress services) |
| - [x] **Event Filter Integration** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/settings_event_filter.py` | 806-865 | Extract event filtering and routing (refactored to use event services) |
| - [x] **Dialog Lifecycle Management** | `src/ui/settings_dialog.py` | `src/infrastructure/presentation/qt/settings_lifecycle.py` | 1410-1498 | Extract dialog show/hide/close event handling (refactored to use lifecycle services) |

#### 4.5 Worker Refactor & UI Core Integration

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **Worker Integration Orchestration** | `src/workers/worker_classes.py` | `src_refactored/infrastructure/presentation/qt/worker_integration_orchestrator.py` | 17-290 | Create PyQt worker orchestration service adapting to new DI container |
| - [x] **UI Core Abstractions** | `src/ui/core/abstractions.py` | `src/infrastructure/presentation/qt/ui_core_abstractions.py` | 1-462 | Preserve existing abstractions |
| - [x] **UI Core Patterns** | `src/ui/core/patterns.py` | `src_refactored/infrastructure/presentation/qt/ui_core_patterns.py` | 1-632 | Preserve existing patterns |
| - [x] **Utilize Enterprise IoC Container** | **PARALLEL IMPLEMENTATION** | `src_refactored/ui/core/container.py` | 1-406 | **parallel refactored** - Enterprise-level IoC container with thread-safe service resolution, circular dependency detection, automatic constructor injection, service decorators, and fluent builder interface for hexagonal architecture |

### Phase 5: Application Integration & Migration (Week 8-10)

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **ProgressCallback** | `src/ui/main_window.py` | `src_refactored/infrastructure/common/progress_callback.py` | 500-600 | Create progress callback interface for non-blocking operations |
| - [x] **TaskManager** | `src/ui/main_window.py` | `src_refactored/infrastructure/common/task_manager.py` | 600-700 | Implement task management for non-blocking operations |
| - [x] **EventBus** | `src/ui/main_window.py` | `src_refactored/infrastructure/common/event_bus.py` | 400-500 | Create event bus for decoupled communication |
| - [x] **RepositoryBase** | `src/ui/main_window.py` | `src_refactored/infrastructure/common/repository_base.py` | 200-300 | Create base repository pattern implementation |
| - [x] **UnitOfWork** | `src/ui/main_window.py` | `src_refactored/infrastructure/common/unit_of_work.py` | 300-400 | Implement unit of work pattern for transactions |

#### 5.1 Application Entry Point Refactoring

| Task | Source File | Target File | Lines to Extract | Actions |
|------|-------------|-------------|------------------|---------|
| - [x] **Application Orchestrator** | `src/main.py` | `src_refactored/application/application_orchestrator.py` | 77-96, 132-139 | Extract main application workflow orchestration |
| - [x] **Utilize Enterprise IoC Container** | **ALREADY EXISTS** | `src/ui/core/container.py` | 1-406 | **mirror existing** - Enterprise-level IoC container with thread-safe service resolution, circular dependency detection, automatic constructor injection, service decorators, and fluent builder interface |
| - [x] **Application Configuration** | `src/main.py` | `src_refactored/application/application_config.py` | 1-22, 82-87 | Extract application-level configuration management |
| - [x] **Main Entry Point** | `src/main.py` | `src/main.py` | 145-146 | Refactor to use application orchestrator with DI container |
| - [x] **Application Startup Use Case** | `src/main.py` | `src_refactored/application/use_cases/startup_application_use_case.py` | 77-143 | Create startup use case with proper error handling |
| - [x] **Application Shutdown Use Case** | `src/main.py` | `src_refactored/application/use_cases/shutdown_application_use_case.py` | 63-67 | Create graceful shutdown use case |

#### 5.2 Service Registration Using Existing UIContainer

| Task | File | Lines | Actions |
|------|------|-------|---------|
| - [x] **Existing Enterprise IoC Container** | `src/ui/core/container.py` | **CREATE PARALLEL REFACTORED IMPLEMENTATION** | **CRITICAL**: Existing enterprise-level IoC container with thread-safe resolution, circular dependency detection, automatic constructor injection, service decorators (@injectable, @service_interface), and fluent builder interface |
| - [x] **Existing Value Objects** | `src/ui/domain/value_objects.py` | **CREATE PARALLEL REFACTORED IMPLEMENTATION** | **CRITICAL**: Existing comprehensive value objects must be utilized throughout refactoring (WindowDimensions, StyleConfiguration, KeyCombination, AudioConfiguration, ModelType, Quantization, ModelConfiguration, LLMConfiguration, OutputConfiguration) |
| - [x] **Existing Architectural Patterns** | `src/ui/core/abstractions.py` | **CREATE PARALLEL REFACTORED IMPLEMENTATION** | **CRITICAL**: Existing comprehensive architectural foundation must be utilized throughout refactoring (Result, UIEvent, ICommand, IQuery, IObserver, IMediator, IServiceProvider, UIAggregateRoot, UIEntity, IUIComponent, MVP patterns, etc.) |
| - [x] **Existing Design Patterns Library** | `src/ui/core/patterns.py` | **CREATE PARALLEL REFACTORED IMPLEMENTATION** | **CRITICAL**: Existing comprehensive design patterns library must be utilized throughout refactoring (Factory, Builder, Strategy, Decorator, Command patterns with PyQt6 integration, Animation strategies, Widget creation, Component enhancement, Undo/redo functionality) |
| - [x] **Existing Enterprise Event System** | `src_refactored/ui/core/events.py` | **CREATE PARALLEL REFACTORED IMPLEMENTATION** | **CRITICAL**: Existing comprehensive enterprise event system must be utilized throughout refactoring (UIEventSystem with mediator pattern, CQRS, priority-based processing, async handling, event history, performance monitoring, predefined UI events, event decorators) |
| - [x] **Container Configuration** | `src_refactored/infrastructure/container/container_configuration.py` | 1-200 | Configure existing UIContainer using UIContainerBuilder with all new services (domain, application, infrastructure) using register_singleton, register_transient, register_scoped methods |
| - [x] **Service Locator** | `src_refactored/infrastructure/container/service_locator.py` | 1-300 | Service locator providing simplified access to container services with error handling and caching |
| - [x] **Service Registration** | `src_refactored/infrastructure/container/service_registration.py` | 1-400 | Automatic service registration using decorators and reflection with UIContainer integration |
| - [x] **Domain Service Registration** | `src_refactored/infrastructure/container/container_configuration.py` | 50-100 | Register domain services using UIContainer.register_singleton for aggregates and entities |
| - [x] **Application Use Case Registration** | `src_refactored/infrastructure/container/container_configuration.py` | 100-150 | Register application use cases using UIContainer.register_transient for stateless operations |
| - [x] **Infrastructure Service Registration** | `src_refactored/infrastructure/container/container_configuration.py` | 150-200 | Register infrastructure services using UIContainer.register_singleton for external system integrations |
| - [x] **Worker Service Registration** | `src_refactored/infrastructure/container/container_configuration.py` | 200-250 | Register PyQt worker services, consolidated listener service, and consolidated transcription service using UIContainer.register_transient for thread-based operations |
| - [x] **UI Pattern Registration** | `src_refactored/infrastructure/container/container_configuration.py` | 250-300 | Register existing UI patterns (Factory, Builder, Strategy, Decorator, Command) from patterns.py using UIContainer |
| - [x] **Presentation Service Registration** | `src_refactored/infrastructure/container/container_configuration.py` | 300-400 | Register presentation layer services using UIContainer with proper lifetime management |

### Phase 6: Testing & Validation (Week 11-12)

#### 6.1 Unit Tests

| Task | Test File | Source Lines | Test Coverage |
|------|-----------|--------------|---------------|
| - [ ] **Domain Entity Tests** | `tests/unit/domain/test_audio_session.py` | 1-50 | Test audio session business rules |
| - [ ] **Value Object Tests** | `tests/unit/domain/test_value_objects.py` | 1-100 | Test all value object validation |
| - [ ] **Use Case Tests** | `tests/unit/application/test_use_cases.py` | 1-200 | Test all use case scenarios |
| - [ ] **Worker Service Tests** | `tests/unit/infrastructure/test_worker_services.py` | 1-150 | Test all PyQt worker services with mocking |
| - [ ] **Media Domain Tests** | `tests/unit/domain/test_media_entities.py` | 1-100 | Test media file, conversion job, batch processing entities |
| - [ ] **UI Coordination Tests** | `tests/unit/domain/test_ui_coordination.py` | 1-100 | Test UI session, animation state entities and value objects |
| - [ ] **Configuration Use Cases Tests** | `tests/unit/application/test_configuration_use_cases.py` | 1-80 | Test configuration loading and update use cases |
| - [ ] **Worker Management Tests** | `tests/unit/application/test_worker_management.py` | 1-100 | Test worker lifecycle management use cases |
| - [ ] **Media Processing Tests** | `tests/unit/application/test_media_processing.py` | 1-150 | Test media processing, conversion, transcription use cases |
| - [ ] **Audio Visualization Domain Tests** | `tests/unit/domain/test_audio_visualization.py` | 1-100 | Test audio visualization, buffer, normalization entities and value objects |
| - [ ] **Audio Visualization Use Cases Tests** | `tests/unit/application/test_audio_visualization.py` | 1-100 | Test audio visualization startup, shutdown, processing use cases |
| - [ ] **Audio Visualization Services Tests** | `tests/unit/infrastructure/test_audio_visualization_services.py` | 1-150 | Test audio processor, stream, buffer, normalization services with mocking |
| - [ ] **Settings Management Domain Tests** | `tests/unit/domain/test_settings_entities.py` | 1-120 | Test user preferences, settings configuration, hotkey binding entities and value objects |
| - [ ] **Settings Management Use Cases Tests** | `tests/unit/application/test_settings_use_cases.py` | 1-150 | Test load, save, update, reset, validate, apply settings use cases |
| - [ ] **Settings Management Services Tests** | `tests/unit/infrastructure/test_settings_services.py` | 1-180 | Test settings repository, validation, hotkey recording, file dialog, drag drop services with mocking |
| - [ ] **UI Widget Domain Tests** | `tests/unit/domain/test_ui_widgets.py` | 1-100 | Test toggle widget, widget state entities and value objects |
| - [ ] **UI Widget Use Cases Tests** | `tests/unit/application/test_ui_widget_use_cases.py` | 1-100 | Test create, update, handle widget use cases |
| - [ ] **UI Widget Services Tests** | `tests/unit/infrastructure/test_ui_widget_services.py` | 1-120 | Test toggle widget, styling, event services with mocking |
| - [ ] **Progress Management Domain Tests** | `tests/unit/domain/test_progress_management.py` | 1-120 | Test progress session, progress bar lifecycle, download progress entities and value objects |
| - [ ] **Progress Management Use Cases Tests** | `tests/unit/application/test_progress_management_use_cases.py` | 1-120 | Test start, update, complete, reparent progress use cases |
| - [ ] **Progress Management Services Tests** | `tests/unit/infrastructure/test_progress_management_services.py` | 1-150 | Test progress bar reparenting, tracking, UI state, timer services with mocking |
| - [ ] **Main Window Domain Tests** | `tests/unit/domain/test_main_window_entities.py` | 1-120 | Test main window, window configuration, UI layout, visualization integration entities and value objects |
| - [ ] **Main Window Use Cases Tests** | `tests/unit/application/test_main_window_use_cases.py` | 1-150 | Test initialize, configure, setup layout, integrate visualization, manage effects, update text use cases |
| - [ ] **Main Window Services Tests** | `tests/unit/infrastructure/test_main_window_services.py` | 1-180 | Test window configuration, UI layout, visualization integration, opacity effects, text management, layering services with mocking |
| - [ ] **System Integration Domain Tests** | `tests/unit/domain/test_system_integration.py` | 1-100 | Test system tray integration, worker thread coordination, event system integration entities and value objects |
| - [ ] **System Integration Use Cases Tests** | `tests/unit/application/test_system_integration_use_cases.py` | 1-120 | Test initialize tray, setup threads, install filter, enable drag drop, manage geometry use cases |
| - [ ] **System Integration Services Tests** | `tests/unit/infrastructure/test_system_integration_services.py` | 1-150 | Test system tray, worker thread management, event filter, drag drop, geometry, delegation services with mocking |

#### 6.2 Integration Tests

| Task | Test File | Source Lines | Test Coverage |
|------|-----------|--------------|---------------|
| - [ ] **Service Integration** | `tests/integration/test_services.py` | 1-150 | Test service integration |
| - [ ] **Repository Integration** | `tests/integration/test_repositories.py` | 1-100 | Test persistence integration |
| - [ ] **Worker Integration** | `tests/integration/test_workers.py` | 1-150 | Test PyQt worker integration with threading and signals |
| - [ ] **Worker Adapter Integration** | `tests/integration/test_worker_adapters.py` | 1-100 | Test PyQt adapter patterns and signal delegation |
| - [ ] **Media Service Integration** | `tests/integration/test_media_services.py` | 1-150 | Test media processing pipeline integration with FFmpeg |
| - [ ] **Animation Service Integration** | `tests/integration/test_animation_services.py` | 1-100 | Test UI animation coordination with PyQt |
| - [ ] **Configuration Integration** | `tests/integration/test_configuration.py` | 1-100 | Test configuration loading and persistence integration |
| - [ ] **Audio Visualization Integration** | `tests/integration/test_audio_visualization.py` | 1-150 | Test audio visualization pipeline integration with PyAudio and threading |
| - [ ] **Settings Management Integration** | `tests/integration/test_settings_management.py` | 1-150 | Test settings pipeline integration with JSON persistence, validation, and UI updates |
| - [ ] **UI Widget Integration** | `tests/integration/test_ui_widgets.py` | 1-100 | Test widget integration with PyQt styling, events, and state management |
| - [ ] **Progress Management Integration** | `tests/integration/test_progress_management.py` | 1-150 | Test progress bar lifecycle integration with reparenting, tracking, and UI coordination |
| - [ ] **Main Window Integration** | `tests/integration/test_main_window.py` | 1-150 | Test main window pipeline integration with configuration, layout, visualization, and system coordination |
| - [ ] **System Integration** | `tests/integration/test_system_integration.py` | 1-150 | Test system integration pipeline with tray, workers, events, and platform integration |

#### 6.3 E2E Tests

| Task | Test File | Source Lines | Test Coverage |
|------|-----------|--------------|---------------|
| - [ ] **Recording Flow** | `tests/e2e/test_recording_flow.py` | 1-100 | Test complete recording workflow |
| - [ ] **Transcription Flow** | `tests/e2e/test_transcription_flow.py` | 1-100 | Test complete transcription workflow |
| - [ ] **Settings Flow** | `tests/e2e/test_settings_flow.py` | 1-100 | Test settings management workflow |
| - [ ] **Media Processing Flow** | `tests/e2e/test_media_processing_flow.py` | 1-150 | Test complete media file processing workflow including video conversion |
| - [ ] **Batch Processing Flow** | `tests/e2e/test_batch_processing_flow.py` | 1-150 | Test batch transcription workflow with progress tracking |
| - [ ] **UI Animation Flow** | `tests/e2e/test_ui_animation_flow.py` | 1-100 | Test complete UI animation and state management workflow |
| - [ ] **Audio Visualization Flow** | `tests/e2e/test_audio_visualization_flow.py` | 1-100 | Test complete audio visualization workflow from capture to display |
| - [ ] **Settings Management Flow** | `tests/e2e/test_settings_management_flow.py` | 1-150 | Test complete settings workflow from load to save with validation and UI updates |
| - [ ] **UI Widget Flow** | `tests/e2e/test_ui_widget_flow.py` | 1-100 | Test complete widget workflow from creation to event handling |
| - [ ] **Progress Management Flow** | `tests/e2e/test_progress_management_flow.py` | 1-150 | Test complete progress workflow from start to completion with reparenting and cleanup |
| - [ ] **Main Window Flow** | `tests/e2e/test_main_window_flow.py` | 1-150 | Test complete main window workflow from initialization to configuration and visualization setup |
| - [ ] **System Integration Flow** | `tests/e2e/test_system_integration_flow.py` | 1-150 | Test complete system integration workflow with tray, workers, and event handling |

### Architectural Foundation Utilization Requirements

**CRITICAL**: The existing `src/ui/domain/value_objects.py` file contains comprehensive, well-structured value objects that MUST be utilized throughout the refactoring:

- **WindowDimensions** (lines 14-36): Window size validation with aspect ratio calculation
- **StyleConfiguration** (lines 38-69): Theme, color, font validation with dark/light/auto themes
- **KeyCombination** (lines 71-108): Keyboard shortcut validation with modifier support
- **AudioConfiguration** (lines 110-131): Sample rate, channels, bit depth, buffer validation
- **ModelType** (lines 133-137): Whisper model enumeration (turbo, lite variants)
- **Quantization** (lines 139-142): Quantization level enumeration (Full, Quantized)
- **ModelConfiguration** (lines 144-182): Model config with compatibility and size estimation
- **LLMConfiguration** (lines 184-205): LLM config with prompt and parameter validation
- **OutputConfiguration** (lines 207-221): Output format validation (txt, srt, vtt, json)

**CRITICAL**: The existing `src/ui/core/abstractions.py` file contains comprehensive architectural patterns that MUST be utilized throughout the refactoring:

- **Result Pattern** (lines 33-66): Railway-oriented programming with functional error handling (success/failure, map, bind)
- **UIEvent & UIEventType** (lines 72-95): Domain event base class with timestamp/ID generation and event enumeration
- **ICommand & IQuery** (lines 101-121): CQRS pattern interfaces for command-query responsibility separation
- **IObserver & IObservable** (lines 127-147): Observer pattern interfaces for event notifications
- **IMediator** (lines 153-166): Mediator pattern interface for decoupled communication
- **IServiceProvider** (lines 172-185): Dependency injection interface with singleton and transient registration
- **IUIComponent, IUIState, IUIValidator, IUIFactory** (lines 191-235): UI component architecture interfaces
- **IView & IPresenter** (lines 241-265): MVP (Model-View-Presenter) pattern interfaces
- **IStrategy** (lines 271-276): Strategy pattern interface for behavior variations
- **IUIRepository** (lines 282-295): Repository pattern interface for UI state persistence
- **UIAggregateRoot** (lines 301-331): DDD aggregate root base class with domain events and consistency
- **UIPosition, UISize, UIBounds** (lines 337-371): UI geometry value objects with validation
- **UIEntity** (lines 377-418): DDD entity base class with identity, timestamps, equality, and hash

**CRITICAL**: The existing `src/ui/core/patterns.py` file contains comprehensive design patterns library that MUST be utilized throughout the refactoring:

- **Factory Pattern** (lines 35-209): WidgetType enum, WidgetConfiguration, IWidgetFactory interface, UIWidgetFactory with PyQt6 widget creation
- **Builder Pattern** (lines 214-326): UIComponentBuilder with fluent interface for complex UI component construction and configuration
- **Strategy Pattern** (lines 331-419): AnimationStrategy base class, FadeInStrategy, SlideInStrategy, AnimationContext for behavior variations and PyQt6 animations
- **Decorator Pattern** (lines 424-509): UIComponentDecorator base, TooltipDecorator, ValidationDecorator, LoggingDecorator for extending component functionality
- **Command Pattern** (lines 514-609): UICommand base class, ShowComponentCommand, UICommandInvoker with comprehensive undo/redo support and command history

**CRITICAL**: The existing `src/ui/core/container.py` file contains enterprise-level IoC container that MUST be utilized throughout the refactoring:

- **ServiceLifetime** (lines 24-28): SINGLETON, TRANSIENT, SCOPED lifecycle management with thread-safe operations
- **ServiceDescriptor** (lines 30-44): Service registration metadata with validation and multiple creation strategies
- **UIContainer** (lines 49-300): Thread-safe service resolution with circular dependency detection and automatic constructor injection
- **Service Registration** (lines 69-157): register_singleton, register_transient, register_scoped methods with fluent interface
- **Service Resolution** (lines 159-285): get_service, try_get_service with comprehensive error handling and Result pattern integration
- **Exception Handling** (lines 306-313): Custom exceptions for service resolution diagnostics and error reporting
- **Service Decorators** (lines 319-345): @injectable and @service_interface decorators for automatic service registration
- **UIContainerBuilder** (lines 351-394): Fluent builder interface with auto_register_from_module capability

**CRITICAL**: The existing `src/ui/core/events.py` file contains comprehensive enterprise event system that MUST be utilized throughout the refactoring:

- **EventPriority** (lines 37-42): LOW, NORMAL, HIGH, CRITICAL priority levels for event processing order
- **EventSubscription** (lines 44-52): Observer pattern with priority, filtering, async processing, and subscription lifecycle management
- **ICommandHandler & IQueryHandler** (lines 58-70): CQRS pattern interfaces for command/query separation with Result pattern integration
- **UIEventSystem** (lines 76-382): Thread-safe event publishing, subscription, priority handling, async processing, filtering, event history, performance metrics, and lifecycle management
- **Predefined UI Events** (lines 388-437): WidgetCreatedEvent, StateChangedEvent, UserActionEvent, ValidationFailedEvent, ProgressUpdatedEvent, ErrorOccurredEvent
- **Event Decorators** (lines 443-489): @event_handler, @command_handler, @query_handler for automatic registration and type-safe event binding
- **Mediator Pattern** (lines 258-296): send_command, send_query with comprehensive error handling and Result pattern integration

**Do NOT create duplicate patterns, abstractions, dependency injection infrastructure, or event systems** - all implementations must utilize the existing comprehensive foundation.

### Non-blocking Patterns & Requirements

All blocking operations must be implemented with non-blocking patterns using callbacks, events, and progress tracking:

#### Model Operations

- **Model Loading**: Implement progress callbacks for model loading operations
- **Model Download**: Download progress tracking with cancellation support
- **Model Validation**: Model integrity checks with progress reporting

#### File Operations

- **File I/O**: Implement file operations with progress callbacks
- **File Downloads**: Download progress with cancellation support
- **File Processing**: Large file processing with progress tracking

#### UI Operations

- **Progress Updates**: Real-time progress reporting through callbacks
- **Error Handling**: Error reporting through event system
- **State Management**: UI state updates through event-driven patterns

#### Service Operations

- **Service Initialization**: Service startup with progress callbacks
- **Background Tasks**: Long-running operations with progress tracking
- **Resource Management**: Resource cleanup with progress reporting

## Migration Strategy

### 1. Parallel Development

- [ ] Create new hexagonal structure alongside existing code
- [ ] Maintain existing functionality during migration
- [ ] Gradual feature-by-feature migration

### 2. Adapter Pattern

- [ ] Create adapters for existing PyQt workers
- [ ] Bridge between old and new architectures
- [ ] Maintain backward compatibility during transition

### 3. Feature Flags

- [ ] Use feature flags to control new vs old implementation
- [ ] Gradual rollout of refactored features
- [ ] Easy rollback capability

### 4. Testing Strategy

- [ ] Unit tests for domain layer
- [ ] Integration tests for infrastructure
- [ ] E2E tests for complete workflows
- [ ] Performance regression testing

## Risk Mitigation

### High-Risk Areas

- [ ] **Audio Recording**: Real-time audio capture
- [ ] **Model Management**: Large model downloads and caching
- [ ] **Hotkey Handling**: Global keyboard hooks
- [ ] **Thread Safety**: PyQt worker integration

### Mitigation Strategies

- [ ] **Incremental Migration**: Feature-by-feature approach
- [ ] **Extensive Testing**: Unit, integration, and E2E tests
- [ ] **Rollback Plan**: Maintain original implementation
- [ ] **Performance Monitoring**: Track performance metrics
- [ ] **User Testing**: Beta testing with power users

## Success Criteria

### Technical Metrics

- [ ] 100% of business logic moved to domain layer
- [ ] 0 direct infrastructure dependencies in domain
- [ ] 100% unit test coverage for domain entities
- [ ] 80% integration test coverage for use cases
- [ ] Performance parity with original implementation

### Code Quality Metrics

- [ ] Cyclomatic complexity < 10 for all methods
- [ ] 0 circular dependencies between layers
- [ ] All external dependencies isolated in infrastructure
- [ ] Clean architecture compliance score > 90%

### Functional Metrics

- [ ] All existing features preserved
- [ ] No regression in audio quality
- [ ] No regression in transcription accuracy
- [ ] No regression in startup time
- [ ] No regression in memory usage

## Timeline & Resources

### Phase Timeline

- [ ] **Phase 1**: Foundation & Domain Layer (3 weeks) - Includes missing domain services and events
- [ ] **Phase 2**: Application Layer & Use Cases (3 weeks) - Includes missing use cases and DTOs
- [ ] **Phase 3**: Infrastructure Layer Implementation (3 weeks) - Complete infrastructure missing
- [ ] **Phase 4**: Presentation Layer Refactoring (2 weeks) - UI layer mostly exists
- [ ] **Phase 5**: Application Integration & Migration (2 weeks) - Consolidate entry points
- [ ] **Phase 6**: Testing & Validation (2 weeks) - Comprehensive testing for new components

### Resource Requirements

- [ ] **Senior Developer**: 1 (full-time)
- [ ] **Mid-level Developer**: 1 (part-time for testing)
- [ ] **QA Engineer**: 0.5 (testing and validation)
- [ ] **Total Effort**: 10 developer-weeks

### Dependencies

- [ ] **PyQt6**: UI framework (existing)
- [ ] **ONNX Runtime**: ML inference (existing)
- [ ] **PyAudio**: Audio capture (existing)
- [ ] **NumPy**: Numerical processing (existing)

### Logging Infrastructure Utilization Requirements

**CRITICAL**: The existing `logger/logger.py` file contains a well-structured logging infrastructure that MUST be utilized rather than recreated:

- **setup_logger() Function** - Complete logging configuration with date-based file management
- **Date-Based File Management** - Automatic daily log file rotation with organized directory structure
- **Dual Handler Setup** - File handler for persistent logging + stream handler for console output
- **Level Configuration** - INFO level for file logging, WARNING level for console output
- **Format Configuration** - Standardized timestamp and message formatting
- **Duplicate Prevention** - Handler existence checking to prevent duplicate logger registration
- **Directory Creation** - Automatic log directory creation with date-based structure


This comprehensive refactoring plan transforms WinSTT from a mixed-architecture desktop application into a clean, maintainable hexagonal architecture system. The plan preserves all existing functionality while introducing clear separation of concerns, enhanced testability, and improved maintainability.

The phased approach ensures minimal risk while achieving the architectural goals, with extensive testing and validation at each step. The comprehensive utilization of existing architectural assets (`value_objects.py`, `abstractions.py`, `patterns.py`, `container.py`, `events.py`, `logger.py`) - totaling **2,275 lines of enterprise-level architectural foundation** - ensures a smooth transition while providing sophisticated dependency injection, design patterns, architectural patterns, domain validation, and comprehensive event-driven architecture capabilities. This approach leverages proven, production-ready components rather than rebuilding from scratch, dramatically accelerating development while ensuring enterprise-quality architecture.

The result will be a codebase that is easier to understand, test, and extend, with clear boundaries between business logic, application workflow, and technical infrastructure.
