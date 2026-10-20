pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.plasmoid
import org.kde.plasma.plasma5support as Plasma5Support
import "../code/Translations.js" as Translations

PlasmoidItem {
    id: root
    readonly property bool inPanel: Plasmoid.formFactor === PlasmaCore.Types.Horizontal || Plasmoid.formFactor === PlasmaCore.Types.Vertical
    // Let Plasma supply its native square icon, keyboard activation and popup
    // lifecycle. Desktop constraints belong to the full view, not the panel.
    preferredRepresentation: inPanel ? compactRepresentation : fullRepresentation
    property var snapshot: null
    property string connectionStatus: "loading"
    property string language: Qt.locale().name.split(/[_-]/)[0]
    property bool pending: false
    // Only a fixed packaged helper is executed. No account/provider/server data
    // ever becomes a command, argument, URL or filesystem path.
    readonly property string helper: decodeURIComponent(Qt.resolvedUrl("../code/read_snapshot.py").toString().replace(/^file:\/\//, ""))
    readonly property string command: "/usr/bin/python3 -I '" + helper.replace(/'/g, "'\\''") + "'"
    function refresh() {
        if (pending) return;
        pending = true;
        reader.connectSource(command);
    }
    Plasma5Support.DataSource {
        id: reader
        engine: "executable"
        connectedSources: []
        onNewData: function(sourceName, data) {
            disconnectSource(sourceName);
            root.pending = false;
            try {
                if (data["exit code"] !== 0) throw new Error();
                var value = JSON.parse(data.stdout);
                if (value.schema !== 1) throw new Error();
                root.connectionStatus = value.status;
                if (Translations.catalog[value.language]) root.language = value.language;
                if (value.status === "ready") root.snapshot = value.snapshot;
                else if (value.status === "locked") root.snapshot = null;
            } catch (error) { root.connectionStatus = "unavailable"; }
        }
    }
    Timer { interval: 60000; running: true; repeat: true; triggeredOnStart: true; onTriggered: root.refresh() }
    fullRepresentation: AccountView {
        Layout.minimumWidth: 320
        Layout.minimumHeight: 300
        Layout.preferredWidth: root.inPanel ? 560 : 780
        Layout.preferredHeight: root.inPanel ? 680 : 840
        implicitWidth: Layout.preferredWidth
        implicitHeight: Layout.preferredHeight
        snapshot: root.snapshot
        language: root.language
        connectionStatus: root.connectionStatus
        favorites: Plasmoid.configuration.favorites
        accountView: Plasmoid.configuration.view
        provider: Plasmoid.configuration.provider
        textScale: Plasmoid.configuration.scale
        onRefreshRequested: root.refresh()
        onPreferencesChanged: function(favorites, accountView, provider, scale) {
            Plasmoid.configuration.favorites = favorites;
            Plasmoid.configuration.view = accountView;
            Plasmoid.configuration.provider = provider;
            Plasmoid.configuration.scale = scale;
        }
    }
}
