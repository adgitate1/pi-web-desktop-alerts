/**
 * Drives the real plugin module through PI WEB's realtime frame shapes with
 * browser globals stubbed, so the alert logic is verifiable without a browser.
 *
 *   node --test ~/.pi-web/plugins/desktop-alerts/dev/plugin.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginFile = join(dirname(dirname(fileURLToPath(import.meta.url))), "pi-web-plugin.js");
const INTERVENTION_FLAG = "core:intervention-required";

/* --------------------------------------------------------------- fake browser */

class FakeNotification {
    static permission = "granted";
    static instances = [];
    static requests = 0;
    static rejectNext = false;
    static reset() {
        FakeNotification.permission = "granted";
        FakeNotification.instances = [];
        FakeNotification.requests = 0;
        FakeNotification.rejectNext = false;
    }
    static async requestPermission() {
        FakeNotification.requests += 1;
        if (FakeNotification.rejectNext) {
            FakeNotification.rejectNext = false;
            throw new Error("Blocked by policy");
        }
        // A real prompt can only turn "default" into an explicit decision;
        // "denied" is never re-prompted by the browser.
        if (FakeNotification.permission === "default")
            FakeNotification.permission = "granted";
        return FakeNotification.permission;
    }
    constructor(title, options) {
        this.title = title;
        this.options = options;
        this.closed = false;
        FakeNotification.instances.push(this);
    }
    close() {
        this.closed = true;
    }
}

class FakeWebSocket {
    static instances = [];
    constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.closed = false;
        this.readyState = 0;
        this.binaryType = "blob";
        FakeWebSocket.instances.push(this);
    }
    addEventListener(type, listener) {
        const existing = this.listeners.get(type) ?? [];
        existing.push(listener);
        this.listeners.set(type, existing);
    }
    emit(type, event) {
        for (const listener of this.listeners.get(type) ?? [])
            listener(event);
    }
    open() {
        this.readyState = 1;
        this.emit("open", {});
    }
    push(frame) {
        this.emit("message", { data: JSON.stringify(frame) });
    }
    pushRaw(data) {
        this.emit("message", { data });
    }
    /** The real transport: the web tier forwards frames as binary buffers. */
    pushBinary(frame) {
        this.emit("message", { data: new TextEncoder().encode(JSON.stringify(frame)).buffer });
    }
    pushBlob(frame) {
        this.emit("message", { data: new Blob([JSON.stringify(frame)], { type: "application/json" }) });
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.readyState = 3;
        this.emit("close", {});
    }
}

class FakeStorage {
    constructor() {
        this.map = new Map();
    }
    getItem(key) {
        return this.map.has(key) ? this.map.get(key) : null;
    }
    setItem(key, value) {
        this.map.set(key, String(value));
    }
}

