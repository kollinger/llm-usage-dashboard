import QtQuick
import QtTest
import "../../dist/plasma/package/contents/ui" as Native
import "../../dist/plasma/Fixtures.js" as Fixtures

TestCase {
    id: test
    name: "PlasmaAccountView"
    width: 780
    height: 840
    visible: true
    when: windowShown
    Native.AccountView {
        id: accountView
        anchors.fill: parent
        onPreferencesChanged: function(favorites, accountView, provider, scale) {
            this.favorites = favorites; this.accountView = accountView; this.provider = provider; this.textScale = scale;
        }
    }
    function init() {
        test.width = 780; test.height = 840;
        accountView.language = "en"; accountView.connectionStatus = "ready";
        accountView.favorites = []; accountView.accountView = "all"; accountView.provider = "all"; accountView.textScale = 1;
        accountView.snapshot = Fixtures.cases[5];
        waitForRendering(accountView);
    }
    function list() { return findChild(accountView, "accountList"); }
    function capture(name) {
        if (Fixtures.screenshots) grabImage(accountView).save(Fixtures.screenshots + "/" + name + ".png");
    }
    function test_counts() {
        [0, 1, 5, 12, 80].forEach(function(count) {
            accountView.snapshot = Fixtures.cases[count];
            tryCompare(list(), "count", Math.min(count, 50));
            wait(80); waitForRendering(accountView);
        });
        verify(findChild(accountView, "accountCount").text.indexOf("50") >= 0);
        verify(list().contentHeight > list().height);
    }
    function test_five_visible() {
        tryCompare(list(), "count", 5);
        waitForRendering(accountView);
        verify(list().contentHeight <= list().height + 1, "Five complete account rows must fit at the default desktop size: " + list().contentHeight + "/" + list().height);
        capture("five-accounts");
        compare(findChild(accountView, "remaining0_0").text, "0.0% left");
        compare(findChild(accountView, "remaining1_1").text, "—");
        compare(findChild(accountView, "quality1_1").text, "Not available");
        verify(findChild(accountView, "accountName1").truncated, "long account name gets a tooltip and separate ordinal");
    }
    function test_filters_favorites() {
        mouseClick(findChild(accountView, "favorite0"));
        compare(accountView.favorites.length, 1);
        mouseClick(findChild(accountView, "favoritesButton"));
        tryCompare(list(), "count", 1);
        mouseClick(findChild(accountView, "favorite0"));
        tryCompare(list(), "count", 0);
        mouseClick(findChild(accountView, "allButton"));
        tryCompare(list(), "count", 5);
        accountView.provider = "gpt";
        tryCompare(list(), "count", 2);
        accountView.provider = "all";
        tryCompare(list(), "count", 5);
    }
    function test_resize_scale_rtl() {
        accountView.language = "de";
        for (var cycle = 0; cycle < 2; cycle++) {
            test.width = 320; test.height = 340; accountView.textScale = 1.3;
            wait(80); waitForRendering(accountView);
            verify(list().width <= test.width);
            verify(list().height > 0);
            verify(list().contentHeight > list().height);
            test.width = 780; test.height = 840; accountView.textScale = 1;
            waitForRendering(accountView);
            verify(list().contentHeight <= list().height + 1);
        }
        capture("german-five");
        accountView.language = "ar"; accountView.textScale = 1.3; test.width = 560;
        waitForRendering(accountView);
        verify(accountView.rtl);
        verify(findChild(accountView, "accountCount").text.indexOf("حساب") >= 0);
        capture("arabic-scaled");
    }
    function test_connection_states() {
        accountView.connectionStatus = "unavailable";
        tryVerify(function() { return findChild(accountView, "quality0_0").text.indexOf("Stale") >= 0; });
        verify(findChild(accountView, "connectionNotice").visible);
        capture("offline-stale");
        accountView.connectionStatus = "locked"; accountView.snapshot = null;
        tryCompare(list(), "count", 0);
        verify(!findChild(accountView, "accountCount").visible, "missing snapshot must not claim zero accounts");
        accountView.connectionStatus = "ready"; accountView.snapshot = Fixtures.cases[5];
        tryCompare(list(), "count", 5);
        tryCompare(findChild(accountView, "quality0_0"), "text", "Measured");
    }
}
