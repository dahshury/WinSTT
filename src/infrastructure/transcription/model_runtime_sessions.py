"""Enhanced ONNX runtime session management with optimizations from onnx_asr.

Provides optimized session creation, device detection, and memory management
for Whisper ONNX models with proper provider configuration and IO binding support.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import onnxruntime as ort

if TYPE_CHECKING:
    from collections.abc import Sequence


class OnnxSessionOptions:
    """Enhanced ONNX session options with provider optimization."""
    
    def __init__(
        self,
        sess_options: ort.SessionOptions | None = None,
        providers: Sequence[str | tuple[str, dict[Any, Any]]] | None = None,
        provider_options: Sequence[dict[Any, Any]] | None = None,
        cpu_preprocessing: bool = True,
    ) -> None:
        self.sess_options = sess_options or self._create_optimized_session_options()
        self.providers = providers or ort.get_available_providers()
        self.provider_options = provider_options
        self.cpu_preprocessing = cpu_preprocessing
    
    def _create_optimized_session_options(self) -> ort.SessionOptions:
        """Create optimized session options for better performance."""
        opts = ort.SessionOptions()
        opts.enable_cpu_mem_arena = True
        opts.enable_mem_pattern = True
        opts.enable_mem_reuse = True
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        
        # Set thread count based on available cores
        import os
        cpu_count = os.cpu_count() or 4
        opts.intra_op_num_threads = min(cpu_count, 8)  # Cap at 8 for stability
        opts.inter_op_num_threads = min(cpu_count // 2, 4)
        
        return opts
    
    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for InferenceSession creation."""
        result = {"providers": self.providers}
        if self.sess_options:
            result["sess_options"] = self.sess_options
        if self.provider_options:
            result["provider_options"] = self.provider_options
        return result


def get_onnx_device(session: ort.InferenceSession) -> tuple[str, int]:
    """Get ONNX device type and id from Session for optimal memory allocation."""
    provider = session.get_providers()[0]
    match provider:
        case "CUDAExecutionProvider" | "ROCMExecutionProvider":
            device_type = "cuda"
        case "DmlExecutionProvider":
            device_type = "dml"
        case _:
            device_type = "cpu"
    
    device_id = 0
    try:
        provider_options = session.get_provider_options().get(provider, {})
        device_id = int(provider_options.get("device_id", 0))
    except (KeyError, ValueError, AttributeError):
            pass  # Use default device_id = 0
    
    return device_type, device_id


class OptimizedInferenceSession:
    """Wrapper for InferenceSession with enhanced error handling and device detection."""
    
    def __init__(self, model_path: str, options: OnnxSessionOptions) -> None:
        self.session = ort.InferenceSession(model_path, **options.to_dict())
        self.device_type, self.device_id = get_onnx_device(self.session)
        self._supports_io_binding = self._check_io_binding_support()
    
    def _check_io_binding_support(self) -> bool:
        """Check if the session supports IO binding for better performance."""
        try:
            binding = self.session.io_binding()
            return binding is not None
        except Exception:
            return False  # IO binding not supported
    
    def run(self, output_names: list[str] | None, input_feed: dict[str, Any]) -> list[Any]:
        """Run inference with optimized memory management."""
        return self.session.run(output_names, input_feed)
    
    def run_with_io_binding(self, input_bindings: dict[str, Any], output_names: list[str]) -> list[Any]:
        """Run inference using IO binding for better GPU memory management."""
        if not self._supports_io_binding:
            return self.run(output_names, input_bindings)
        
        binding = self.session.io_binding()
        
        # Bind inputs
        for name, value in input_bindings.items():
            if hasattr(value, 'device_name'):  # OrtValue
                binding.bind_ortvalue_input(name, value)
            else:
                binding.bind_cpu_input(name, value)
        
        # Bind outputs
        for name in output_names:
            binding.bind_output(name, self.device_type, self.device_id)
        
        self.session.run_with_iobinding(binding)
        return binding.get_outputs()
    
    def get_inputs(self) -> list[Any]:
        """Get input metadata."""
        return self.session.get_inputs()
    
    def get_outputs(self) -> list[Any]:
        """Get output metadata."""
        return self.session.get_outputs()