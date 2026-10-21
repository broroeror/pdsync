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
                            Label {
                                visible: modelData.uploadsOwn
                                text: "Own upload settings: " + page.describeKinds(modelData.uploadKinds)
                                opacity: 0.65
                                font.pointSize: 8.5
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                            }
                        }
                        ToolButton {
                            // Our own gear: icon themes name and draw "configure" differently
                            // (WhiteSur's/Breeze's are sliders), and styles differ in whether
                            // they tint a bundled icon, so pick the version that contrasts
                            // with the theme's text colour (the flat button sits on the window).
                            icon.source: Qt.resolvedUrl(palette.windowText.hslLightness > 0.5
                                ? "../icons/gear-light.svg" : "../icons/gear-dark.svg")
                            icon.color: "transparent"
                            display: AbstractButton.IconOnly
                            text: "Upload settings for this folder"
                            enabled: !backend.busyAction
                            ToolTip.visible: hovered
                            ToolTip.text: text
                            onClicked: uploadsEditor.openFor(modelData)
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
                    text: "These apply to My Files and to every folder without its own settings (the gear next to a folder above). "
                        + "Unticked kinds stay on your computer only. Files changed on both sides always go to Review, "
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

    readonly property var kindLabels: ({
        new: "new files and folders", edits: "edits", moves: "renames and moves", deletes: "deletions"
    })
    function describeKinds(kinds) {
        const names = ["new", "edits", "moves", "deletes"].filter((k) => kinds.indexOf(k) >= 0).map((k) => kindLabels[k])
        return names.length ? names.join(", ") : "nothing (download only)"
    }

    Dialog {
        id: uploadsEditor
        objectName: "uploadsEditor"
        property var folder: null
        function openFor(f) {
            folder = f
            ownBox.checked = f.uploadsOwn
            const start = f.uploadsOwn ? f.uploadKinds : backend.uploadKinds
            for (let i = 0; i < kindBoxes.count; i++) {
                const box = kindBoxes.itemAt(i)
                box.checked = start.indexOf(box.kind) >= 0
            }
            open()
        }
        title: folder ? `Uploads for ${folder.label}` : ""
        modal: true
        anchors.centerIn: Overlay.overlay
        width: Math.min(page.width - 40, 520)
        standardButtons: Dialog.Save | Dialog.Cancel
        // Height from its parts (see the other dialogs: the KDE style otherwise
        // measures too early and the buttons overlap the content).
        height: implicitHeaderHeight + uploadsContent.implicitHeight + implicitFooterHeight + topPadding + bottomPadding + 2 * spacing
        ColumnLayout {
            id: uploadsContent
            width: uploadsEditor.availableWidth
            RadioButton {
                text: "Use the general upload settings"
                checked: !ownBox.checked
                onClicked: ownBox.checked = false
            }
            RadioButton {
                id: ownBox
                text: "Custom for this folder:"
            }
            Repeater {
                id: kindBoxes
                model: [
                    { kind: "new", label: "New files and folders" },
                    { kind: "edits", label: "Edited files (as new versions; Drive keeps the old ones)" },
                    { kind: "moves", label: "Renames and moves" },
                    { kind: "deletes", label: "Deletions (moved to Drive's trash, restorable there)" },
                ]
                delegate: CheckBox {
                    required property var modelData
                    readonly property string kind: modelData.kind
                    text: modelData.label
                    enabled: ownBox.checked
                    Layout.leftMargin: 28
                }
            }
            Label {
                text: ownBox.checked
                    ? "This folder ignores the general settings and uploads only what's ticked here."
                    : "Currently: " + page.describeKinds(backend.uploadKinds) + " (from the general settings below)."
                wrapMode: Text.WordWrap
                opacity: 0.7
                font.pointSize: 8.5
                Layout.fillWidth: true
                Layout.topMargin: 4
            }
        }
        onAccepted: {
            const kinds = []
            for (let i = 0; i < kindBoxes.count; i++) {
                const box = kindBoxes.itemAt(i)
                if (box.checked) kinds.push(box.kind)
            }
            backend.setFolderUploads(folder.id, ownBox.checked, kinds)
        }
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
