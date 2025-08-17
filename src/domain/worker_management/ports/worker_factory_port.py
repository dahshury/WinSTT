"""Worker Factory Port for creating workers."""

from abc import ABC, abstractmethod
from typing import Any


class IWorkerFactory(ABC):
    """Port interface for worker factory."""
    
    @abstractmethod
    def create_vad_worker(self) -> Any:
        """Create VAD worker.
        
        Returns:
            VAD worker instance
        """
        ...
    
    @abstractmethod
    def create_model_worker(self, model_type: str, quantization: str) -> Any:
        """Create model worker.
        
        Args:
            model_type: Type of model to use
            quantization: Quantization level
            
        Returns:
            Model worker instance
        """
        ...
    
    @abstractmethod
    def create_listener_worker(self, model: Any, vad: Any, rec_key: str) -> Any:
        """Create listener worker.
        
        Args:
            model: Model instance
            vad: VAD instance
            rec_key: Recording key combination
            
        Returns:
            Listener worker instance
        """
        ...
    
    @abstractmethod
    def create_llm_worker(self, model_type: str, quantization: str) -> Any:
        """Create LLM worker.
        
        Args:
            model_type: Type of LLM to use
            quantization: Quantization level
            
        Returns:
            LLM worker instance
        """
        ...