function installBrowser({ permission = "granted", hidden = true, focused = false, secure = true, names = true } = {}) {
    FakeNotification.reset();
    FakeNotification.permission = permission;
    FakeWebSocket.instances = [];
    const focusCalls = { count: 0 };
    const browser = {
        storage: new FakeStorage(),
        focusCalls,
        setHidden(next) {
            globalThis.document.visibilityState = next ? "hidden" : "visible";
        },
        setFocused(next) {
            globalThis.document.hasFocus = () => next;
        },
    };
    globalThis.isSecureContext = secure;
    globalThis.Notification = permission === "unsupported" ? undefined : FakeNotification;
    globalThis.WebSocket = FakeWebSocket;
    globalThis.localStorage = browser.storage;
    globalThis.window = {
        focus() {
            focusCalls.count += 1;
        },
    };
    globalThis.document = {
        baseURI: "http://localhost:8504/",
        visibilityState: hidden ? "hidden" : "visible",
        hasFocus: () => focused,
    };
    globalThis.location = { href: "http://localhost:8504/" };
    browser.fetchCalls = [];
    const respond = (body) => ({ ok: true, status: 200, json: async () => body });
    const notFound = { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
    globalThis.fetch = async (url, init) => {
        const text = String(url);
        browser.fetchCalls.push(text);
        const path = `${new URL(text).pathname}${new URL(text).search}`;
        // Machine discovery always succeeds: these modes target name lookups.
        if (path === "/api/machines")
            return respond({ machines: [{ id: "local", kind: "local" }] });
        if (names === "stall") {
            // Hangs until the plugin's overall deadline aborts it.
            return new Promise((_resolve, reject) => {
                init?.signal?.addEventListener?.("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
            });
        }
        if (names === "slow")
            await new Promise((resolve) => setTimeout(resolve, 60));
        if (names === "ignore") {
            // Worst case: a request (or body read) that outlives the deadline and
            // never sees the abort.
            await new Promise((resolve) => setTimeout(resolve, 1800));
        }
        if (names === false)
            return notFound;
        // "enumerate" hides the daemon-owned location route, like an older gateway.
        if (names !== "enumerate" && /^\/api\/machines\/local\/sessions\/[^/]+\/location$/u.test(path))
            return respond({ sessionId: "session-a", projectId: "p1", workspaceId: "w1" });
        if (path === "/api/machines/local/projects")
            return respond([{ id: "p1", name: "Project", path: "/workspace" }]);
        if (path === "/api/machines/local/projects/p1/workspaces")
            return respond({ workspaces: [{ id: "w1", path: "/workspace" }] });
        if (path.startsWith("/api/machines/local/sessions?cwd="))
            return respond([{ id: "session-a", name: "Resolved conversation" }]);
        return notFound;
    };
    return browser;
}

/** Minimal PluginSelectionService: snapshot + subscribe, plus a test-only emit. */
function fakeSelection({ session } = {}) {
    const listeners = new Set();
    const service = {
        snapshot: { selectedMachine: { id: "local", kind: "local" }, ...(session === undefined ? {} : { selectedSession: session }) },
        getSnapshot() {
            return service.snapshot;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        emit(next) {
            service.snapshot = next;
            for (const listener of [...listeners])
                listener(next);
        },
        listenerCount: () => listeners.size,
    };
    return service;
}

const selected = (id, name) => ({ id, cwd: "/workspace", name, archived: false, pending: false });

/** Bare asks resolve a missing conversation name before showing: let that drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let importCounter = 0;

/** Activate a fresh module instance and hand back its first realtime socket. */
async function activatePlugin(options) {
    const browser = installBrowser(options);
    const module = await import(`${pathToFileURL(pluginFile).href}?case=${importCounter++}`);
    const controller = new AbortController();
    const result = await module.default.activate({
        apiVersion: 5,
        pluginId: "desktop-alerts",
        runtimePluginId: "desktop-alerts",
        lifetimeSignal: controller.signal,
        signal: controller.signal,
        ...(options?.selection === undefined ? {} : { selection: options.selection }),
    });
    // Discovery is fire-and-forget: let the fetch resolve, then take the socket.
    for (let tick = 0; tick < 5 && FakeWebSocket.instances.length === 0; tick += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(FakeWebSocket.instances.length, 1, "one realtime socket per machine");
    const socket = FakeWebSocket.instances[0];
    assert.match(socket.url, /^ws:\/\/localhost:8504\/api\/machines\/local\/events$/u);
    socket.open();
    return { browser, controller, result, socket, module };
}

const joinFrame = (sessions = {}) => ({
    type: "machine.status",
    status: { epochId: "e", revision: 1, generatedAt: "now", machine: {}, projects: {}, workspaces: {}, unattributed: {}, sessions },
});

const statusFrame = (sessionId, { intervention = false, dialogs = [], name } = {}) => ({
    type: "status.update",
    status: {
        sessionId,
        interventionRequired: intervention,
        ...(dialogs.length === 0 ? {} : { pendingDialogs: dialogs }),
        ...(name === undefined ? {} : { name }),
    },
});

const dialog = (dialogId, title) => ({ dialogId, kind: "select", title, askedAt: "2026-11-24T00:00:00.000Z" });

/** The realtime frame PI WEB publishes when a run settles (unread dot) or clears. */
const unreadFrame = (sessionId, { unread = true, cwd = "/workspace" } = {}) => ({
    type: "sessions.unread",
    catalogId: "catalog-1",
    catalogRevision: 1,
    sessionId,
    cwd,
    unread: unread ? { sessionId, cwd, completionOrder: 1, completedAt: "2026-11-24T00:00:00.000Z" } : null,
});

/* --------------------------------------------------------------------- tests */

test("an intervention that arrives while the tab is away pops one notification", async () => {
    const { socket } = await activatePlugin({ hidden: true, focused: false });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    assert.equal(FakeNotification.instances.length, 1);
    assert.equal(FakeNotification.instances[0].title, "PI WEB — input needed");
    assert.match(FakeNotification.instances[0].options.body, /Resolved conversation/u);
    assert.match(FakeNotification.instances[0].options.body, /Waiting for your answer/u);
    assert.equal(FakeNotification.instances[0].options.tag, "pi-web:local:session-a");
});

test("repeated frames and duplicate dialog ids never re-notify", async () => {
    const { socket } = await activatePlugin();
    socket.push(joinFrame());
    const frame = statusFrame("session-a", { intervention: true, dialogs: [dialog("d1", "Sandbox permission required")] });
    socket.push(frame);
    socket.push(frame);
    socket.push(frame);
    assert.equal(FakeNotification.instances.length, 1, "one prompt is one alert");
});

test("a dialog added to a flagged session is its own alert, named after the addition", async () => {
    const { socket } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d1", "First")] }));
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d1", "First"), dialog("d2", "Second")] }));
    assert.equal(FakeNotification.instances.length, 2);
    assert.match(FakeNotification.instances[1].options.body, /Second/u, "the newly added dialog is the news");
    assert.doesNotMatch(FakeNotification.instances[1].options.body, /First/u);
});

test("closing one of two dialogs is not a new request", async () => {
    const { socket } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d1", "First"), dialog("d2", "Second")] }));
    assert.equal(FakeNotification.instances.length, 1);
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d2", "Second")] }));
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [] }));
    assert.equal(FakeNotification.instances.length, 1, "removals are not news");
});

test("a replaced dialog alerts for the replacement, not the survivor", async () => {
    const { socket } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d1", "First")] }));
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d1", "First"), dialog("d3", "Replacement")] }));
    assert.equal(FakeNotification.instances.length, 2);
    assert.match(FakeNotification.instances[1].options.body, /Replacement/u);
});

test("a cleared intervention re-arms the session for the next prompt", async () => {
    // A known name keeps these alerts synchronous, so this measures clearing,
    // not lookup timing.
    const { socket } = await activatePlugin({ selection: fakeSelection({ session: selected("session-a", "Known") }) });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    socket.push(statusFrame("session-a", { intervention: false }));
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    assert.equal(FakeNotification.instances.length, 2);
});

test("nothing pops while PI WEB is visible and focused", async () => {
    const { socket, result } = await activatePlugin({ hidden: false, focused: true });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    assert.equal(FakeNotification.instances.length, 0);

    // The palette toggle turns "always" on; the next distinct prompt alerts.
    const toggle = result.contributions.actions.find((action) => action.id === "toggle-always");
    await toggle.run({});
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d9", "Later")] }));
    assert.equal(FakeNotification.instances.length, 1);
});

test("a reconnect snapshot is a baseline, not a replay", async () => {
    const { socket } = await activatePlugin();
    socket.push(joinFrame({ "session-a": { [INTERVENTION_FLAG]: true }, "session-b": { "core:working": true } }));
    socket.push(statusFrame("session-a", { intervention: true }));
    assert.equal(FakeNotification.instances.length, 0, "already-waiting prompt adopted silently");

    socket.push(statusFrame("session-a", { intervention: false }));
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    assert.equal(FakeNotification.instances.length, 1, "a genuinely new prompt still alerts");

    // A session flagged only as working seeds nothing.
    socket.push(statusFrame("session-b", { intervention: true }));
    await settle();
    assert.equal(FakeNotification.instances.length, 2);
});

test("dialogs beyond the first are counted, and the title is shown by default", async () => {
    const { socket } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", {
        intervention: true,
        dialogs: [dialog("d1", "Allow  example.test?"), dialog("d2", "Second")],
    }));
    const body = FakeNotification.instances[0].options.body;
    assert.match(body, /Allow example\.test\?/u);
    assert.match(body, /2 dialogs are waiting/u);
});

