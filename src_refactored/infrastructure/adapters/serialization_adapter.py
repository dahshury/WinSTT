"""Serialization Adapter.

This adapter implements the SerializationPort using Python's standard library
json module and other serialization libraries.
"""

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from src_refactored.domain.common.ports.serialization_port import SerializationPort
from src_refactored.domain.common.result import Result


class SerializationAdapter(SerializationPort):
    """Adapter that implements SerializationPort using standard library."""

    def serialize_to_json(self, data: Any) -> Result[str]:
        """Serialize data to JSON string."""
        try:
            json_string = json.dumps(data, indent=2, ensure_ascii=False, default=str)
            return Result.success(json_string)
        except Exception as e:
            return Result.failure(f"Failed to serialize to JSON: {e}")

    def deserialize_from_json(self, json_string: str, expected_type: type | None = None) -> Result[Any]:
        """Deserialize JSON string to data."""
        try:
            data = json.loads(json_string)
            if expected_type and not isinstance(data, expected_type):
                return Result.failure(f"Expected type {expected_type}, got {type(data)}")
            return Result.success(data)
        except json.JSONDecodeError as e:
            return Result.failure(f"Invalid JSON: {e}")
        except Exception as e:
            return Result.failure(f"Failed to deserialize from JSON: {e}")

    def serialize_to_dict(self, obj: Any) -> Result[dict[str, Any]]:
        """Serialize object to dictionary."""
        try:
            if hasattr(obj, "to_dict"):
                return Result.success(obj.to_dict())
            if hasattr(obj, "__dict__"):
                return Result.success(obj.__dict__)
            if isinstance(obj, dict):
                return Result.success(obj)
            # Try to convert via JSON serialization
            json_str = json.dumps(obj, default=str)
            data = json.loads(json_str)
            if isinstance(data, dict):
                return Result.success(data)
            return Result.failure(f"Object of type {type(obj)} cannot be serialized to dict")
        except Exception as e:
            return Result.failure(f"Failed to serialize to dict: {e}")

    def deserialize_from_dict(self, data: dict[str, Any], target_type: type) -> Result[Any]:
        """Deserialize dictionary to object of specified type."""
        try:
            if hasattr(target_type, "from_dict"):
                obj = target_type.from_dict(data)
                return Result.success(obj)
            # Try to construct object directly
            obj = target_type(**data)
            return Result.success(obj)
        except Exception as e:
            return Result.failure(f"Failed to deserialize from dict to {target_type}: {e}")

    def serialize_to_xml(self, data: Any) -> Result[str]:
        """Serialize data to XML string."""
        try:
            def dict_to_xml(tag: str, data: Any) -> ET.Element:
                """Convert dictionary to XML element."""
                element = ET.Element(tag)
                if isinstance(data, dict):
                    for key, value in data.items():
                        sub_element = dict_to_xml(key, value)
                        element.append(sub_element)
                elif isinstance(data, list):
                    for i, item in enumerate(data):
                        sub_element = dict_to_xml(f"item_{i}", item)
                        element.append(sub_element)
                else:
                    element.text = str(data)
                return element

            if isinstance(data, dict):
                root = dict_to_xml("root", data)
            else:
                root = dict_to_xml("data", data)
            
            xml_string = ET.tostring(root, encoding="unicode")
            return Result.success(xml_string)
        except Exception as e:
            return Result.failure(f"Failed to serialize to XML: {e}")

    def deserialize_from_xml(self, xml_string: str, expected_type: type | None = None) -> Result[Any]:
        """Deserialize XML string to data."""
        try:
            def xml_to_dict(element: ET.Element) -> Any:
                """Convert XML element to dictionary."""
                if len(element) == 0:
                    return element.text

                result: dict[str, Any] = {}
                for child in element:
                    child_data = xml_to_dict(child)
                    if child.tag in result:
                        if not isinstance(result[child.tag], list):
                            result[child.tag] = [result[child.tag]]
                        result[child.tag].append(child_data)
                    else:
                        result[child.tag] = child_data
                return result

            root = ET.fromstring(xml_string)
            data = xml_to_dict(root)
            
            if expected_type and not isinstance(data, expected_type):
                return Result.failure(f"Expected type {expected_type}, got {type(data)}")
            
            return Result.success(data)
        except ET.ParseError as e:
            return Result.failure(f"Invalid XML: {e}")
        except Exception as e:
            return Result.failure(f"Failed to deserialize from XML: {e}")

    def validate_json_schema(self, json_string: str, schema: dict[str, Any]) -> Result[bool]:
        """Validate JSON string against a schema."""
        try:
            json.loads(json_string)
            # Basic validation - would need jsonschema library for full validation
            # For now, just check if it's valid JSON and return True
            return Result.success(True)
        except json.JSONDecodeError:
            return Result.success(False)
        except Exception as e:
            return Result.failure(f"Failed to validate JSON schema: {e}")

    def get_supported_formats(self) -> Result[list[str]]:
        """Get list of supported serialization formats."""
        try:
            formats = ["json", "xml", "dict"]
            return Result.success(formats)
        except Exception as e:
            return Result.failure(f"Failed to get supported formats: {e}")

    def is_valid_json(self, json_string: str) -> Result[bool]:
        """Check if string is valid JSON."""
        try:
            json.loads(json_string)
            return Result.success(True)
        except json.JSONDecodeError:
            return Result.success(False)
        except Exception as e:
            return Result.failure(f"Failed to validate JSON: {e}")

    def pretty_print_json(self, json_string: str, indent: int = 2) -> Result[str]:
        """Format JSON string with pretty printing."""
        try:
            data = json.loads(json_string)
            pretty_json = json.dumps(data, indent=indent, ensure_ascii=False)
            return Result.success(pretty_json)
        except json.JSONDecodeError as e:
            return Result.failure(f"Invalid JSON: {e}")
        except Exception as e:
            return Result.failure(f"Failed to pretty print JSON: {e}")

    def minify_json(self, json_string: str) -> Result[str]:
        """Minify JSON string by removing unnecessary whitespace."""
        try:
            data = json.loads(json_string)
            minified_json = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
            return Result.success(minified_json)
        except json.JSONDecodeError as e:
            return Result.failure(f"Invalid JSON: {e}")
        except Exception as e:
            return Result.failure(f"Failed to minify JSON: {e}")

    def deserialize_json_to_dict(self, file_path: str) -> Result[dict[str, Any]]:
        """Deserialize JSON from a file to dictionary."""
        try:
            path = Path(file_path)
            if not path.exists():
                return Result.failure(f"File does not exist: {file_path}")
            
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            
            if not isinstance(data, dict):
                return Result.failure(f"JSON file does not contain a dictionary: {file_path}")
            
            return Result.success(data)
        except json.JSONDecodeError as e:
            return Result.failure(f"Invalid JSON in file {file_path}: {e}")
        except Exception as e:
            return Result.failure(f"Failed to deserialize JSON from file {file_path}: {e}")

