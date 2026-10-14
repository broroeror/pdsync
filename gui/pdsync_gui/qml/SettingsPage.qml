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
