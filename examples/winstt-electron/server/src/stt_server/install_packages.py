"""Package install utility -- checks for required packages and prompts to install."""

from __future__ import annotations

import importlib
import shutil
import subprocess
import sys
from typing import TypedDict


class PackageSpec(TypedDict, total=False):
    """Specification for a single package to check/install.

    At least one of ``import_name`` or ``module_name`` must be provided.
    """

    import_name: str
    module_name: str
    attribute: str
    install_name: str
    version: str


def _install_package(package_spec: str) -> None:
    """Install a package using uv (preferred) or pip as fallback."""
    uv = shutil.which("uv")
    if uv:
        subprocess.check_call([uv, "pip", "install", package_spec])
        return
    subprocess.check_call([sys.executable, "-m", "pip", "install", package_spec])


def check_and_install_packages(packages: list[PackageSpec]) -> None:
    """Check if specified packages are installed; prompt to install if missing.

    Each entry in *packages* is a :class:`PackageSpec` with:
    - ``import_name`` **or** ``module_name``: name used to import.
    - ``attribute`` (optional): attribute to check after import.
    - ``install_name`` (optional): pip package name (defaults to import/module name).
    - ``version`` (optional): version constraint string.
    """
    for package in packages:
        module_name: str = package.get("import_name") or package.get("module_name", "")
        attribute: str | None = package.get("attribute")
        install_name: str = package.get("install_name", module_name)
        version: str = package.get("version", "")

        try:
            module = importlib.import_module(module_name)
            if attribute:
                getattr(module, attribute)
        except (ImportError, AttributeError):
            user_input = input(
                f"This program requires '{module_name}'"
                f"{'' if not attribute else ' with attribute ' + attribute}"
                f", which is not installed or missing.\n"
                f"Do you want to install '{install_name}' now? (y/n): "
            )
            if user_input.strip().lower() == "y":
                try:
                    package_spec = f"{install_name}{version}" if version else install_name
                    _install_package(package_spec)
                    module = importlib.import_module(module_name)
                    if attribute:
                        getattr(module, attribute)
                    print(f"Successfully installed '{install_name}'.")
                except Exception as exc:
                    print(f"An error occurred while installing '{install_name}': {exc}")
                    sys.exit(1)
            else:
                print(f"The program requires '{install_name}' to run. Exiting...")
                sys.exit(1)
