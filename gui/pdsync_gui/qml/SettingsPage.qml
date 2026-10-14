import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Layouts

ScrollView {
    id: page
    contentWidth: availableWidth

    ColumnLayout {
        width: page.availableWidth
        spacing: 18

        GroupBox {
            title: "Account"
            Layout.fillWidth: true
            RowLayout {
                anchors.fill: parent
                Label { text: "Logged in as " + backend.username; Layout.fillWidth: true; elide: Text.ElideRight }
                Button {
                    text: "Log out"
                    enabled: !backend.busyAction
                    onClicked: confirmLogout.open()
                }
            }
        }

        GroupBox {
            title: "Folder"
            Layout.fillWidth: true
            ColumnLayout {
                anchors.fill: parent
                RowLayout {
                    Label { text: backend.folder; elide: Text.ElideMiddle; Layout.fillWidth: true }
                    Button { text: "Change…"; enabled: !backend.busyAction; onClicked: folderDialog.open() }
                }
                Label {
                    text: "Changing the folder starts a fresh copy there. The old folder and its files are left exactly as they are."
                    wrapMode: Text.WordWrap
                    opacity: 0.7
                    font.pointSize: 8.5
                    Layout.fillWidth: true
                }
            }
        }

        GroupBox {
            title: "Upload my changes to Drive"
            Layout.fillWidth: true
            ColumnLayout {
                anchors.fill: parent
                Repeater {
                    model: [
                        { kind: "new", label: "New files and folders" },
                        { kind: "edits", label: "Edited files (as new versions; Drive keeps the old ones)" },
                        { kind: "moves", label: "Renames and moves" },
                        { kind: "deletes", label: "Deletions (moved to Drive's trash, restorable there)" },
                    ]
                    delegate: CheckBox {
                        required property var modelData
                        text: modelData.label
                        checked: backend.uploadKinds.indexOf(modelData.kind) >= 0
                        enabled: !backend.busyAction
                        onToggled: backend.setUploadKind(modelData.kind, checked)
                    }
                }
                Label {
                    text: "Unticked kinds stay on your computer only. Files changed on both sides always go to Review, "
                        + "and deleting many files at once always asks first."
                    wrapMode: Text.WordWrap
                    opacity: 0.7
                    font.pointSize: 8.5
                    Layout.fillWidth: true
                }
            }
        }

        GroupBox {
            title: "When a file is deleted on Drive"
            Layout.fillWidth: true
            ColumnLayout {
                anchors.fill: parent
                RadioButton {
                    text: "Move my copy to the desktop trash"
                    checked: !backend.trashDir
                    enabled: !backend.busyAction
                    // Re-bind so the buttons always show the real setting.
                    onClicked: {
                        checked = Qt.binding(() => !backend.trashDir)
                        if (backend.trashDir) backend.setTrash("desktop")
                    }
                }
                RowLayout {
                    Layout.fillWidth: true
                    RadioButton {
                        text: backend.trashDir ? "Move my copy to" : "Move my copy to a folder I choose…"
                        checked: !!backend.trashDir
                        enabled: !backend.busyAction
                        // Stays as it was if the dialog is cancelled.
                        onClicked: {
                            checked = Qt.binding(() => !!backend.trashDir)
                            trashDialog.open()
                        }
                    }
                    Label {
                        visible: !!backend.trashDir
                        text: backend.trashDir
                        elide: Text.ElideMiddle
                        Layout.fillWidth: true
                    }
                    Button {
                        visible: !!backend.trashDir
                        text: "Change…"
                        enabled: !backend.busyAction
                        onClicked: trashDialog.open()
                    }
                }
                Label {
                    text: "Nothing is ever deleted outright, and a copy you changed here is always kept. "
                        + "A folder on another drive works too; if the drive isn't plugged in, your copy stays put until it is."
                    wrapMode: Text.WordWrap
                    opacity: 0.7
                    font.pointSize: 8.5
                    Layout.fillWidth: true
                }
            }
        }

        GroupBox {
            title: "Automatic sync"
            Layout.fillWidth: true
            ColumnLayout {
                anchors.fill: parent
                RowLayout {
                    Switch {
                        id: auto
                        text: "Sync automatically every"
                        checked: backend.autoSync
                        enabled: !backend.busyAction
                        onToggled: backend.setAutoSync(checked, interval.value)
                    }
                    SpinBox {
                        id: interval
                        from: 1
                        to: 240
                        value: backend.intervalMinutes
                        editable: true
                        enabled: !backend.busyAction
                    }
                    Label { text: "minutes" }
                    Button {
                        text: "Apply"
                        visible: auto.checked && interval.value !== backend.intervalMinutes
                        onClicked: backend.setAutoSync(true, interval.value)
                    }
                }
                Label {
                    text: "Runs in the background while you're logged in, even when this window is closed."
                    wrapMode: Text.WordWrap
                    opacity: 0.7
                    font.pointSize: 8.5
                    Layout.fillWidth: true
                }
                Switch {
                    text: "Show the tray icon when I log in"
                    checked: backend.startAtLogin
                    onToggled: backend.setStartAtLogin(checked)
                }
            }
        }

        Label {
            text: "This is a third-party application not officially supported by Proton."
            wrapMode: Text.WordWrap
            opacity: 0.6
            font.pointSize: 8.5
            Layout.fillWidth: true
        }
    }

    FolderDialog {
        id: trashDialog
        title: "Folder for copies of files deleted on Drive"
        onAccepted: backend.setTrash(String(selectedFolder))
    }

    FolderDialog {
        id: folderDialog
        title: "New folder for your Drive files"
        onAccepted: backend.chooseFolder(String(selectedFolder))
    }

    Dialog {
        id: confirmLogout
        title: "Log out?"
        modal: true
        anchors.centerIn: Overlay.overlay
        standardButtons: Dialog.Ok | Dialog.Cancel
        Label { text: "Syncing stops until you log in again. Your files stay where they are." }
        onAccepted: backend.logout()
    }
}
