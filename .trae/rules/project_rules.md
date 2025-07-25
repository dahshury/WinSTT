# WinSTT - Project Rules

> **Comprehensive development guidelines for Domain-Driven Design (DDD) architecture in Desktop Speech-to-Text Applications**

## 📋 Table of Contents

1. [Architecture Overview](#architecture-overview)
1. [Code Organization](#code-organization)
1. [Domain-Driven Design (DDD) Patterns](#domain-driven-design-ddd-patterns)
1. [Application Layer](#application-layer)
1. [Infrastructure Layer](#infrastructure-layer)
1. [Error Handling](#error-handling)
1. [Testing Strategy](#testing-strategy)
1. [Performance & Security](#performance--security)
1. [Development Workflow](#development-workflow)
1. [Quick Reference](#quick-reference)

______________________________________________________________________

## Architecture Overview

### Core Principles

- **Domain-First Design**: Speech transcription business logic drives technical decisions
- **Clean Architecture**: Clear separation of concerns across layers
- **Event-Driven Architecture**: PyQt signals for UI and worker communication
- **Result Pattern**: Explicit error handling without exceptions
- **Worker Pattern**: Background processing for audio transcription
- **Modular Design**: Separation of UI, domain logic, and infrastructure

### Layer Structure

```
winstt/
├── src/
│   ├── domain/                    # Business logic and rules
│   │   ├── common/               # Shared DDD patterns
│   │   ├── entities/             # Domain entities (Transcription, AudioSession, etc.)
│   │   ├── value_objects/        # Value objects (AudioData, TranscriptionResult, etc.)
│   │   ├── services/             # Domain services (TranscriptionService, etc.)
│   │   └── events/               # Domain events
│   ├── application/              # Application layer
│   │   ├── commands/             # Commands (StartRecording, StopRecording, etc.)
│   │   ├── queries/              # Queries (GetTranscriptionHistory, etc.)
│   │   ├── handlers/             # Command/Query handlers
│   │   └── services/             # Application services
│   ├── infrastructure/           # External concerns
│   │   ├── audio/                # Audio capture and processing
│   │   ├── models/               # ML model management (Whisper, VAD)
│   │   ├── storage/              # File system operations
│   │   └── system/               # OS integration (hotkeys, clipboard)
│   ├── ui/                       # Presentation layer
│   │   ├── main_window.py        # Main UI window
│   │   ├── settings_dialog.py    # Settings UI
│   │   ├── components/           # Reusable UI components
│   │   └── voice_visualizer.py   # Audio visualization
│   ├── workers/                  # Background processing
│   │   └── worker_classes.py     # PyQt workers for async operations
│   └── core/
│       └── utils/                # Shared utilities
├── logger/                       # Logging infrastructure
└── main.py                       # Application entry point
```

______________________________________________________________________

## Code Organization

### Import Rules

```python
# ✅ CORRECT - Import grouping
# 1. Standard library
import os
import sys
from datetime import datetime
from typing import List, Optional

# 2. Third-party packages
from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtWidgets import QMainWindow, QApplication
import numpy as np

# 3. Local application imports
from src.domain.entities.transcription import Transcription
from src.application.commands.start_recording import StartRecordingCommand
from logger import setup_logger
```

### Function and Class Rules

- **Function Size**: Maximum 20 lines, single responsibility
- **Early Returns**: Use guard clauses to reduce nesting
- **Nesting Limit**: Maximum 3 levels of indentation
- **Naming**: Descriptive names, avoid abbreviations

```python
# ✅ CORRECT - Early returns and clear structure
def validate_audio_input(audio_data: np.ndarray, sample_rate: int) -> Result[None]:
    if audio_data is None or len(audio_data) == 0:
        return Result.failure("Audio data cannot be empty")

    if sample_rate not in [16000, 22050, 44100, 48000]:
        return Result.failure("Unsupported sample rate")

    if len(audio_data) < sample_rate * 0.5:  # Less than 0.5 seconds
        return Result.failure("Audio too short for transcription")

    return Result.success(None)
```

______________________________________________________________________

## Domain-Driven Design (DDD) Patterns

### Entity Rules

```python
# ✅ CORRECT - Entity implementation
class AudioSession(Entity[str]):
    def __init__(self, session_id: str, audio_data: AudioData, model_config: ModelConfig):
        super().__init__(session_id)
        self._audio_data = audio_data
        self._model_config = model_config
        self._status = TranscriptionStatus.PENDING
        self._transcription_result = None
        self.validate()

    def start_transcription(self) -> Result[None]:
        if self._status == TranscriptionStatus.IN_PROGRESS:
            return Result.failure("Transcription already in progress")

        self._status = TranscriptionStatus.IN_PROGRESS
        self._started_at = datetime.utcnow()
        self.add_domain_event(TranscriptionStarted(self.id, self._started_at))
        self.mark_as_updated()

        return Result.success(None)

    def complete_transcription(self, result: TranscriptionResult) -> Result[None]:
        if self._status != TranscriptionStatus.IN_PROGRESS:
            return Result.failure("No transcription in progress")

        self._transcription_result = result
        self._status = TranscriptionStatus.COMPLETED
        self._completed_at = datetime.utcnow()
        self.add_domain_event(TranscriptionCompleted(self.id, result, self._completed_at))
        self.mark_as_updated()

        return Result.success(None)

    def __invariants__(self) -> None:
        if not self._audio_data:
            raise ValueError("Audio session must have audio data")
        if not self._model_config:
            raise ValueError("Audio session must have model configuration")
```

### Aggregate Root Rules

```python
# ✅ CORRECT - Aggregate Root with factory method
class TranscriptionSession(AggregateRoot[str]):
    @classmethod
    def create(cls, model_config: ModelConfig, hotkey_config: HotkeyConfig) -> Result["TranscriptionSession"]:
        session_id = cls._generate_session_id()
        
        model_validation = model_config.validate()
        if not model_validation.is_success:
            return Result.failure(model_validation.error())

        session = cls(session_id, model_config, hotkey_config)
        session.add_domain_event(TranscriptionSessionCreated(session_id, model_config))
        return Result.success(session)

    def start_recording(self, audio_input_device: AudioInputDevice) -> Result[AudioSession]:
        if self._is_recording:
            return Result.failure("Recording already in progress")

        audio_session_result = AudioSession.create(audio_input_device, self._model_config)
        if not audio_session_result.is_success:
            return Result.failure(audio_session_result.error())

        audio_session = audio_session_result.value()
        self._current_session = audio_session
        self._is_recording = True
        self.add_domain_event(RecordingStarted(self.id, audio_session.id))
        self.mark_as_updated()

        return Result.success(audio_session)

    def stop_recording(self) -> Result[TranscriptionResult]:
        if not self._is_recording or not self._current_session:
            return Result.failure("No recording in progress")

        transcription_result = self._current_session.finalize_recording()
        if not transcription_result.is_success:
            return Result.failure(transcription_result.error())

        self._is_recording = False
        self.add_domain_event(RecordingStopped(self.id, self._current_session.id))
        self.mark_as_updated()

        return transcription_result
```

### Value Object Rules

```python
# ✅ CORRECT - Immutable value object
@dataclass(frozen=True)
class AudioData(ValueObject):
    samples: np.ndarray
    sample_rate: int
    duration_seconds: float
    channels: int = 1

    def _get_equality_components(self) -> tuple:
        return (self.samples.tobytes(), self.sample_rate, self.duration_seconds, self.channels)

    def __invariants__(self) -> None:
        if self.samples is None or len(self.samples) == 0:
            raise ValueError("Audio samples cannot be empty")
        if self.sample_rate not in [16000, 22050, 44100, 48000]:
            raise ValueError("Unsupported sample rate")
        if self.duration_seconds < 0.1:
            raise ValueError("Audio duration too short")
        if self.channels not in [1, 2]:
            raise ValueError("Only mono and stereo audio supported")

    @classmethod
    def create(cls, samples: np.ndarray, sample_rate: int) -> Result["AudioData"]:
        try:
            duration = len(samples) / sample_rate
            channels = 1 if len(samples.shape) == 1 else samples.shape[1]
            return Result.success(cls(samples, sample_rate, duration, channels))
        except ValueError as e:
            return Result.failure(str(e))

    def to_mono(self) -> "AudioData":
        """Convert stereo audio to mono"""
        if self.channels == 1:
            return self
        mono_samples = np.mean(self.samples, axis=1)
        return AudioData(mono_samples, self.sample_rate, self.duration_seconds, 1)
```

______________________________________________________________________

## Application Layer

### Command/Query Pattern with PyQt Signals

```python
# Command
@dataclass
class StartRecordingCommand:
    audio_input_device: str
    model_config: ModelConfig
    hotkey_combination: str
    timestamp: datetime = field(default_factory=datetime.utcnow)


# Handler with PyQt signals
class StartRecordingCommandHandler(QObject):
    recording_started = pyqtSignal(str)  # session_id
    recording_failed = pyqtSignal(str)   # error_message
    
    def __init__(self, transcription_service: TranscriptionService):
        super().__init__()
        self.transcription_service = transcription_service
        self.logger = setup_logger()

    def handle(self, command: StartRecordingCommand) -> ApplicationResult[AudioSession]:
        try:
            # 1. Validate command
            validation_result = self._validate_command(command)
            if not validation_result.is_success:
                self.recording_failed.emit(validation_result.error())
                return ApplicationResult.bad_request(validation_result.error())

            # 2. Execute business logic
            session_result = self.transcription_service.start_recording(
                command.audio_input_device,
                command.model_config
            )
            
            if not session_result.is_success:
                self.recording_failed.emit(session_result.error())
                return ApplicationResult.bad_request(session_result.error())

            # 3. Emit success signal
            audio_session = session_result.value()
            self.recording_started.emit(audio_session.id)
            
            # 4. Return response
            return ApplicationResult.success(audio_session)
            
        except Exception as e:
            error_msg = f"Unexpected error starting recording: {str(e)}"
            self.logger.error(error_msg)
            self.recording_failed.emit(error_msg)
            return ApplicationResult.internal_error(error_msg)

    def _validate_command(self, command: StartRecordingCommand) -> Result[None]:
        if not command.audio_input_device:
            return Result.failure("Audio input device is required")
        if not command.model_config:
            return Result.failure("Model configuration is required")
        return Result.success(None)
```

### API Endpoints

```python
# ✅ CORRECT - Thin controller
@router.post("/tasks", response_model=Envelope[TaskResponse], status_code=201)
async def create_task(
    request: CreateTaskRequest,
    response: Response,
    mediator: Mediator = Depends(lambda: ApplicationContainer.mediator()),
) -> Envelope[TaskResponse]:
    command = CreateTaskCommand(title=request.title, calendar_id=request.calendar_id, due_date=request.due_date)

    result = await mediator.send(command)
    envelope = Envelope.from_result(result, success_status_code=status.HTTP_201_CREATED)
    response.status_code = envelope.status_code

    return envelope
```

______________________________________________________________________

## Infrastructure Layer

### Database Models & Mappers

```python
# Database Model
class TaskModel(BaseModel):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String(200), nullable=False, index=True)
    status = Column(Enum(TaskStatus), nullable=False, default=TaskStatus.PENDING)
    calendar_id = Column(Integer, ForeignKey("calendars.id"), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True, onupdate=datetime.utcnow)


# Mapper
class TaskMapper:
    @staticmethod
    def to_domain(db_model: TaskModel) -> Task:
        task = Task.__new__(Task)
        task._id = db_model.id
        task._title = TaskTitle(db_model.title)
        task._status = db_model.status
        task._calendar_id = db_model.calendar_id
        task._domain_events = []
        return task

    @staticmethod
    def to_persistence(domain_entity: Task) -> TaskModel:
        return TaskModel(
            id=domain_entity.id,
            title=domain_entity.title.value,
            status=domain_entity.status,
            calendar_id=domain_entity.calendar_id,
        )
```

### Repository Pattern for Audio and Model Management

```python
# ✅ CORRECT - Audio Session Repository
class AudioSessionRepository(IAudioSessionRepository):
    def __init__(self, storage_path: str):
        self.storage_path = Path(storage_path)
        self.storage_path.mkdir(exist_ok=True)
        self.logger = setup_logger()

    def get_by_id(self, session_id: str) -> Optional[AudioSession]:
        session_file = self.storage_path / f"{session_id}.json"
        
        if not session_file.exists():
            return None
            
        try:
            with open(session_file, 'r') as f:
                data = json.load(f)
            return AudioSessionMapper.to_domain(data)
        except Exception as e:
            self.logger.error(f"Failed to load session {session_id}: {e}")
            return None

    def save(self, session: AudioSession) -> None:
        session_file = self.storage_path / f"{session.id}.json"
        
        try:
            data = AudioSessionMapper.to_persistence(session)
            with open(session_file, 'w') as f:
                json.dump(data, f, indent=2, default=str)
        except Exception as e:
            self.logger.error(f"Failed to save session {session.id}: {e}")
            raise

    def delete(self, session: AudioSession) -> None:
        session_file = self.storage_path / f"{session.id}.json"
        
        try:
            if session_file.exists():
                session_file.unlink()
        except Exception as e:
            self.logger.error(f"Failed to delete session {session.id}: {e}")
            raise

    def get_recent_sessions(self, limit: int = 10) -> List[AudioSession]:
        """Get most recent audio sessions"""
        session_files = sorted(
            self.storage_path.glob("*.json"),
            key=lambda f: f.stat().st_mtime,
            reverse=True
        )[:limit]
        
        sessions = []
        for file in session_files:
            session = self.get_by_id(file.stem)
            if session:
                sessions.append(session)
        
        return sessions
```

______________________________________________________________________

## Error Handling

### Result Pattern

```python
# Domain Layer - Result[T]
class Result[T]:
    @staticmethod
    def success(value: T) -> "Result[T]":
        return Result(value, None, True)

    @staticmethod
    def failure(error: str) -> "Result[T]":
        return Result(None, error, False)

    def map(self, func: Callable[[T], U]) -> "Result[U]":
        if self.is_success:
            return Result.success(func(self._value))
        return Result.failure(self._error)


# Application Layer - ApplicationResult[T]
class ApplicationResult[T]:
    @staticmethod
    def bad_request(message: str) -> "ApplicationResult[T]":
        return ApplicationResult(None, message, 400, False)

    @staticmethod
    def not_found(message: str) -> "ApplicationResult[T]":
        return ApplicationResult(None, message, 404, False)
```

### Envelope Pattern

```python
# API Response Wrapper
@dataclass
class Envelope[T]:
    data: Optional[T] = None
    error: Optional[str] = None
    status_code: int = 200
    success: bool = True

    @classmethod
    def from_result(cls, result: ApplicationResult[T], success_status_code: int = 200) -> "Envelope[T]":
        if result.is_success:
            return cls(data=result.value(), status_code=success_status_code)
        return cls(error=result.error(), status_code=result.status_code, success=False)
```

______________________________________________________________________

## Testing Strategy

### Domain Layer Testing (Unit Tests)

```python
class TestAudioSessionEntity:
    def test_create_audio_session_with_valid_data_should_succeed(self):
        # Arrange
        audio_data = np.random.rand(16000)  # 1 second of audio at 16kHz
        model_config = ModelConfig("whisper-turbo", "en")
        
        # Act
        result = AudioSession.create(audio_data, 16000, model_config)
        
        # Assert
        assert result.is_success
        session = result.value()
        assert session.audio_data.sample_rate == 16000
        assert session.model_config.model_name == "whisper-turbo"
        assert session.status == TranscriptionStatus.PENDING
        assert session.created_at is not None

    def test_create_session_with_invalid_audio_should_fail(self):
        # Arrange
        audio_data = np.array([])  # Empty audio
        model_config = ModelConfig("whisper-turbo", "en")
        
        # Act
        result = AudioSession.create(audio_data, 16000, model_config)
        
        # Assert
        assert not result.is_success
        assert "Audio samples cannot be empty" in result.error()

    def test_start_transcription_should_update_status(self):
        # Arrange
        audio_data = np.random.rand(16000)
        model_config = ModelConfig("whisper-turbo", "en")
        session = AudioSession.create(audio_data, 16000, model_config).value()
        
        # Act
        result = session.start_transcription()
        
        # Assert
        assert result.is_success
        assert session.status == TranscriptionStatus.IN_PROGRESS
        assert session.started_at is not None
```

### Application Layer Testing (Integration Tests with PyQt Signals)

```python
class TestStartRecordingCommandHandler:
    @pytest.fixture
    def handler(self, transcription_service):
        return StartRecordingCommandHandler(transcription_service)

    @pytest.fixture
    def model_config(self):
        return ModelConfig(
            model_name="whisper-turbo",
            language="en",
            task="transcribe"
        )

    def test_start_recording_with_valid_command_should_succeed(self, handler, model_config, qtbot):
        # Arrange
        command = StartRecordingCommand(
            audio_input_device="default",
            model_config=model_config,
            hotkey_combination="Ctrl+Shift+R"
        )
        
        # Setup signal spy
        with qtbot.waitSignal(handler.recording_started, timeout=5000) as blocker:
            # Act
            result = handler.handle(command)
            
        # Assert
        assert result.is_success
        session = result.value()
        assert session.model_config.model_name == "whisper-turbo"
        assert session.status == TranscriptionStatus.PENDING
        
        # Verify signal was emitted with correct session ID
        assert blocker.args[0] == session.id

    def test_start_recording_with_invalid_device_should_fail(self, handler, model_config, qtbot):
        # Arrange
        command = StartRecordingCommand(
            audio_input_device="",  # Invalid empty device
            model_config=model_config,
            hotkey_combination="Ctrl+Shift+R"
        )
        
        # Setup signal spy for failure
        with qtbot.waitSignal(handler.recording_failed, timeout=1000) as blocker:
            # Act
            result = handler.handle(command)
            
        # Assert
        assert not result.is_success
        assert "Audio input device is required" in result.error()
        
        # Verify failure signal was emitted
        assert "Audio input device is required" in blocker.args[0]
```

### API Layer Testing (End-to-End Tests)

```python
@pytest.mark.asyncio
async def test_create_task_endpoint(client: AsyncClient):
    # Arrange
    request_data = {"title": "Test Task", "calendar_id": 1}

    # Act
    response = await client.post("/api/tasks", json=request_data)

    # Assert
    assert response.status_code == 201
    data = response.json()
    assert data["success"] is True
    assert data["data"]["title"] == "Test Task"
```

______________________________________________________________________

## Performance & Security

### Performance Rules

- **Async/Await**: Use for all I/O operations
- **Connection Pooling**: Configure database connection pools
- **Pagination**: Implement for list operations
- **Caching**: Cache frequently accessed data
- **Indexing**: Proper database indexing strategy

### Security Rules

- **Input Validation**: Validate all user inputs
- **Parameterized Queries**: Prevent SQL injection
- **Environment Variables**: Store secrets securely
- **Authentication/Authorization**: Implement proper access controls

______________________________________________________________________

## Development Workflow

### Adding New Features (9-Step DDD Process)

1. **Identify Entity Type**: Entity, Aggregate Root, or Value Object
1. **Create Domain Models**: Implement business logic and invariants
1. **Create Database Models**: Design persistence layer
1. **Create Mappers**: Convert between domain and database models
1. **Create Commands/Queries**: Define application operations
1. **Create Handlers**: Implement application logic
1. **Create API Endpoints**: Expose functionality via REST API
1. **Create Migrations**: Update database schema
1. **Register Dependencies**: Configure dependency injection

### Best Practices

- **Domain First**: Start with business logic, not database
- **Rich Domain Models**: Entities should DO things, not just store data
- **Result Pattern**: Use explicit error handling
- **Factory Methods**: For complex object creation
- **Domain Events**: For cross-aggregate communication
- **Small Aggregates**: Focus on consistency boundaries
- **Value Objects**: Wrap primitives in meaningful types
- **Immutable Design**: Prefer immutable objects where possible

______________________________________________________________________

## Quick Reference

### Key Libraries

- **FastAPI**: Web framework
- **SQLAlchemy**: ORM and database toolkit
- **Pydantic**: Data validation and serialization
- **dependency-injector**: Dependency injection container
- **pytest**: Testing framework
- **alembic**: Database migrations

### File Organization

```
# Domain entities
domain/entities/task/
├── task.py                    # Main entity
├── task_value_objects.py      # Value objects
└── task_events.py             # Domain events

# Application features
api/features/task/
├── create_task.py             # Complete vertical slice
├── get_task.py                # Query implementation
└── update_task.py             # Command implementation

# Infrastructure
persistence/db_models/task/
├── task_model.py              # Database model
└── task_mapper.py             # Domain ↔ DB mapper
```

### Common Patterns

```python
# Result chaining
result = (
    create_user("John", "john@example.com")
    .map(lambda user: user.update_name("Jane"))
    .on_success(lambda user: print(f"User: {user.name}"))
    .on_failure(lambda error: print(f"Error: {error}"))
)


# Domain event handling
class TaskCompletedHandler:
    async def handle(self, event: TaskCompleted) -> None:
        await self.email_service.send_completion_notification(event.task_id)


# Dependency injection
@inject
def __init__(self, repository: ITaskRepository = Provide[Container.task_repository]):
    self.repository = repository
```

______________________________________________________________________

## Additional Guidelines

### Error Handling

- Always use Result<T> pattern for operations that can fail
- Never throw exceptions from domain layer
- Log errors at infrastructure boundaries (audio processing, model loading)
- Provide meaningful error messages to users via PyQt signals
- Handle audio device disconnection gracefully
- Implement retry logic for model loading failures

### Performance

- Use background workers (QThread) for audio processing
- Implement proper audio buffer management
- Cache loaded models to avoid reloading
- Use efficient audio format conversions (numpy operations)
- Profile transcription performance and optimize bottlenecks
- Implement progressive loading for large audio files

### Audio Processing Best Practices

- Always validate audio sample rates and formats
- Implement proper audio normalization
- Handle different audio input devices consistently
- Use appropriate buffer sizes for real-time processing
- Implement Voice Activity Detection (VAD) for efficiency
- Support both mono and stereo audio inputs

### Model Management

- Cache model instances to avoid repeated loading
- Implement model switching without application restart
- Validate model compatibility before loading
- Handle model download and updates gracefully
- Support multiple model formats (ONNX, PyTorch)
- Implement model performance monitoring

### UI/UX Guidelines

- Use PyQt signals for non-blocking UI updates
- Provide visual feedback for long-running operations
- Implement proper progress indicators for transcription
- Handle hotkey registration and conflicts
- Ensure responsive UI during audio processing
- Implement proper error dialogs and notifications

### Security

- Validate all audio inputs at application boundaries
- Secure temporary audio file storage
- Implement proper cleanup of sensitive audio data
- Never log audio content or transcription results
- Validate model file integrity before loading
- Implement secure settings storage

### Logging

- Use structured logging with session correlation IDs
- Log at appropriate levels (DEBUG, INFO, WARN, ERROR)
- Include audio processing context in log messages
- Never log audio data or transcription content
- Log model loading and performance metrics
- Implement log rotation for long-running sessions

______________________________________________________________________

### Package Management with `uv`

- **Exclusive Usage**: Use `uv` exclusively for Python dependency management
- **Basic Commands**:
  - `uv add <package>` - Add dependencies
  - `uv remove <package>` - Remove dependencies
  - `uv sync` - Reinstall from lock file
  - `uv run script.py` - Run scripts with dependencies
- **Script Dependencies**: Use inline metadata or `uv add --script` for script-specific dependencies
- **Never Use**: Avoid `pip`, `pip-tools`, or `poetry` for dependency management

### Development Tools

- **Testing**: Use appropriate testing frameworks (pytest, Django's unittest, RoboCorp testing)
- **Code Quality**: Use ruff for formatting, mypy for type checking
- **Monitoring**: Implement structured logging and monitoring for all applications

## Key Conventions

1. **Configuration Management**: Use environment-specific configuration files and environment variables
1. **API Versioning**: Implement proper API versioning strategy (URL-based versioning recommended)
1. **Security**: Implement proper CSRF protection, CORS configuration, and input sanitization
1. **Testing**: Write comprehensive tests for all components and maintain good test coverage
1. **Documentation**: Maintain clear documentation for APIs, models, and complex business logic
1. **Monitoring**: Implement proper logging, monitoring, and error tracking
1. **Deployment**: Use containerization (Docker) and proper CI/CD pipelines
1. **Performance**: Optimize for cloud-native and serverless deployments where applicable
1. **Security-First**: Apply security best practices at every layer of development
1. **Maintainability**: Structure code for long-term maintainability and team collaboration

### Core Guidelines

- **Task Definitions**: Use functional components (plain functions) with clear return type annotations
- **Input Validation**: Use Pydantic models for input validation and response schemas
- **Error Handling**: Use specific exceptions like `RPA.HTTP.HTTPException` for expected errors
- **Performance**: Prioritize RPA performance metrics (execution time, resource utilization, throughput)
- **Asynchronous Operations**: Use async functions for I/O-bound tasks and external API calls
- **Middleware**: Use middleware for logging, error monitoring, and performance optimization

### Async Operations

- **I/O Operations**: Use asynchronous operations for all database calls and external API requests
- **Background Tasks**: Use appropriate background task systems (Celery, FastAPI background tasks, RoboCorp async tasks)
- **Parallel Processing**: Utilize appropriate parallelization for compute-intensive tasks

### FastAPI Development

- **Type Hints**: Use type hints for all function signatures; prefer Pydantic models over raw dictionaries
- **Error Handling**: Use early returns and guard clauses; handle errors at the beginning of functions
- **Dependencies**: Rely on FastAPI's dependency injection system for managing state and shared resources
- **Performance**: Minimize blocking I/O operations; use asynchronous operations for database calls
- **Middleware**: Use middleware for logging, error monitoring, and performance optimization

### Programming Paradigms

- **Functional Programming**: Use functional, declarative programming; avoid classes where possible (except for models, views, ML architectures, and Flask views)
- **Object-Oriented Programming**: Use OOP for model architectures (Django/Odoo models, PyTorch nn.Module, Flask-RESTful views) and complex business logic
- **Vectorized Operations**: Prefer vectorized operations over explicit loops for better performance
- **Method Chaining**: Use method chaining for data transformations when possible
- **Pure Functions**: Ensure functions are free of side effects for compatibility with JAX transformations and microservices
- **Immutability**: Embrace functional programming principles; avoid mutable states where possible
- **RORO Pattern**: Use the Receive an Object, Return an Object (RORO) pattern for consistent interfaces

### Function Definitions

- **Synchronous Functions**: Use `def` for pure functions and synchronous operations
- **Asynchronous Functions**: Use `async def` for asynchronous operations and I/O-bound tasks
- **Type Hints**: Use type hints for all function signatures; prefer Pydantic models over raw dictionaries for input validation
- **Early Returns**: Use early returns for error conditions to avoid deeply nested if statements
- **Guard Clauses**: Use guard clauses to handle preconditions and invalid states early
