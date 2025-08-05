import json
import os
import sys
from pathlib import Path

# Import gemma_inference for backward compatibility
from . import gemma_inference


def resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for PyInstaller """
    try:
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = sys._MEIPASS  # type: ignore[attr-defined]
    except Exception:
        # We're running in development mode
        # Get the project root (go up three levels from core/utils/__init__.py)
        current_file = os.path.abspath(__file__)
        # From src/core/utils/__init__.py -> src/core/utils -> src/core -> src -> project_root
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(current_file))))
        # Resources are in src/resources relative to project root
        base_path = os.path.join(project_root, "src")

    full_path = os.path.join(base_path, relative_path)
    
    # Debug: print the path resolution for troubleshooting
    if not os.path.exists(full_path):
        print(f"⚠️  Resource not found: {full_path}")
        # Try alternative path (in case we're in the src directory)
        alt_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(current_file))), relative_path)
        if os.path.exists(alt_path):
            print(f"✅ Found resource at alternative path: {alt_path}")
            return alt_path
    
    return full_path

def get_config():
    # Load from root settings.json instead of src/config/settings.json
    current_file = os.path.abspath(__file__)
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(current_file))))
    config_path = os.path.join(project_root, "settings.json")
    
    try:
        with open(config_path) as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"⚠️  Config file not found: {config_path}")
        # Return default config
        return {
            "rec_key": "F9",
            "llm_enabled": False,
            "llm_model": "llama-3.2-3b-instruct",
            "llm_quantization": "Quantized",
            "model": "whisper-turbo", 
            "quantization": "Quantized",
            "sound_path": "",
            "enable_sound": True,
        }
    except json.JSONDecodeError as e:
        print(f"⚠️  Config file has invalid JSON: {e}")
        return {}

def save_config(config):
    """Save configuration to the config file."""
    # Save to root settings.json instead of src/config/settings.json
    current_file = os.path.abspath(__file__)
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(current_file))))
    config_path = os.path.join(project_root, "settings.json")
    
    try:
        with open(config_path, "w") as f:
            json.dump(config, f, indent=4)
    except Exception as e:
        print(f"⚠️  Error saving config: {e}")


__all__ = ["gemma_inference", "get_config", "resource_path", "save_config"]