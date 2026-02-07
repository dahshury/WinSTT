from __future__ import annotations


class DomainError(Exception):
    pass


class AudioError(DomainError):
    pass


class TranscriptionError(DomainError):
    pass


class VADError(DomainError):
    pass


class ConfigurationError(DomainError):
    pass


class PipelineError(DomainError):
    pass


class WakeWordError(DomainError):
    pass
