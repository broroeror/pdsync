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
                ColumnLayout {
                    spacing: 0
                    Layout.fillWidth: true
                    Label { text: "Logged in as " + backend.username; Layout.fillWidth: true; elide: Text.ElideRight }
                    Label {
                        visible: !!backend.storageText
                        text: backend.storageText
                        opacity: 0.7
                        font.pointSize: 8.5
                    }
                }
                Button {
                    text: "Log out"
                    enabled: !backend.busyAction
                    onClicked: confirmLogout.open()
                }
            }
        }

        GroupBox {
            title: "Folders"
            Layout.fillWidth: true
            ColumnLayout {
                anchors.fill: parent
                spacing: 8

                Label { text: "My Files"; font.bold: true }
                RowLayout {
                    Layout.fillWidth: true
                    Label {
                        text: backend.folder ? backend.folder : "Not synced to this computer"
                        opacity: backend.folder ? 1 : 0.6
                        elide: Text.ElideMiddle
                        Layout.fillWidth: true
                    }
                    Button {
                        visible: !!backend.folder
                        text: "Exclusions…"
                        enabled: !backend.busyAction
                        onClicked: excludeEditor.openFor(backend.folders.find((f) => f.kind === "myfiles"))
                    }
                    Button {
                        visible: !!backend.folder
                        text: backend.busyAction === "move" ? "Moving…" : "Move…"
                        enabled: !backend.busyAction
                        onClicked: moveDialog.openFor("myfiles")
                    }
                    Button {
                        visible: !backend.folder
                        text: "Choose folder…"
                        enabled: !backend.busyAction
                        onClicked: folderDialog.open()
                    }
                }

                Label {
                    text: `From this computer (shown on Drive under Computers → ${backend.computerName})`
                    font.bold: true
                    wrapMode: Text.WordWrap
                    Layout.fillWidth: true
                    Layout.topMargin: 6
                }
                Repeater {
                    model: backend.folders.filter((f) => f.kind === "computer")
                    delegate: RowLayout {
                        required property var modelData
                        Layout.fillWidth: true
                        ColumnLayout {
                            spacing: 0
                            Layout.fillWidth: true
                            Label { text: modelData.local; elide: Text.ElideMiddle; Layout.fillWidth: true }
                            Label {
                                text: `↔ ${backend.computerName} › ${modelData.label}${modelData.pending ? "  (first sync pending)" : ""}`
                                opacity: 0.65
                                font.pointSize: 8.5
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                            }
                        }
                        Button {
                            text: "Exclusions…"
                            enabled: !backend.busyAction
                            onClicked: excludeEditor.openFor(modelData)
                        }
                        Button {
                            text: "Move…"
                            enabled: !backend.busyAction
                            onClicked: moveDialog.openFor(modelData.id)
                        }
                        Button {
                            text: "Remove"
                            enabled: !backend.busyAction
                            onClicked: {
                                confirmRemove.folderId = modelData.id
                                confirmRemove.folderPath = modelData.local
                                confirmRemove.open()
                            }
                        }
                    }
                }
                Label {
                    visible: backend.folders.filter((f) => f.kind === "computer").length === 0
                    text: "None yet."
                    opacity: 0.6
                }
                Button {
                    text: "Add folder…"
                    enabled: !backend.busyAction
                    onClicked: addFolderDialog.open()
                }
                Label {
                    text: "Moving a folder takes its files along and keeps syncing them (nothing is downloaded again). "
                        + "Removing a folder stops syncing it; its files stay, here and on Drive."
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
                        objectName: "intervalBox"
                        // Follows the saved setting only while you're not
                        // changing it (a binding would undo your edit on the
                        // next refresh, before Apply).
                        property bool edited: false
                        from: 1
                        to: 240
                        editable: true
                        enabled: !backend.busyAction
                        Component.onCompleted: value = backend.intervalMinutes
                        onValueModified: edited = true
                        Connections {
                            target: backend
                            function onChanged() {
                                if (!interval.edited) interval.value = backend.intervalMinutes
                            }
                        }
                    }
                    Label { text: "minutes" }
                    Button {
                        text: "Apply"
                        visible: auto.checked && interval.value !== backend.intervalMinutes
                        onClicked: {
                            interval.edited = false
                            backend.setAutoSync(true, interval.value)
                        }
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

    Dialog {
        id: excludeEditor
        property var folder: null
        function openFor(f) {
            folder = f
            defaultsBox.checked = f.excludeDefaults
            customArea.text = f.excludeCustom
            open()
        }
        title: folder ? `Never sync in ${folder.kind === "myfiles" ? "My Files" : folder.label}` : ""
        modal: true
        anchors.centerIn: Overlay.overlay
        width: Math.min(page.width - 40, 520)
        standardButtons: Dialog.Save | Dialog.Cancel
        // Height from its parts: with text set just before opening, the KDE style
        // otherwise measures too early and the buttons overlap the last lines.
        height: implicitHeaderHeight + excludeContent.implicitHeight + implicitFooterHeight + topPadding + bottomPadding + 2 * spacing
        ColumnLayout {
            id: excludeContent
            width: excludeEditor.availableWidth
            CheckBox {
                id: defaultsBox
                text: "Skip things that are always regenerated"
            }
            Label {
                text: "node_modules, .git, Python and build caches, virtual environments, .DS_Store, Thumbs.db"
                opacity: 0.7
                font.pointSize: 8.5
                wrapMode: Text.WordWrap
                Layout.fillWidth: true
                Layout.leftMargin: 28
            }
            Label {
                text: "Also skip (one per line). A name like  *.iso  or  Temp  matches anywhere; a path like  Projects/old  "
                    + "skips that folder and everything in it."
                wrapMode: Text.WordWrap
                Layout.fillWidth: true
                Layout.topMargin: 8
            }
            ScrollView {
                Layout.fillWidth: true
                Layout.preferredHeight: 120
                TextArea {
                    id: customArea
                    placeholderText: "e.g.\n*.iso\nProjects/old"
                }
            }
            Label {
                text: "Skipped items are left alone: excluding something never deletes it, here or on Drive."
                opacity: 0.7
                font.pointSize: 8.5
                wrapMode: Text.WordWrap
                Layout.fillWidth: true
            }
        }
        onAccepted: backend.setExcludes(folder.id, defaultsBox.checked, customArea.text)
    }

    FolderDialog {
        id: moveDialog
        property string folderId
        function openFor(id) {
            folderId = id
            open()
        }
        title: "Where should the folder go?"
        onAccepted: backend.proposeMove(folderId, String(selectedFolder))
    }

    Dialog {
        id: confirmMove
        property string folderId
        property string fromPath
        property string toPath
        title: "Move this folder?"
        modal: true
        anchors.centerIn: Overlay.overlay
        width: Math.min(page.width - 40, 520)
        standardButtons: Dialog.Ok | Dialog.Cancel
        // Height from its parts: with text set just before opening, the KDE style
        // otherwise measures too early and the buttons overlap the last lines.
        height: implicitHeaderHeight + moveText.implicitHeight + implicitFooterHeight + topPadding + bottomPadding + 2 * spacing
        Label {
            id: moveText
            width: confirmMove.availableWidth
            wrapMode: Text.WordWrap
            text: `From:  ${confirmMove.fromPath}\nTo:      ${confirmMove.toPath}\n\n`
                + "Its files move along and keep syncing; nothing is downloaded again or changed on Drive. "
                + "Moving to another drive copies everything first and removes the original only once the copy is complete, "
                + "so a large folder can take a while."
        }
        onAccepted: backend.moveFolder(folderId, toPath)
    }
    Connections {
        target: backend
        function onMoveProposed(folderId, fromPath, toPath) {
            confirmMove.folderId = folderId
            confirmMove.fromPath = fromPath
            confirmMove.toPath = toPath
            confirmMove.open()
        }
    }

    FolderDialog {
        id: addFolderDialog
        title: "Folder from this computer to sync"
        onAccepted: backend.addFolder(String(selectedFolder))
    }

    Dialog {
        id: confirmRemove
        property string folderId
        property string folderPath
        title: "Stop syncing this folder?"
        modal: true
        anchors.centerIn: Overlay.overlay
        standardButtons: Dialog.Ok | Dialog.Cancel
        // Height from its parts: with text set just before opening, the KDE style
        // otherwise measures too early and the buttons overlap the last lines.
        height: implicitHeaderHeight + removeText.implicitHeight + implicitFooterHeight + topPadding + bottomPadding + 2 * spacing
        Label {
            id: removeText
            width: confirmRemove.availableWidth
            wrapMode: Text.WordWrap
            text: `${confirmRemove.folderPath} will stop syncing.\nIts files stay where they are, on this computer and on Drive.`
        }
        onAccepted: backend.removeFolder(folderId)
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
        // Height from its parts: with text set just before opening, the KDE style
        // otherwise measures too early and the buttons overlap the last lines.
        height: implicitHeaderHeight + logoutText.implicitHeight + implicitFooterHeight + topPadding + bottomPadding + 2 * spacing
        Label { id: logoutText; width: confirmLogout.availableWidth; wrapMode: Text.WordWrap; text: "Syncing stops until you log in again. Your files stay where they are." }
        onAccepted: backend.logout()
    }
}
