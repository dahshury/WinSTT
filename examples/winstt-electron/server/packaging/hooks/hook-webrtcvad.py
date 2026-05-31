# Override the stdhook bundled with pyinstaller-hooks-contrib, which
# unconditionally calls ``copy_metadata('webrtcvad')`` — that's the PyPI
# package name for the *original* abandoned package. WinSTT depends on
# ``webrtcvad-wheels`` (a maintained fork that re-publishes the same
# ``webrtcvad`` import name under a different distribution name).
# copy_metadata against the wrong dist name raises and aborts the build.
#
# This file is found before the stdhook because our ``hookspath`` is
# prepended in the spec.

from PyInstaller.utils.hooks import copy_metadata

datas = copy_metadata("webrtcvad-wheels")
