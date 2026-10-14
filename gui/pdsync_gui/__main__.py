"""Desktop app: tray icon + window. Run with --hidden to start in the tray."""

import signal
import sys
from pathlib import Path

from PySide6.QtCore import QUrl
from PySide6.QtGui import QAction, QIcon
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

from .backend import Backend

HERE = Path(__file__).resolve().parent
INSTANCE_KEY = "pdsync-gui"
TRAY_ICONS = {
    "ok": "pdsync-ok",
    "syncing": "pdsync-syncing",
    "attention": "pdsync-attention",
    "error": "pdsync-error",
    "login": "pdsync-login",
    "setup": "pdsync-setup",
}


def icon(name: str) -> QIcon:
    return QIcon(str(HERE / "icons" / f"{name}.svg"))


def already_running() -> bool:
    """If another instance runs, ask it to show its window and return True."""
    socket = QLocalSocket()
    socket.connectToServer(INSTANCE_KEY)
    if socket.waitForConnected(300):
        socket.write(b"show")
        socket.waitForBytesWritten(300)
        return True
    return False


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("pdsync")
    app.setDesktopFileName("pdsync-gui")
    app.setWindowIcon(icon("pdsync"))
    # Closing the window hides it; the app lives on in the tray.
    app.setQuitOnLastWindowClosed(False)
    signal.signal(signal.SIGINT, signal.SIG_DFL)

    if already_running():
        return 0
    QLocalServer.removeServer(INSTANCE_KEY)
    server = QLocalServer()
    server.listen(INSTANCE_KEY)

    backend = Backend()
    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("backend", backend)
    engine.load(QUrl.fromLocalFile(str(HERE / "qml" / "Main.qml")))
    if not engine.rootObjects():
        return 1
    window = engine.rootObjects()[0]

    def show_window():
        window.show()
        window.raise_()
        window.requestActivate()

    server.newConnection.connect(lambda: (server.nextPendingConnection(), show_window()))
    backend.showWindowRequested.connect(show_window)

    tray = QSystemTrayIcon(icon("pdsync-setup"))
    tray.setToolTip("pdsync")
    menu = QMenu()
    status_action = QAction("…")
    status_action.setEnabled(False)
    menu.addAction(status_action)
    menu.addSeparator()
    open_action = menu.addAction("Open")
    open_action.triggered.connect(show_window)
    sync_action = menu.addAction("Sync now")
    sync_action.triggered.connect(lambda: backend.stopSync() if backend.running else backend.syncNow())
    folder_action = menu.addAction("Open mirror folder")
    folder_action.triggered.connect(backend.openFolder)
    menu.addSeparator()
    menu.addAction("Quit").triggered.connect(app.quit)
    tray.setContextMenu(menu)
    tray.activated.connect(
        lambda reason: (window.setVisible(not window.isVisible()), window.isVisible() and show_window())
        if reason == QSystemTrayIcon.ActivationReason.Trigger
        else None
    )

    def update_tray():
        tray.setIcon(icon(TRAY_ICONS[backend.state]))
        tray.setToolTip(f"pdsync: {backend.stateText}\n{(backend.running and backend.progressText) or backend.lastRunText}")
        status_action.setText(backend.stateText)
        sync_action.setText("Stop syncing" if backend.running else "Sync now")
        sync_action.setEnabled(backend.state not in ("login", "setup") and backend.busyAction != "stop")
        folder_action.setEnabled(bool(backend.folder))

    backend.changed.connect(update_tray)
    backend.notify.connect(
        lambda title, message: tray.showMessage(title, message, icon("pdsync"), 8000)
    )
    tray.messageClicked.connect(show_window)
    update_tray()
    tray.show()

    if "--hidden" not in sys.argv:
        show_window()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
