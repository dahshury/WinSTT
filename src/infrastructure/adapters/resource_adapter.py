"""Resource Service Adapter.

This adapter bridges the real ResourceService (which returns Result[str])
with the simple IResourceService protocol expected by the presentation layer.
"""

from src.domain.common.ports.logging_port import LoggingPort
from src.infrastructure.common.resource_service import ResourceService


class ResourceServiceAdapter:
    """Adapter that bridges ResourceService Result[str] interface to simple get_resource_path interface."""
    
    def __init__(self, logger: LoggingPort | None = None):
        self._service = ResourceService()
        self._logger = logger
    
    def get_resource_path(self, resource_name: str) -> str:
        """Get the path to a resource."""
        try:
            # Support new '@resources/...' alias; the underlying service handles mapping
            result = self._service.get_resource_path(resource_name)
            if result.is_success:
                path = result.value or resource_name
                if self._logger:
                    self._logger.log_debug(f"Resource path resolved: {resource_name} -> {path}")
                return path
            # If service failed, use fallback approach like the old resource_path function
            if self._logger:
                self._logger.log_warning(f"ResourceService failed for {resource_name}: {result.error}")
            
            # Fallback using legacy approach
            import os
            import sys
            
            try:
                # PyInstaller support
                base_path = sys._MEIPASS  # type: ignore[attr-defined]
            except AttributeError:
                # Development mode - find project root
                current_file = os.path.abspath(__file__)
                # From src/infrastructure/adapters/resource_adapter.py -> project root
                project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(current_file))))
                base_path = os.path.join(project_root, "src")
            
            # Normalize known prefixes to on-disk path under src/resources
            rel_name = resource_name
            if rel_name.startswith("@resources/"):
                rel_name = os.path.join("src", "resources", rel_name.replace("@resources/", ""))
            elif rel_name.startswith("resources/"):
                rel_name = os.path.join("src", "resources", rel_name.replace("resources/", ""))

            full_path = os.path.join(base_path, rel_name)
            
            # If that doesn't exist, try without the 'src' prefix
            if not os.path.exists(full_path):
                current_file = os.path.abspath(__file__)
                project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(current_file))))
                # Try project root with normalized relative
                alt_path = os.path.join(project_root, rel_name)
                if os.path.exists(alt_path):
                    return alt_path
                
                # Try media directory for certain files (legacy)
                if resource_name.startswith(("resources/", "@resources/")):
                    candidate = resource_name
                    if candidate.startswith("@resources/"):
                        candidate = candidate.replace("@resources/", "")
                    else:
                        candidate = candidate.replace("resources/", "")
                    media_path = os.path.join(project_root, "media", candidate)
                    if os.path.exists(media_path):
                        return media_path
            
            return full_path
            
        except Exception as e:
            if self._logger:
                self._logger.log_error("Failed to get resource path", exception=e)
            
            # Final fallback - return a constructed path
            return resource_name
    
    def resource_exists(self, relative_path: str) -> bool:
        """Check if a resource exists."""
        try:
            result = self._service.get_resource_path(relative_path)
            if result.is_success:
                import os
                return os.path.exists(result.value or "")
            return False
        except Exception:
            return False
