pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.plasmoid
import org.kde.plasma.plasma5support as Plasma5Support
import org.kde.taskmanager as TaskManager
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
    property bool launchPending: false
    property string launchError: ""
    readonly property string launchHelper: decodeURIComponent(Qt.resolvedUrl("../code/open_dashboard.py").toString().replace(/^file:\/\//, ""))
    readonly property string launchCommand: "/usr/bin/python3 -I '" + launchHelper.replace(/'/g, "'\\''") + "'"
    function plasmaText(key) {
        return key ? (Translations.catalog[language] || Translations.catalog.en).plasma[key] : "";
    }
    function activateDashboardTask() {
        // Plasma may activate an existing Wayland surface on the user's behalf;
        // Electron alone cannot take focus from another application on Wayland.
        for (var row = 0; row < dashboardTasks.count; row++) {
            var index = dashboardTasks.makeModelIndex(row);
            var appId = String(dashboardTasks.data(index, TaskManager.AbstractTasksModel.AppId)).toLowerCase().replace(/\.desktop$/, "");
            if (dashboardTasks.data(index, Qt.DisplayRole) === "LLM Usage Dashboard" &&
                    appId === "local.llm-usage-dashboard.plasma-launcher" &&
                    dashboardTasks.data(index, TaskManager.AbstractTasksModel.IsWindow) &&
                    !dashboardTasks.data(index, TaskManager.AbstractTasksModel.SkipTaskbar)) {
                dashboardTasks.requestActivate(index);
                return true;
            }
        }
        return false;
    }
    function openDashboard() {
        if (launchPending) return;
        launchError = "";
        if (activateDashboardTask()) return;
        launchPending = true;
        launcher.connectSource(launchCommand);
    }
    TaskManager.TasksModel { id: dashboardTasks; groupMode: TaskManager.TasksModel.GroupDisabled }
    Plasmoid.contextualActions: [
        PlasmaCore.Action {
            text: root.plasmaText("openDashboard")
            icon.name: "utilities-system-monitor"
            enabled: !root.launchPending
            onTriggered: root.openDashboard()
        }
    ]
    Plasma5Support.DataSource {
        id: launcher
        engine: "executable"
        connectedSources: []
        onNewData: function(sourceName, data) {
            disconnectSource(sourceName);
            root.launchPending = false;
            try {
                if (data["exit code"] !== 0) throw new Error();
                var result = JSON.parse(data.stdout);
                if (result.schema !== 1 || result.status !== "started") {
                    root.launchError = result.schema === 1 && result.status === "missing" ? "dashboardMissing" : "dashboardLaunchError";
                }
            } catch (error) { root.launchError = "dashboardLaunchError"; }
            if (root.launchError && root.inPanel) root.expanded = true;
        }
    }
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
        launchError: root.plasmaText(root.launchError)
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
