import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Layouts

Item {
    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width, 420)
        spacing: 14

        Image {
            source: "../icons/pdsync.svg"
            sourceSize: Qt.size(72, 72)
            Layout.alignment: Qt.AlignHCenter
        }
        Label {
            text: "Choose what to sync"
            font.pointSize: 16
            font.bold: true
            Layout.alignment: Qt.AlignHCenter
        }
        Label {
            text: "Logged in as " + backend.username + ". Pick a folder on this computer for your Drive's My Files. "
                + "Sync never overwrites a file you changed, and uploads only what you allow in Settings."
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
            Layout.fillWidth: true
        }
        Button {
            text: "Choose a folder for My Files…"
            highlighted: true
            enabled: !backend.busyAction
            Layout.alignment: Qt.AlignHCenter
            onClicked: dialog.open()
        }
        Label {
            text: "Or keep My Files online only, and back up folders from this computer instead "
                + `(they appear on Drive under Computers → ${backend.computerName}):`
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
            opacity: 0.8
            Layout.fillWidth: true
            Layout.topMargin: 8
        }
        Button {
            text: "Sync a folder from this computer…"
            enabled: !backend.busyAction
            Layout.alignment: Qt.AlignHCenter
            onClicked: computerDialog.open()
        }
    }

    FolderDialog {
        id: computerDialog
        title: "Folder from this computer to sync"
        onAccepted: backend.addFolder(String(selectedFolder))
    }

    FolderDialog {
        id: dialog
        title: "Folder for your Drive files"
        onAccepted: backend.chooseFolder(String(selectedFolder))
    }
}