test("a long dialog title is shortened at a word boundary, not mid-word", async () => {
    const { socket } = await activatePlugin();
    const long = `Add example.org to allowedDomains? Reason: ${"a fairly long reason sentence ".repeat(8)}`;
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d1", long)] }));
    const body = FakeNotification.instances[0].options.body;
    const [titleLine] = body.split("\n");
    assert.ok(titleLine.trimEnd().endsWith("…"), "the cut is marked");
    const withoutEllipsis = titleLine.slice(0, -1).trimEnd();
    assert.ok(long.startsWith(withoutEllipsis), "the kept text is a verbatim prefix");
    // The character that follows the kept prefix in the original must be a space,
    // which is what makes this a word boundary rather than a mid-word cut.
    assert.equal(long[withoutEllipsis.length], " ", "the cut lands on a space");
    assert.ok(titleLine.length <= 122, `title line stays short (got ${String(titleLine.length)})`);
    assert.match(titleLine, /Reason:/u, "the meaningful head of the title survives");
});

test("the conversation name is used when no dialog carries a title", async () => {
    const { socket } = await activatePlugin();
    socket.push(joinFrame());
    socket.push({ type: "session.name", sessionId: "session-a", name: "Rotate the staging credentials" });
    socket.push(statusFrame("session-a", { intervention: true }));
    assert.match(FakeNotification.instances[0].options.body, /Rotate the staging credentials/u);
    assert.doesNotMatch(FakeNotification.instances[0].options.body, /A conversation is waiting/u);
});

