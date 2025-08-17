"""User notification adapter for Presentation using QMessageBox."""

from PyQt6.QtWidgets import QMessageBox, QWidget


class UserNotificationPort:
    def info(self, parent: QWidget, title: str, message: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def error(self, parent: QWidget, title: str, message: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def warning(self, parent: QWidget, title: str, message: str) -> None:  # pragma: no cover
        raise NotImplementedError


class QMessageBoxNotificationService(UserNotificationPort):
    def info(self, parent: QWidget, title: str, message: str) -> None:
        QMessageBox.information(parent, title, message)

    def error(self, parent: QWidget, title: str, message: str) -> None:
        QMessageBox.critical(parent, title, message)

    def warning(self, parent: QWidget, title: str, message: str) -> None:
        QMessageBox.warning(parent, title, message)


