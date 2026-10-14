import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    signal reviewRequested()
    spacing: 12

    readonly property var stateColors: ({
        ok: "#2a9d8f", syncing: "#2a9d8f", attention: "#e9a23b", error: "#d64545", login: "#e07a1f", setup: "#8a9499"
    })

    RowLayout {
        spacing: 14
        Layout.fillWidth: true
        Image {
            source: `../icons/pdsync-${backend.state}.svg`
            sourceSize: Qt.size(56, 56)
        }
        ColumnLayout {
            spacing: 2
            Layout.fillWidth: true
            Label {
                text: backend.stateText
                font.pointSize: 15
                font.bold: true
                color: stateColors[backend.state]
            }
            Label { text: backend.lastRunText; opacity: 0.85 }
            Label { text: backend.nextRunText; opacity: 0.65 }
        }
        Item { Layout.fillWidth: true }
        Button {
            text: backend.state === "syncing" ? "Syncing…" : "Sync now"
            enabled: backend.state !== "syncing"
            onClicked: backend.syncNow()
        }
    }

    Label {
        visible: backend.state === "error" && !!backend.lastError
        text: backend.lastError
        color: "#d64545"
        wrapMode: Text.WordWrap
        Layout.fillWidth: true
    }

    Frame {
        visible: backend.massDeleteHeld > 0
        Layout.fillWidth: true
        ColumnLayout {
            anchors.fill: parent
            Label {
                text: `${backend.massDeleteHeld} files were deleted from your folder at once. To be safe, they were not deleted on Drive.`
                font.bold: true
                wrapMode: Text.WordWrap
                Layout.fillWidth: true
            }
            RowLayout {
                Layout.fillWidth: true
                Label {
                    text: "Was that on purpose?"
                    opacity: 0.8
                    Layout.fillWidth: true
                }
                Button {
                    text: "Download them again"
                    enabled: !backend.busyAction
                    onClicked: backend.restoreDeleted()
                }
                Button {
                    text: "Move them to Drive's trash"
                    enabled: !backend.busyAction
                    onClicked: backend.confirmMassDelete()
                }
            }
        }
    }

    Frame {
        visible: backend.reviewCount > 0
        Layout.fillWidth: true
        RowLayout {
            anchors.fill: parent
            Label {
                text: `${backend.reviewCount} file(s) were skipped to protect your local changes.`
                wrapMode: Text.WordWrap
                Layout.fillWidth: true
            }
            Button { text: "Review"; onClicked: reviewRequested() }
        }
    }

    Repeater {
        model: backend.folders
        delegate: RowLayout {
            required property var modelData
            Layout.fillWidth: true
            Label {
                text: (modelData.kind === "myfiles" ? "My Files" : `${backend.computerName} › ${modelData.label}`)
                    + (modelData.pending ? "  ·  first sync pending" : "")
                font.bold: true
            }
            Label {
                text: modelData.local
                elide: Text.ElideMiddle
                opacity: 0.7
                Layout.fillWidth: true
            }
            Button { text: "Open"; flat: true; onClicked: backend.openPath(modelData.local) }
        }
    }

    Label { text: "Recent activity"; font.bold: true }

    Frame {
        Layout.fillWidth: true
        Layout.fillHeight: true
        padding: 0

        Label {
            anchors.centerIn: parent
            visible: activityList.count === 0
            text: "Nothing has happened yet. Changes on either side will show up here."
            opacity: 0.6
        }

        ListView {
            id: activityList
            anchors.fill: parent
            clip: true
            model: backend.activity
            ScrollBar.vertical: ScrollBar {}
            delegate: ItemDelegate {
                width: ListView.view.width
                hoverEnabled: false
                readonly property var glyphs: ({
                    download: ["↓", "#2a9d8f"], upload: ["↑", "#2a9d8f"], created: ["+", "#2a9d8f"], move: ["→", "#4a7fc1"], moved: ["→", "#4a7fc1"], trashed: ["✕", "#8a9499"], removed: ["✕", "#8a9499"],
                    skipped: ["!", "#e9a23b"], warning: ["!", "#e9a23b"], failed: ["✗", "#d64545"], resolved: ["✓", "#2a9d8f"]
                })
                contentItem: RowLayout {
                    spacing: 10
                    Label {
                        text: (glyphs[modelData.kind] || ["·"])[0]
                        color: (glyphs[modelData.kind] || ["", palette.text])[1]
                        font.bold: true
                        Layout.preferredWidth: 14
                        horizontalAlignment: Text.AlignHCenter
                    }
                    ColumnLayout {
                        spacing: 0
                        Layout.fillWidth: true
                        Label {
                            readonly property string where: backend.folders.length > 1 && modelData.folder ? `${modelData.folder} › ` : ""
                            text: where + (modelData.kind === "move" ? `${modelData.detail}  →  ${modelData.path}` : modelData.path)
                            elide: Text.ElideMiddle
                            Layout.fillWidth: true
                        }
                        Label {
                            visible: !!modelData.detail && modelData.kind !== "move"
                            text: modelData.detail
                            font.pointSize: 8.5
                            opacity: 0.65
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                        }
                    }
                    Label { text: modelData.when; opacity: 0.55; font.pointSize: 8.5 }
                }
            }
        }
    }
}