test("generic text hides every prompt detail when that toggle is set", async () => {
    const { socket, result } = await activatePlugin();
    const toggle = result.contributions.actions.find((action) => action.id === "toggle-context");
    await toggle.run({});
    socket.push(joinFrame());
    socket.push({ type: "session.name", sessionId: "session-a", name: "Secret conversation" });
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d1", "Blocked target: evil.example")] }));
    const body = FakeNotification.instances[0].options.body;
    assert.equal(body, "A conversation is waiting for your answer.");
    assert.doesNotMatch(body, /evil\.example/u);
    assert.doesNotMatch(body, /Secret conversation/u);
    assert.match(toggle.description, /generic text/u);
});

test("denied permission stays silent and the enable action reports it", async () => {
    const { socket, result } = await activatePlugin({ permission: "denied" });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    assert.equal(FakeNotification.instances.length, 0);
    const enable = result.contributions.actions.find((action) => action.id === "enable");
    assert.equal(enable.enabled(), false, "a denied page has nothing to ask for");
    assert.match(enable.disabledReason(), /Blocked in this browser/u);
    assert.equal(await enable.run({}), "denied");
    assert.equal(FakeNotification.requests, 0);
    assert.equal(FakeNotification.instances.length, 0);
});

test("an insecure page is treated as unsupported", async () => {
    const { socket, result } = await activatePlugin({ permission: "default", secure: false });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    assert.equal(FakeNotification.instances.length, 0);
    const enable = result.contributions.actions.find((action) => action.id === "enable");
    assert.equal(enable.enabled(), false);
    assert.match(enable.description, /https or localhost/u);
    await enable.run({});
    assert.equal(FakeNotification.requests, 0, "never asks from an insecure page");
});

test("a rejected permission promise is a quiet outcome, not a crash", async () => {
    const { result } = await activatePlugin({ permission: "default" });
    FakeNotification.rejectNext = true;
    const enable = result.contributions.actions.find((action) => action.id === "enable");
    assert.equal(await enable.run({}), "default", "the decision is still unset, quietly");
    assert.equal(FakeNotification.instances.length, 0, "no test alert without permission");
});

test("an unsupported page never asks and never alerts", async () => {
    const { socket, result } = await activatePlugin({ permission: "unsupported" });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    assert.equal(FakeNotification.instances.length, 0);
    const enable = result.contributions.actions.find((action) => action.id === "enable");
    assert.equal(enable.enabled(), false);
    assert.match(enable.disabledReason(), /https or localhost/u);
    await enable.run({});
    assert.equal(FakeNotification.requests, 0);
});

test("enabling asks inside the gesture and proves itself with a test alert", async () => {
    const { result } = await activatePlugin({ permission: "default" });
    const enable = result.contributions.actions.find((action) => action.id === "enable");
    assert.equal(enable.enabled(), true);
    assert.equal(await enable.run({}), "granted");
    assert.equal(FakeNotification.requests, 1);
    assert.equal(FakeNotification.instances.length, 1);
    assert.equal(FakeNotification.instances[0].options.tag, "pi-web:test");
    assert.equal(enable.enabled(), false, "the action disables itself once granted");
    assert.match(enable.disabledReason(), /already enabled/u);
});

test("diagnostics report the connection, the frames, and every counter", async () => {
    const { socket, result } = await activatePlugin();
    socket.push(joinFrame({ "session-a": { [INTERVENTION_FLAG]: true } }));
    socket.push(statusFrame("session-b", { intervention: true }));
    await settle();
    const copy = result.contributions.actions.find((action) => action.id === "diagnostics");
    const snapshot = JSON.parse(await copy.run({}));
    assert.equal(snapshot.channels.length, 1);
    assert.equal(snapshot.channels[0].machineId, "local");
    assert.equal(snapshot.channels[0].connection, "open");
    assert.equal(snapshot.channels[0].readyState, 1);
    assert.equal(snapshot.stats.socketsReady, 1);
    assert.match(snapshot.channels[0].url, /\/api\/machines\/local\/events$/u);
    assert.equal(snapshot.stats.frames["machine.status"], 1);
    assert.equal(snapshot.stats.frames["status.update"], 1);
    assert.equal(snapshot.stats.socketsOpened, 1);
    assert.equal(snapshot.stats.joins, 1);
    assert.equal(snapshot.stats.alertsShown, 1);
    assert.equal(snapshot.baselinedSessions, 1);
    assert.equal(snapshot.page.permission, "granted");
    assert.match(snapshot.version, /^\d+\.\d+\.\d+/u, "the snapshot names the version that produced it");
    assert.equal(snapshot.stopped, false);
});

test("the test action pops even while focused and leaves alert state alone", async () => {
    const { socket, result } = await activatePlugin({ hidden: false, focused: true });
    socket.push(joinFrame());
    const test = result.contributions.actions.find((action) => action.id === "test");
    assert.equal(test.enabled(), true, "granted permission enables the test");
    await test.run({});
    assert.equal(FakeNotification.instances.length, 1, "the away-only gate does not apply to a requested test");
    assert.equal(FakeNotification.instances[0].options.tag, "pi-web:test");

    // A test must not arm, clear, or baseline anything: with alerts-while-focused
    // on, the real prompt still alerts exactly once afterwards.
    await result.contributions.actions.find((action) => action.id === "toggle-always").run({});
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d1", "Real")] }));
    assert.equal(FakeNotification.instances.length, 2);
    assert.match(FakeNotification.instances[1].options.body, /Real/u);
});

test("the test action is unavailable until permission is granted", async () => {
    const { result } = await activatePlugin({ permission: "default" });
    const test = result.contributions.actions.find((action) => action.id === "test");
    assert.equal(test.enabled(), false);
    assert.match(test.disabledReason(), /Enable desktop alerts first/u);
});

test("the selected conversation's name reaches the alert body", async () => {
    const selection = fakeSelection({ session: selected("session-a", "Rotate the staging credentials") });
    const { socket, result } = await activatePlugin({ selection });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    assert.equal(FakeNotification.instances.length, 1);
    assert.match(FakeNotification.instances[0].options.body, /Rotate the staging credentials/u);
    assert.doesNotMatch(FakeNotification.instances[0].options.body, /A conversation is waiting/u);

    // Selection changes are remembered for later asks on that conversation.
    selection.emit({ selectedMachine: { id: "local", kind: "local" }, selectedSession: selected("session-b", "Later conversation") });
    socket.push(statusFrame("session-b", { intervention: true }));
    assert.match(FakeNotification.instances[1].options.body, /Later conversation/u);

    assert.equal(selection.listenerCount(), 1);
    result.dispose(new AbortController().signal);
    assert.equal(selection.listenerCount(), 0, "dispose releases the selection subscription");
});

test("an ask whose conversation has no known name resolves it over HTTP", async () => {
    const { socket, browser } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    assert.equal(FakeNotification.instances.length, 1);
    assert.match(FakeNotification.instances[0].options.body, /Resolved conversation/u);
    assert.ok(browser.fetchCalls.some((url) => /\/sessions\/session-a\/location$/u.test(url)), "location resolved");
    assert.ok(browser.fetchCalls.some((url) => /\/projects\/p1\/workspaces$/u.test(url)), "workspace path resolved");
    assert.ok(browser.fetchCalls.some((url) => /sessions\?cwd=%2Fworkspace$/u.test(url)), "session list resolved");
});

test("a stalled lookup still releases the banner when the deadline expires", async () => {
    const { socket, result } = await activatePlugin({ names: "stall" });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    assert.equal(FakeNotification.instances.length, 0, "the lookup owns the wait");
    await new Promise((resolve) => setTimeout(resolve, 1750));
    assert.equal(FakeNotification.instances.length, 1, "the deadline releases a generic banner");
    assert.equal(FakeNotification.instances[0].options.body, "A conversation is waiting for your answer.");
    const copy = result.contributions.actions.find((action) => action.id === "diagnostics");
    const snapshot = JSON.parse(await copy.run({}));
    assert.ok(snapshot.stats.nameLookupFailures >= 1);
    assert.equal(snapshot.stats.alertsShown, 1);
});

test("a prompt answered during the lookup never pops a stale banner", async () => {
    const { socket, result } = await activatePlugin({ names: "slow" });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    // Answered while the name lookup is still in flight.
    socket.push(statusFrame("session-a", { intervention: false }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(FakeNotification.instances.length, 0);
    const copy = result.contributions.actions.find((action) => action.id === "diagnostics");
    const snapshot = JSON.parse(await copy.run({}));
    assert.equal(snapshot.stats.droppedLateAlerts, 1);
    assert.equal(snapshot.stats.alertsShown, 0);
});

test("a lookup that ignores abort still releases the banner at the deadline, exactly once", async () => {
    const { socket } = await activatePlugin({ names: "ignore" });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    assert.equal(FakeNotification.instances.length, 0, "still inside the deadline");
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.equal(FakeNotification.instances.length, 1, "the race releases it regardless");
    assert.equal(FakeNotification.instances[0].options.body, "A conversation is waiting for your answer.");
    // The abandoned request resolves afterwards and must not pop a second banner.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(FakeNotification.instances.length, 1, "the late result is discarded");
});

test("a suppressed newer prompt still supersedes an in-flight lookup", async () => {
    const { socket, browser, result } = await activatePlugin({ names: "slow" });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    // The user comes back to the app, then a newer prompt arrives while the first
    // lookup is still running: the newer alert is suppressed, but it must still
    // cancel the older one.
    browser.setHidden(false);
    browser.setFocused(true);
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d8", "Suppressed dialog")] }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(FakeNotification.instances.length, 0);
    const copy = result.contributions.actions.find((action) => action.id === "diagnostics");
    const snapshot = JSON.parse(await copy.run({}));
    assert.equal(snapshot.stats.droppedLateAlerts, 1);
    assert.equal(snapshot.stats.suppressedAwayOnly, 1);
});

test("a newer alert supersedes an in-flight lookup for the same conversation", async () => {
    const { socket, result } = await activatePlugin({ names: "slow" });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    // A dialog joins the same conversation while the bare ask's lookup is running.
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d7", "Newer dialog")] }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(FakeNotification.instances.length, 1, "only the newer prompt is announced");
    assert.match(FakeNotification.instances[0].options.body, /Newer dialog/u);
    const copy = result.contributions.actions.find((action) => action.id === "diagnostics");
    const snapshot = JSON.parse(await copy.run({}));
    assert.equal(snapshot.stats.droppedLateAlerts, 1);
});

test("the session list is fetched once for repeated asks in one workspace", async () => {
    const { socket, browser } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    socket.push(statusFrame("session-b", { intervention: true }));
    await settle();
    const sessionLists = browser.fetchCalls.filter((url) => /sessions\?cwd=/u.test(url));
    assert.equal(sessionLists.length, 1, "cached by cwd");
    assert.equal(FakeNotification.instances.length, 2);
});

test("a failed name lookup still alerts, with generic text", async () => {
    const { socket, result } = await activatePlugin({ names: false });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    assert.equal(FakeNotification.instances.length, 1, "the banner is never lost to a lookup");
    assert.equal(FakeNotification.instances[0].options.body, "A conversation is waiting for your answer.");
    const copy = result.contributions.actions.find((action) => action.id === "diagnostics");
    const snapshot = JSON.parse(await copy.run({}));
    assert.equal(snapshot.stats.nameLookupFailures, 1);
    assert.equal(snapshot.stats.alertsShown, 1);
});

test("without the location route, the catalog enumeration still names the conversation", async () => {
    const { socket, browser } = await activatePlugin({ names: "enumerate" });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    assert.equal(FakeNotification.instances.length, 1);
    assert.match(FakeNotification.instances[0].options.body, /Resolved conversation/u);
    assert.ok(browser.fetchCalls.some((url) => /\/sessions\/session-a\/location$/u.test(url)), "tried the cheap route first");
    assert.ok(browser.fetchCalls.some((url) => /\/projects$/u.test(url)), "enumerated projects");
    assert.ok(browser.fetchCalls.some((url) => /\/projects\/p1\/workspaces$/u.test(url)), "enumerated workspaces");
});

test("every failed lookup leg is recorded with its URL and status", async () => {
    const { socket, result } = await activatePlugin({ names: false });
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    await settle();
    const copy = result.contributions.actions.find((action) => action.id === "diagnostics");
    const snapshot = JSON.parse(await copy.run({}));
    const failures = snapshot.log.filter((entry) => entry.event === "http failed");
    assert.ok(failures.length > 0, "failures are visible in the log");
    assert.equal(failures[0].status, 404);
    assert.match(failures[0].url, /location$/u);
});

test("a dialog title needs no name lookup at all", async () => {
    const { socket, browser } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d1", "Sandbox permission required")] }));
    assert.equal(FakeNotification.instances.length, 1, "shown in the same task");
    assert.equal(browser.fetchCalls.filter((url) => /location$/u.test(url)).length, 0);
});

test("a finished run notifies, named from the frame's cwd", async () => {
    const { socket, browser } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(unreadFrame("session-a"));
    await settle();
    assert.equal(FakeNotification.instances.length, 1);
    assert.equal(FakeNotification.instances[0].title, "PI WEB — run finished");
    assert.equal(FakeNotification.instances[0].options.tag, "pi-web:done:local:session-a");
    assert.match(FakeNotification.instances[0].options.body, /Resolved conversation/u);
    assert.match(FakeNotification.instances[0].options.body, /finished\./u);
    // One cached call, from the cwd in the frame — no location chain.
    assert.ok(browser.fetchCalls.some((url) => /sessions\?cwd=%2Fworkspace$/u.test(url)));
    assert.equal(browser.fetchCalls.filter((url) => /location$/u.test(url)).length, 0);
});

test("an acknowledgement (unread: null) is not a finished run", async () => {
    const { socket } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(unreadFrame("session-a", { unread: false }));
    await settle();
    assert.equal(FakeNotification.instances.length, 0);
});

test("the run-finished alert is toggleable, and off means off", async () => {
    const { socket, result } = await activatePlugin();
    const toggle = result.contributions.actions.find((action) => action.id === "toggle-finished");
    assert.match(toggle.description, /Currently notifying/u, "on by default");
    await toggle.run({});
    assert.match(toggle.description, /Currently silent/u);
    socket.push(joinFrame());
    socket.push(unreadFrame("session-a"));
    await settle();
    assert.equal(FakeNotification.instances.length, 0);
});

test("a run that ended by asking is not also announced as finished", async () => {
    const { socket, result } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));   // the wait
    socket.push(unreadFrame("session-a"));                          // the settle
    await settle();
    assert.equal(FakeNotification.instances.length, 1, "only the input alert");
    assert.equal(FakeNotification.instances[0].title, "PI WEB — input needed");
    const copy = result.contributions.actions.find((action) => action.id === "diagnostics");
    const snapshot = JSON.parse(await copy.run({}));
    assert.equal(snapshot.stats.finishedSkippedWaiting, 1);
});

test("finished alerts obey the away-only gate and the generic-text toggle", async () => {
    const { socket, result, browser } = await activatePlugin({ hidden: false, focused: true });
    socket.push(joinFrame());
    socket.push(unreadFrame("session-a"));
    await settle();
    assert.equal(FakeNotification.instances.length, 0);
    let copy = result.contributions.actions.find((action) => action.id === "diagnostics");
    assert.equal(JSON.parse(await copy.run({})).stats.finishedSuppressedAwayOnly, 1);

    await result.contributions.actions.find((action) => action.id === "toggle-always").run({});
    await result.contributions.actions.find((action) => action.id === "toggle-context").run({});
    browser.setHidden(true);
    socket.push(unreadFrame("session-a"));
    await settle();
    assert.equal(FakeNotification.instances.length, 1);
    assert.equal(FakeNotification.instances[0].options.body, "A conversation finished a run.");
});

test("a finished notification focuses on click and closes", async () => {
    const { socket, browser } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(unreadFrame("session-a"));
    await settle();
    FakeNotification.instances[0].onclick();
    assert.equal(browser.focusCalls.count, 1);
    assert.equal(FakeNotification.instances[0].closed, true);
});

test("the reported version matches package.json, and the package is publishable", async () => {
    const pkg = JSON.parse(readFileSync(join(dirname(pluginFile), "package.json"), "utf8"));
    const { result } = await activatePlugin();
    const copy = result.contributions.actions.find((action) => action.id === "diagnostics");
    const snapshot = JSON.parse(await copy.run({}));
    assert.equal(snapshot.version, pkg.version, "VERSION must track the published version");
    assert.notEqual(pkg.private, true, "a private package cannot be published");
    assert.equal(pkg.piWeb.plugins[0].id, "desktop-alerts");
    assert.equal(pkg.piWeb.plugins[0].module, "pi-web-plugin.js");
    for (const keyword of ["pi-web.dev-plugin", "pi-package"])
        assert.ok(pkg.keywords.includes(keyword), `missing required keyword ${keyword}`);
    assert.equal(pkg.license, "MIT");
    assert.ok(Array.isArray(pkg.files) && pkg.files.includes("pi-web-plugin.js"));
});

test("binary frames are decoded, not dropped (the web tier sends buffers)", async () => {
    const { socket } = await activatePlugin();
    assert.equal(socket.binaryType, "arraybuffer", "the plugin asks the browser for buffers");
    socket.pushBinary(joinFrame());
    socket.pushBinary(statusFrame("session-a", { intervention: true, dialogs: [dialog("d1", "Binary")] }));
    assert.equal(FakeNotification.instances.length, 1);
    assert.match(FakeNotification.instances[0].options.body, /Binary/u);
});

test("a Blob frame still lands, in order", async () => {
    const { socket } = await activatePlugin();
    socket.pushBlob(joinFrame());
    socket.pushBlob(statusFrame("session-a", { intervention: true }));
    // Blob decoding is the only asynchronous path; let the queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(FakeNotification.instances.length, 1);
});

test("a click focuses PI WEB and closes only that notification", async () => {
    const { socket, browser, result } = await activatePlugin();
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    socket.push(statusFrame("session-b", { intervention: true }));
    await settle();
    const [first, second] = FakeNotification.instances;
    assert.equal(FakeNotification.instances.length, 2);
    first.onclick();
    assert.equal(browser.focusCalls.count, 1);
    assert.equal(first.closed, true);
    assert.equal(second.closed, false);

    // The click is recorded, so a "nothing happened" report can be diagnosed.
    const copy = result.contributions.actions.find((action) => action.id === "diagnostics");
    const snapshot = JSON.parse(await copy.run({}));
    assert.equal(snapshot.stats.clicks, 1);
    assert.ok(snapshot.log.some((entry) => entry.event === "notification clicked"));
});

test("malformed frames are ignored without throwing", async () => {
    const { socket } = await activatePlugin();
    socket.pushRaw("not json");
    socket.pushRaw("null");
    socket.push({ type: "status.update", status: null });
    socket.push({ type: "status.update", status: { sessionId: "", interventionRequired: true } });
    socket.push({ type: "something.else" });
    socket.push({ type: "machine.status", status: { sessions: { a: "nope" } } });
    assert.equal(FakeNotification.instances.length, 0);
});

test("dispose closes the socket and stops reconnecting", async () => {
    const { socket, result } = await activatePlugin();
    const before = FakeWebSocket.instances.length;
    result.dispose(new AbortController().signal);
    assert.equal(socket.closed, true);
    socket.push(joinFrame());
    socket.push(statusFrame("session-a", { intervention: true }));
    assert.equal(FakeNotification.instances.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(FakeWebSocket.instances.length, before, "no reconnect after dispose");
});

test("a dropped socket reconnects and baselines what it already knew", async () => {
    const { socket } = await activatePlugin();
    socket.push(joinFrame());
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(FakeWebSocket.instances.length, 2, "reconnected once");
    const second = FakeWebSocket.instances[1];
    second.open();
    second.push(joinFrame());
    assert.equal(FakeNotification.instances.length, 0);
});

test("a prompt that appeared while disconnected alerts once on reconnect", async () => {
    // Name lookups disabled: this asserts the generic fallback explicitly.
    const { socket } = await activatePlugin({ names: false });
    socket.push(joinFrame());
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = FakeWebSocket.instances[1];
    second.open();
    // The stream was down when this prompt opened, so no status.update announced
    // it; the join snapshot is the only evidence, and the replayed status frame
    // must not alert a second time.
    second.push(joinFrame({ "session-a": { [INTERVENTION_FLAG]: true } }));
    await settle();
    assert.equal(FakeNotification.instances.length, 1);
    assert.equal(FakeNotification.instances[0].options.body, "A conversation is waiting for your answer.");
    second.push(statusFrame("session-a", { intervention: true, dialogs: [dialog("d5", "Still waiting")] }));
    assert.equal(FakeNotification.instances.length, 1, "the baseline absorbs the replayed frame");
});
