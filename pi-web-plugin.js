/**
 * Desktop alerts — a browser-only PI WEB plugin.
 *
 * PI WEB already tracks "a conversation is waiting for a human" as a session
 * status fact: extension dialogs (`ctx.ui.select/confirm/input`), the `ask_user`
 * tool, and `request_human_intervention` all roll up into `interventionRequired`
 * and are published on the daemon's realtime stream. The browser has to be open for the
 * Web Notifications API to work, so this plugin subscribes to that same stream
 * over its own socket and asks the browser for a notification instead of
 * patching PI WEB's client bundle.
 *
 * Deviation from the public plugin API, and its cost: `status.update` and
 * `machine.status` frames are PI WEB's internal (unversioned) realtime contract,
 * not part of plugin-api.d.ts. If a future PI WEB changes those frame shapes,
 * this plugin goes quiet — PI WEB itself keeps working. Nothing here writes to
 * the session, answers a dialog, or grants a permission.
 */

const NOTIFICATION_TITLE = "PI WEB — input needed";
const FINISHED_TITLE = "PI WEB — run finished";
const FINISHED_BODY = "A conversation finished a run.";
const GENERIC_BODY = "A conversation is waiting for your answer.";
const INTERVENTION_FLAG = "core:intervention-required";
const MAX_DETAIL_LENGTH = 120;
/** Backoff for a dropped realtime socket; the last value repeats. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const STORAGE_KEYS = {
    /** "1" (default) puts the dialog title / conversation name in the body. */
    includeContext: "pi-web.desktop-alerts.include-context",
    /** "1" alerts even while PI WEB is visible and focused. Default: "0". */
    always: "pi-web.desktop-alerts.always",
    /** "1" (default) alerts when a run finishes, i.e. the session turns unread. */
    runFinished: "pi-web.desktop-alerts.run-finished",
};
const ACTION_GROUP = "Desktop alerts";
/**
 * Reported by the diagnostics so "did the browser actually load the new module?"
 * is answerable from the snapshot alone. Kept equal to package.json's version by
 * a test, because a published plugin has no build counter to point at.
 */
const VERSION = "1.0.0";

/* ------------------------------------------------------------------ storage */

function storageGet(key) {
    try {
        return globalThis.localStorage?.getItem(key) ?? null;
    }
    catch {
        return null;
    }
}

function storageSet(key, value) {
    try {
        globalThis.localStorage?.setItem(key, value);
    }
    catch {
        /* Private mode or a blocked storage partition: fall back to defaults. */
    }
}

function flag(key, fallback) {
    const raw = storageGet(key);
    return raw === null ? fallback : raw === "1";
}

function includeContext() {
    return flag(STORAGE_KEYS.includeContext, true);
}

function alertWhileFocused() {
    return flag(STORAGE_KEYS.always, false);
}

function runFinishedAlertsEnabled() {
    return flag(STORAGE_KEYS.runFinished, true);
}

/* ------------------------------------------------------- browser capability */

function notificationConstructor() {
    const ctor = globalThis.Notification;
    return typeof ctor === "function" ? ctor : undefined;
}

/**
 * One predicate for every capability question, so an insecure page (plain-http
 * LAN address) reports "unsupported" everywhere instead of offering a button
 * whose permission request would be refused.
 */
function supportsNotifications() {
    return notificationConstructor() !== undefined && globalThis.isSecureContext !== false;
}

function notificationPermission() {
    if (!supportsNotifications())
        return "unsupported";
    return notificationConstructor().permission;
}

function permissionDescription() {
    switch (notificationPermission()) {
        case "granted":
            return "Enabled. PI WEB shows a desktop notification when a conversation needs you.";
        case "denied":
            return "Blocked in this browser. Allow notifications for this site in the browser's site settings, then reload PI WEB.";
        case "unsupported":
            return "This page cannot request desktop notifications (they need https or localhost).";
        default:
            return "Choose this to ask the browser for notification permission; a test notification follows.";
    }
}

function userIsWatching() {
    const doc = globalThis.document;
    if (doc === undefined || doc === null)
        return false;
    if (doc.visibilityState === "hidden")
        return false;
    return typeof doc.hasFocus === "function" ? doc.hasFocus() : true;
}

function shouldAlert() {
    return alertWhileFocused() || !userIsWatching();
}

/* ---------------------------------------------------------- alert rendering */

function truncate(text) {
    const collapsed = text.replace(/\s+/gu, " ").trim();
    if (collapsed.length <= MAX_DETAIL_LENGTH)
        return collapsed;
    const cut = collapsed.slice(0, MAX_DETAIL_LENGTH - 1);
    const boundary = cut.lastIndexOf(" ");
    // Prefer a word boundary, unless that would throw away most of the text
    // (a long unbroken token such as a URL).
    const body = boundary > cut.length / 2 ? cut.slice(0, boundary) : cut;
    return `${body.trimEnd()}…`;
}

/**
 * What the waiting prompt says, in priority order. Extension dialogs carry their
 * own title (and sometimes a message); an `ask_user` question or a bare
 * intervention has neither, so it falls back to the conversation name and then
 * to generic text.
 */
function dialogLabel(dialog) {
    if (typeof dialog?.title === "string" && dialog.title.trim() !== "")
        return truncate(dialog.title);
    if (typeof dialog?.message === "string" && dialog.message.trim() !== "")
        return truncate(dialog.message);
    return "A dialog is waiting for an answer.";
}

function alertContent(sessionKey, names, news, dialogCount) {
    if (!includeContext())
        return { title: NOTIFICATION_TITLE, body: GENERIC_BODY };
    const details = [];
    const name = names.get(sessionKey);
    if (typeof name === "string" && name.trim() !== "")
        details.push(truncate(name));
    if (news !== undefined)
        details.push(dialogLabel(news));
    else if (dialogCount > 0)
        details.push("A dialog is waiting for an answer.");
    if (details.length === 0)
        return { title: NOTIFICATION_TITLE, body: GENERIC_BODY };
    const suffix = dialogCount > 1 ? ` ${String(dialogCount)} dialogs are waiting.` : "";
    return { title: NOTIFICATION_TITLE, body: `${details.join(" · ")}\nWaiting for your answer.${suffix}` };
}

function iconUrl() {
    try {
        const base = globalThis.document?.baseURI ?? globalThis.location?.href;
        if (typeof base !== "string")
            return undefined;
        return new URL("favicon.svg", base).href;
    }
    catch {
        return undefined;
    }
}

function showAlert(content, tag, onEvent) {
    const ctor = notificationConstructor();
    if (ctor === undefined || ctor.permission !== "granted")
        return undefined;
    let notification;
    try {
        notification = new ctor(content.title, {
            body: content.body,
            // One notification per conversation: a newer prompt replaces the
            // older banner instead of stacking, and `renotify` still re-surfaces
            // it.
            tag,
            renotify: true,
            requireInteraction: false,
            icon: iconUrl(),
        });
    }
    catch (error) {
        console.warn("Desktop alerts: the browser refused to show a notification", error);
        return undefined;
    }
    // Focus only. Never navigate, answer, or approve anything on a click.
    notification.onclick = () => {
        try {
            onEvent?.();
        }
        catch {
            /* Diagnostics must never break the click itself. */
        }
        try {
            globalThis.window?.focus?.();
        }
        catch {
            /* A browser may refuse to raise the window; the tab still activates. */
        }
        try {
            notification.close();
        }
        catch {
            /* Already dismissed by the platform. */
        }
    };
    return notification;
}

/* ----------------------------------------------------- realtime event logic */

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TEXT_DECODER = new TextDecoder();

/**
 * Frames do not always arrive as strings. PI WEB's web/API tier bridges the
 * daemon socket by forwarding raw buffers, so a browser receives BINARY frames,
 * and the app itself sets `binaryType = "arraybuffer"` for that reason. A
 * string-only guard therefore drops every frame — the socket looks connected and
 * simply never says anything.
 */
async function payloadText(data) {
    if (typeof data === "string")
        return data;
    if (data instanceof ArrayBuffer)
        return TEXT_DECODER.decode(data);
    if (ArrayBuffer.isView(data))
        return TEXT_DECODER.decode(data);
    // No binaryType support, or a Blob by an explicit choice.
    if (typeof data?.text === "function") {
        try {
            return await data.text();
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * Stable identity of one pending dialog. Real frames carry `dialogId`; the
 * composite fallback keeps an older or partial frame from looking like a new
 * dialog on every repeated update.
 */
function dialogId(dialog) {
    if (typeof dialog?.dialogId === "string" && dialog.dialogId !== "")
        return dialog.dialogId;
    const kind = typeof dialog?.kind === "string" ? dialog.kind : "dialog";
    const askedAt = typeof dialog?.askedAt === "string" ? dialog.askedAt : "";
    const title = typeof dialog?.title === "string" ? dialog.title : "";
    return askedAt === "" && title === "" && kind === "dialog" ? undefined : `${kind}:${askedAt}:${title}`;
}

function pendingDialogs(status) {
    return Array.isArray(status.pendingDialogs) ? status.pendingDialogs.filter(isRecord) : [];
}

/* ------------------------------------------------------- conversation names */

/**
 * A name for the alert body when no dialog title exists (`ask_user`,
 * `request_human_intervention`). Three cached, read-only GETs answer "which
 * conversation is this?" from a session id alone:
 *
 *   sessions/<id>/location        -> projectId, workspaceId
 *   projects/<id>/workspaces      -> workspace path for that workspaceId
 *   sessions?cwd=<path>           -> session list entries, which carry `name`
 *
 * Everything is best-effort and time-boxed: a failure means generic text, never
 * a missing or late notification.
 */
const NAME_LOOKUP_DEADLINE_MS = 1_500;
const CACHE_TTL = { location: 600_000, workspaces: 300_000, sessions: 60_000 };

function cacheRead(cache, key, ttl) {
    const hit = cache.get(key);
    if (hit === undefined)
        return undefined;
    if (Date.now() - hit.at > ttl) {
        cache.delete(key);
        return undefined;
    }
    return hit.value;
}

function cacheWrite(cache, key, value) {
    cache.set(key, { at: Date.now(), value });
    // Bounded: a long-lived page must not accumulate one entry per session.
    while (cache.size > 64) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined)
            break;
        cache.delete(oldest);
    }
}

/* ---------------------------------------------------------------- the plugin */

const plugin = {
    apiVersion: 5,
    name: "Desktop alerts",
    activate(context) {
        const state = {
            stopped: false,
            channels: new Map(),
            /**
             * `${machineId}\u0000${sessionId}` -> dialog ids that were pending the
             * last time this conversation was seen waiting. Comparing ids is what
             * separates "a dialog was added" from "a dialog was closed", and what
             * keeps a second dialog opened on an already-flagged conversation
             * from being swallowed.
             */
            sessions: new Map(),
            /** Conversations adopted from a join snapshot: alert state, no alert. */
            baseline: new Set(),
            /** sessionKey -> conversation name, learned from `session.name` frames. */
            names: new Map(),
            log: [],
            /** sessionKey -> the in-flight alert token, so a late lookup can bail. */
            pendingAlerts: new Map(),
            /** Same, for run-finished alerts (a different notification kind). */
            pendingFinished: new Map(),
            /**
             * Counters behind the "copy diagnostics" action. A plugin can look
             * installed and enabled while its socket never opened, so "is it
             * connected, and is it seeing realtime frames?" must be answerable
             * without a debugger.
             */
            stats: {
                activations: 0,
                disposals: 0,
                socketsOpened: 0,
                socketsReady: 0,
                socketsClosed: 0,
                lastCloseCode: undefined,
                lastError: undefined,
                joins: 0,
                lastJoinWaiting: 0,
                frames: {},
                alertsShown: 0,
                namesResolved: 0,
                droppedLateAlerts: 0,
                clicks: 0,
                finishedShown: 0,
                finishedSkippedWaiting: 0,
                finishedSuppressedAwayOnly: 0,
                finishedSuppressedPermission: 0,
                finishedDroppedLate: 0,
                nameLookupFailures: 0,
                alertFailures: 0,
                suppressedAwayOnly: 0,
                suppressedPermission: 0,
            },
        };
        state.stats.activations += 1;

        /**
         * Newest-last ring buffer of the decisions that matter when asking "why
         * did nothing pop?" after the fact: connection, join, a waiting status
         * frame, and the gate verdict for each alert attempt.
         */
        function note(event, detail = {}) {
            state.log.push({ at: new Date().toISOString(), event, ...detail });
            if (state.log.length > 60)
                state.log.shift();
        }
        note("activated");

        function sessionKey(machineId, sessionId) {
            return `${machineId}\u0000${sessionId}`;
        }

        const nameCaches = { location: new Map(), workspaces: new Map(), sessions: new Map(), projects: new Map() };

        function apiUrl(machineId, path) {
            const base = globalThis.document?.baseURI ?? globalThis.location?.href ?? "http://localhost/";
            return new URL(`api/machines/${encodeURIComponent(machineId)}/${path}`, base).toString();
        }

        /**
         * One GET, bounded by the caller's signal. The signal covers the whole
         * lookup, so a slow first leg cannot buy each remaining leg another
         * timeout.
         */
        async function request(url, signal) {
            const fetchImpl = globalThis.fetch;
            if (typeof fetchImpl !== "function")
                return {};
            if (signal?.aborted === true)
                return {};
            try {
                const response = await fetchImpl(url, {
                    credentials: "same-origin",
                    headers: { accept: "application/json" },
                    ...(signal === undefined ? {} : { signal }),
                });
                if (!response.ok) {
                    note("http failed", { url, status: response.status });
                    return {};
                }
                return { body: await response.json() };
            }
            catch (error) {
                note("http failed", { url, status: error instanceof Error ? error.name : "error" });
                return {};
            }
        }

        async function workspacesFor(machineId, projectId, signal) {
            const key = `${machineId}\u0000${projectId}`;
            const cached = cacheRead(nameCaches.workspaces, key, CACHE_TTL.workspaces);
            if (cached !== undefined)
                return cached;
            const { body } = await request(apiUrl(machineId, `projects/${encodeURIComponent(projectId)}/workspaces`), signal);
            if (!isRecord(body) || !Array.isArray(body.workspaces))
                return undefined;
            const workspaces = body.workspaces.filter((workspace) => isRecord(workspace) && typeof workspace.id === "string" && typeof workspace.path === "string");
            cacheWrite(nameCaches.workspaces, key, workspaces);
            return workspaces;
        }

        async function nameInWorkspace(machineId, cwd, sessionId, signal) {
            const key = `${machineId}\u0000${cwd}`;
            let sessions = cacheRead(nameCaches.sessions, key, CACHE_TTL.sessions);
            if (sessions === undefined) {
                const { body } = await request(apiUrl(machineId, `sessions?cwd=${encodeURIComponent(cwd)}`), signal);
                if (!Array.isArray(body))
                    return undefined;
                sessions = body.filter(isRecord);
                cacheWrite(nameCaches.sessions, key, sessions);
            }
            const entry = sessions.find((candidate) => candidate.id === sessionId);
            if (entry === undefined)
                return undefined;
            return typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name : undefined;
        }

        /** Cheap identity route: session -> project -> workspace path -> name. */
        async function nameFromLocation(machineId, sessionId, signal) {
            const key = sessionKey(machineId, sessionId);
            let location = cacheRead(nameCaches.location, key, CACHE_TTL.location);
            if (location === undefined) {
                const { body } = await request(apiUrl(machineId, `sessions/${encodeURIComponent(sessionId)}/location`), signal);
                if (!isRecord(body) || typeof body.projectId !== "string" || typeof body.workspaceId !== "string")
                    return undefined;
                location = { projectId: body.projectId, workspaceId: body.workspaceId };
                cacheWrite(nameCaches.location, key, location);
            }
            const workspaces = await workspacesFor(machineId, location.projectId, signal);
            if (workspaces === undefined)
                return undefined;
            const workspace = workspaces.find((candidate) => candidate.id === location.workspaceId);
            if (workspace === undefined)
                return undefined;
            return await nameInWorkspace(machineId, workspace.path, sessionId, signal);
        }

        async function projectIds(machineId, signal) {
            const key = `${machineId}\u0000projects`;
            const cached = cacheRead(nameCaches.projects, key, CACHE_TTL.workspaces);
            if (cached !== undefined)
                return cached;
            const { body } = await request(apiUrl(machineId, "projects"), signal);
            const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.projects) ? body.projects : undefined;
            if (list === undefined)
                return undefined;
            const ids = list
                .map((project) => (isRecord(project) && typeof project.id === "string" ? project.id : undefined))
                .filter((id) => id !== undefined);
            cacheWrite(nameCaches.projects, key, ids);
            return ids;
        }

        /**
         * Fallback for an older or partial gateway: `/sessions/:id/location` is
         * daemon-owned, so enumerate the registered projects and their workspaces
         * instead — the same catalog routes the app's own navigation uses — and
         * look for the session in each workspace's session list. All levels are
         * cached, so a warm page resolves a name with no additional requests.
         */
        /** The lookup itself: location first, then the catalog enumeration. */
        async function lookupWork(machineId, sessionId, signal) {
            const direct = await nameFromLocation(machineId, sessionId, signal);
            if (direct !== undefined)
                return direct;
            if (signal?.aborted === true)
                return undefined;
            const ids = await projectIds(machineId, signal);
            if (ids === undefined)
                return undefined;
            for (const projectId of ids) {
                if (signal?.aborted === true)
                    return undefined;
                const workspaces = await workspacesFor(machineId, projectId, signal);
                for (const workspace of workspaces ?? []) {
                    if (signal?.aborted === true)
                        return undefined;
                    const name = await nameInWorkspace(machineId, workspace.path, sessionId, signal);
                    if (name !== undefined)
                        return name;
                }
            }
            return undefined;
        }

        /**
         * One deadline for a whole lookup. The abort signal asks the request to
         * stop; the race guarantees a result (or `undefined`) at the deadline even
         * if a request ignores the signal entirely, and discards anything later.
         */
        async function withDeadline(work) {
            const controller = typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : undefined;
            const signal = controller?.signal;
            let raceTimer;
            const deadline = new Promise((resolve) => {
                raceTimer = setTimeout(() => {
                    controller?.abort();
                    resolve(undefined);
                }, NAME_LOOKUP_DEADLINE_MS);
            });
            try {
                return await Promise.race([work(signal), deadline]);
            }
            catch (error) {
                state.stats.lastError = error instanceof Error ? error.message : String(error);
                return undefined;
            }
            finally {
                clearTimeout(raceTimer);
            }
        }

        async function lookupName(machineId, sessionId) {
            return await withDeadline((signal) => lookupWork(machineId, sessionId, signal));
        }

        /** A `sessions.unread` frame carries `cwd`, so one cached list call names it. */
        async function lookupNameInCwd(machineId, cwd, sessionId) {
            return await withDeadline((signal) => nameInWorkspace(machineId, cwd, sessionId, signal));
        }

        function gateSuppression() {
            if (!shouldAlert())
                return "watching";
            if (notificationPermission() !== "granted")
                return "permission";
            return undefined;
        }

        function recordSuppression(reason, gate, suffix = "") {
            if (reason === "watching")
                state.stats.suppressedAwayOnly += 1;
            else
                state.stats.suppressedPermission += 1;
            note(`alert suppressed: ${reason}${suffix}`, gate);
        }

        /**
         * Gate synchronously, so a suppressed alert costs no work. A bare ask in a
         * conversation this page has no name for resolves that name first; every
         * other alert (a dialog title, a known name, generic mode) shows in the
         * same task. The await can only delay a banner, never silence one.
         */
        function alert(machineId, sessionId, news, dialogCount) {
            const gate = {
                machineId,
                sessionId,
                visibility: globalThis.document?.visibilityState,
                focused: typeof globalThis.document?.hasFocus === "function" ? globalThis.document.hasFocus() : undefined,
                permission: notificationPermission(),
                dialogs: dialogCount,
            };
            const key = sessionKey(machineId, sessionId);
            // Claimed before the gate: a newer prompt must supersede an older
            // in-flight lookup even when the newer alert is itself suppressed.
            const token = {};
            state.pendingAlerts.set(key, token);
            const suppression = gateSuppression();
            if (suppression !== undefined) {
                state.pendingAlerts.delete(key);
                recordSuppression(suppression, gate);
                return;
            }
            note("alert", gate);
            const show = () => {
                if (state.pendingAlerts.get(key) === token)
                    state.pendingAlerts.delete(key);
                // The tab may have come back during a lookup; nothing should pop
                // while the user is looking at the conversation.
                const late = gateSuppression();
                if (late !== undefined) {
                    recordSuppression(late, gate, " (after lookup)");
                    return;
                }
                state.stats.alertsShown += 1;
                const shown = showAlert(
                    alertContent(key, state.names, news, dialogCount),
                    `pi-web:${machineId}:${sessionId}`,
                    () => {
                        state.stats.clicks += 1;
                        note("notification clicked", { sessionId, visibility: globalThis.document?.visibilityState });
                    },
                );
                if (shown === undefined)
                    state.stats.alertFailures += 1;
            };
            if (news === undefined && includeContext() && !state.names.has(key)) {
                // A lookup that finishes after the prompt was answered, after a
                // newer prompt replaced it, or after the plugin was disposed must
                // not produce a stale banner.
                void lookupName(machineId, sessionId).then((resolved) => {
                    if (state.stopped) {
                        state.stats.droppedLateAlerts += 1;
                        return;
                    }
                    if (state.pendingAlerts.get(key) !== token) {
                        state.stats.droppedLateAlerts += 1;
                        note("alert dropped: superseded", { sessionId });
                        return;
                    }
                    state.pendingAlerts.delete(key);
                    // Waiting is either recorded from a status frame or adopted
                    // from a join snapshot; absent from both means it cleared.
                    if (!state.sessions.has(key) && !state.baseline.has(key)) {
                        state.stats.droppedLateAlerts += 1;
                        note("alert dropped: prompt cleared", { sessionId });
                        return;
                    }
                    if (resolved !== undefined) {
                        state.names.set(key, resolved);
                        state.stats.namesResolved += 1;
                        note("resolved name", { sessionId });
                    }
                    else {
                        state.stats.nameLookupFailures += 1;
                    }
                    show();
                });
                return;
            }
            show();
        }

        /**
         * A finished run. PI WEB marks a session unread exactly when its work
         * settles (that is the purple dot), and publishes a `sessions.unread`
         * mutation after the status frame that announced any wait — so a run that
         * ended *by asking* is skipped here: the input alert already covers it.
         */
        function alertFinished(machineId, sessionId, cwd) {
            const key = sessionKey(machineId, sessionId);
            if (!runFinishedAlertsEnabled()) {
                note("finished skipped: disabled", { sessionId });
                return;
            }
            if (state.sessions.has(key) || state.baseline.has(key)) {
                state.stats.finishedSkippedWaiting += 1;
                note("finished skipped: waiting for input", { sessionId });
                return;
            }
            const gate = {
                machineId,
                sessionId,
                visibility: globalThis.document?.visibilityState,
                focused: typeof globalThis.document?.hasFocus === "function" ? globalThis.document.hasFocus() : undefined,
                permission: notificationPermission(),
            };
            const token = {};
            state.pendingFinished.set(key, token);
            if (!shouldAlert()) {
                state.pendingFinished.delete(key);
                state.stats.finishedSuppressedAwayOnly += 1;
                note("finished suppressed: watching", gate);
                return;
            }
            if (notificationPermission() !== "granted") {
                state.pendingFinished.delete(key);
                state.stats.finishedSuppressedPermission += 1;
                note("finished suppressed: permission", gate);
                return;
            }
            const content = (name) => includeContext() && typeof name === "string" && name.trim() !== ""
                ? { title: FINISHED_TITLE, body: `${truncate(name)} — finished.` }
                : { title: FINISHED_TITLE, body: FINISHED_BODY };
            const show = (name) => {
                if (state.stopped) {
                    state.stats.finishedDroppedLate += 1;
                    return;
                }
                if (state.pendingFinished.get(key) !== token) {
                    state.stats.finishedDroppedLate += 1;
                    note("finished dropped: superseded", { sessionId });
                    return;
                }
                state.pendingFinished.delete(key);
                if (!shouldAlert()) {
                    state.stats.finishedSuppressedAwayOnly += 1;
                    note("finished suppressed: watching (after lookup)", gate);
                    return;
                }
                state.stats.finishedShown += 1;
                const shown = showAlert(content(name), `pi-web:done:${machineId}:${sessionId}`, () => {
                    state.stats.clicks += 1;
                    note("finished notification clicked", { sessionId });
                });
                if (shown === undefined)
                    state.stats.alertFailures += 1;
            };
            note("finished alert", gate);
            const knownName = state.names.get(key);
            if (!includeContext() || knownName !== undefined || typeof cwd !== "string" || cwd === "") {
                show(knownName);
                return;
            }
            void lookupNameInCwd(machineId, cwd, sessionId).then((name) => {
                if (name !== undefined)
                    state.names.set(key, name);
                show(name);
            });
        }

        function onStatusUpdate(machineId, status) {
            if (!isRecord(status))
                return;
            const sessionId = status.sessionId;
            if (typeof sessionId !== "string" || sessionId === "")
                return;
            const key = sessionKey(machineId, sessionId);
            if (status.interventionRequired !== true) {
                state.sessions.delete(key);
                state.baseline.delete(key);
                state.pendingAlerts.delete(key);
                return;
            }
            const dialogs = pendingDialogs(status);
            const previous = state.sessions.get(key);
            state.sessions.set(key, dialogs);
            // A join snapshot is a baseline, not news: adopt it silently so only
            // a later, different prompt pops up.
            if (state.baseline.delete(key))
                return;
            if (previous === undefined) {
                // The intervention edge itself: a new wait, dialog or ask.
                alert(machineId, sessionId, dialogs[0], dialogs.length);
                return;
            }
            // Only additions are news. Removals (a dialog answered or aborted)
            // and repeats are part of the prompt already announced.
            const known = new Set(previous.map(dialogId).filter((id) => id !== undefined));
            const added = dialogs.filter((dialog) => {
                const id = dialogId(dialog);
                return id === undefined || !known.has(id);
            });
            if (added.length === 0)
                return;
            alert(machineId, sessionId, added[0], dialogs.length);
        }

        /**
         * Join snapshots are baselines, with one deliberate exception. On the
         * first connection the page just loaded, so anything already waiting is
         * adopted silently. On a later reconnect, an unknown waiting conversation
         * may have appeared while the stream was down — nothing else will
         * announce it — so it alerts once, generically, and is then baselined so
         * the replayed `status.update` does not alert a second time. The snapshot
         * is also the authority on what is no longer waiting: state for
         * conversations this machine no longer flags is stale and must go, or a
         * later request would be compared against a dead dialog list.
         */
        function onJoinSnapshot(channel, snapshot) {
            const firstJoin = channel.joins === 0;
            channel.joins += 1;
            if (!isRecord(snapshot) || !isRecord(snapshot.sessions))
                return;
            const prefix = `${channel.machineId}\u0000`;
            const waiting = new Set();
            state.stats.joins += 1;
            for (const [sessionId, flags] of Object.entries(snapshot.sessions)) {
                if (!isRecord(flags) || flags[INTERVENTION_FLAG] !== true)
                    continue;
                const key = `${prefix}${sessionId}`;
                waiting.add(key);
                if (state.sessions.has(key) || state.baseline.has(key))
                    continue;
                state.baseline.add(key);
                if (!firstJoin)
                    alert(channel.machineId, sessionId, undefined, 0);
            }
            state.stats.lastJoinWaiting = waiting.size;
            note("join", { machineId: channel.machineId, waiting: waiting.size, firstJoin });
            for (const key of [...state.sessions.keys(), ...state.baseline.keys()]) {
                if (!key.startsWith(prefix) || waiting.has(key))
                    continue;
                state.sessions.delete(key);
                state.baseline.delete(key);
                state.pendingAlerts.delete(key);
            }
        }

        function handleFrame(channel, frame) {
            if (!isRecord(frame))
                return;
            const type = typeof frame.type === "string" ? frame.type : "unknown";
            state.stats.frames[type] = (state.stats.frames[type] ?? 0) + 1;
            switch (frame.type) {
                case "status.update":
                    if (isRecord(frame.status) && frame.status.interventionRequired === true)
                        note("waiting frame", { sessionId: frame.status.sessionId, dialogs: pendingDialogs(frame.status).length });
                    onStatusUpdate(channel.machineId, frame.status);
                    return;
                case "machine.status":
                    // Only the join frame of each connection reconciles state;
                    // later snapshots are per-change and must not clear alerts.
                    if (channel.joined)
                        return;
                    channel.joined = true;
                    onJoinSnapshot(channel, frame.status);
                    return;
                case "sessions.unread":
                    // `unread: null` is an acknowledgement (the dot cleared), not a
                    // finished run.
                    if (isRecord(frame.unread) && typeof frame.sessionId === "string")
                        alertFinished(channel.machineId, frame.sessionId, frame.cwd);
                    return;
                case "session.name":
                    if (typeof frame.sessionId === "string" && typeof frame.name === "string" && frame.name.trim() !== "")
                        state.names.set(sessionKey(channel.machineId, frame.sessionId), frame.name);
                    return;
                default:
            }
        }

        function eventsUrl(machineId) {
            const base = globalThis.document?.baseURI ?? globalThis.location?.href ?? "http://localhost/";
            const url = new URL(`api/machines/${encodeURIComponent(machineId)}/events`, base);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            return url.toString();
        }

        function scheduleReconnect(channel) {
            if (state.stopped || channel.closed)
                return;
            const delay = RECONNECT_DELAYS_MS[Math.min(channel.attempt, RECONNECT_DELAYS_MS.length - 1)];
            channel.attempt += 1;
            channel.timer = setTimeout(() => {
                channel.timer = undefined;
                openChannel(channel);
            }, delay);
        }

        function openChannel(channel) {
            if (state.stopped || channel.closed)
                return;
            const WebSocketCtor = globalThis.WebSocket;
            if (typeof WebSocketCtor !== "function")
                return;
            let socket;
            try {
                socket = new WebSocketCtor(eventsUrl(channel.machineId));
            }
            catch (error) {
                console.warn("Desktop alerts: could not open the realtime stream", error);
                scheduleReconnect(channel);
                return;
            }
            channel.socket = socket;
            channel.joined = false;
            state.stats.socketsOpened += 1;
            note("connect", { machineId: channel.machineId, url: eventsUrl(channel.machineId) });
            try {
                // Match the app: frames are binary on this transport.
                socket.binaryType = "arraybuffer";
            }
            catch {
                /* Older or non-standard socket object. */
            }
            socket.addEventListener("open", () => {
                if (channel.socket !== socket)
                    return;
                channel.attempt = 0;
                state.stats.socketsReady += 1;
                note("open", { machineId: channel.machineId, binaryType: safeBinaryType(socket) });
            });
            function handleText(text) {
                if (channel.socket !== socket || typeof text !== "string" || text === "")
                    return;
                let frame;
                try {
                    frame = JSON.parse(text);
                }
                catch {
                    state.stats.lastError = "unparsable frame";
                    return;
                }
                handleFrame(channel, frame);
            }
            // Strings and binary buffers (the real transport, thanks to
            // binaryType) decode synchronously, so frame order is inherent. Only
            // a Blob — the fallback when binaryType could not be set — needs the
            // queue, and then the queue is what preserves order.
            let blobQueue = Promise.resolve();
            socket.addEventListener("message", (event) => {
                const data = event.data;
                if (typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
                    handleText(typeof data === "string" ? data : TEXT_DECODER.decode(data));
                    return;
                }
                if (typeof data?.text === "function") {
                    blobQueue = blobQueue
                        .then(async () => {
                            handleText(await payloadText(data));
                        })
                        .catch((error) => {
                            state.stats.lastError = error instanceof Error ? error.message : String(error);
                        });
                }
            });
            socket.addEventListener("close", (event) => {
                if (channel.socket !== socket)
                    return;
                channel.socket = undefined;
                state.stats.socketsClosed += 1;
                state.stats.lastCloseCode = typeof event?.code === "number" ? event.code : undefined;
                note("disconnect", { machineId: channel.machineId, code: state.stats.lastCloseCode });
                scheduleReconnect(channel);
            });
            socket.addEventListener("error", (event) => {
                // A close event always follows; reconnect there.
                state.stats.lastError = typeof event?.message === "string" && event.message !== "" ? event.message : "socket error";
            });
        }

        async function discoverMachineIds() {
            const fetchImpl = globalThis.fetch;
            const base = globalThis.document?.baseURI ?? globalThis.location?.href;
            if (typeof fetchImpl !== "function" || typeof base !== "string")
                return ["local"];
            try {
                const response = await fetchImpl(new URL("api/machines", base), {
                    credentials: "same-origin",
                    headers: { accept: "application/json" },
                });
                if (!response.ok)
                    return ["local"];
                const body = await response.json();
                const ids = Array.isArray(body?.machines)
                    ? body.machines.map((machine) => machine?.id).filter((id) => typeof id === "string" && id !== "")
                    : [];
                return ids.length === 0 ? ["local"] : ids;
            }
            catch {
                return ["local"];
            }
        }

        function connect() {
            if (state.stopped)
                return;
            void discoverMachineIds().then((machineIds) => {
                for (const machineId of machineIds) {
                    if (state.stopped || state.channels.has(machineId))
                        continue;
                    const channel = {
                        machineId,
                        socket: undefined,
                        joined: false,
                        joins: 0,
                        attempt: 0,
                        timer: undefined,
                        closed: false,
                    };
                    state.channels.set(machineId, channel);
                    openChannel(channel);
                }
            });
        }

        /** Answer "is it connected, and is it seeing frames?" without a debugger. */
        function safeBinaryType(socket) {
            try {
                return socket.binaryType;
            }
            catch {
                return undefined;
            }
        }

        function diagnostics() {
            return {
                plugin: "desktop-alerts",
                version: VERSION,
                page: {
                    base: globalThis.document?.baseURI,
                    visibility: globalThis.document?.visibilityState,
                    focused: typeof globalThis.document?.hasFocus === "function" ? globalThis.document.hasFocus() : undefined,
                    secureContext: globalThis.isSecureContext,
                    notificationSupport: notificationConstructor() !== undefined,
                    permission: notificationPermission(),
                },
                preferences: {
                    includeContext: includeContext(),
                    alertWhileFocused: alertWhileFocused(),
                    runFinishedAlerts: runFinishedAlertsEnabled(),
                },
                channels: [...state.channels.values()].map((channel) => {
                    let url;
                    try {
                        url = eventsUrl(channel.machineId);
                    }
                    catch {
                        url = undefined;
                    }
                    const readyState = channel.socket === undefined ? undefined : channel.socket.readyState;
                    return {
                        machineId: channel.machineId,
                        url,
                        // readyState is the truth: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED.
                        readyState,
                        connection: channel.socket === undefined
                            ? "disconnected"
                            : readyState === 1
                                ? "open"
                                : readyState === 0
                                    ? "connecting"
                                    : "closing",
                        binaryType: channel.socket === undefined ? undefined : safeBinaryType(channel.socket),
                        joined: channel.joined,
                        joins: channel.joins,
                        reconnectAttempt: channel.attempt,
                    };
                }),
                waitingSessions: state.sessions.size,
                baselinedSessions: state.baseline.size,
                knownNames: state.names.size,
                stopped: state.stopped,
                stats: { ...state.stats, frames: { ...state.stats.frames } },
                log: [...state.log],
            };
        }

        function copyDiagnostics() {
            const snapshot = diagnostics();
            const text = JSON.stringify(snapshot, undefined, 2);
            console.info("Desktop alerts diagnostics", snapshot);
            try {
                const clipboard = globalThis.navigator?.clipboard;
                if (clipboard === undefined)
                    return Promise.resolve(text);
                return clipboard.writeText(text).then(() => text, () => text);
            }
            catch {
                return Promise.resolve(text);
            }
        }

        function dispose() {
            state.stopped = true;
            try {
                unsubscribeSelection?.();
            }
            catch {
                /* Already released by the host. */
            }
            state.stats.disposals += 1;
            note("disposed");
            for (const channel of state.channels.values()) {
                channel.closed = true;
                if (channel.timer !== undefined)
                    clearTimeout(channel.timer);
                channel.timer = undefined;
                const socket = channel.socket;
                channel.socket = undefined;
                try {
                    socket?.close();
                }
                catch {
                    /* Already closing. */
                }
            }
            state.channels.clear();
            state.sessions.clear();
            state.baseline.clear();
            state.names.clear();
            state.pendingAlerts.clear();
            state.pendingFinished.clear();
        }

        function requestPermission() {
            if (!supportsNotifications())
                return Promise.resolve(notificationPermission());
            // Only an undecided page can be asked; a browser never re-prompts
            // after an explicit deny, so report that state instead of calling.
            if (notificationPermission() !== "default")
                return Promise.resolve(notificationPermission());
            let pending;
            try {
                // Must run inside the action's user gesture: no awaits before this.
                pending = notificationConstructor().requestPermission();
            }
            catch (error) {
                console.warn("Desktop alerts: could not request notification permission", error);
                return Promise.resolve(notificationPermission());
            }
            return Promise.resolve(pending)
                .then((result) => {
                    if (result === "granted") {
                        showAlert({
                            title: NOTIFICATION_TITLE,
                            body: "Desktop alerts are on. You will be notified when PI WEB needs your input.",
                        }, "pi-web:test", () => {
                            state.stats.clicks += 1;
                            note("test notification clicked");
                        });
                    }
                    return result;
                })
                .catch((error) => {
                    // A browser may reject the promise (dismissed prompt, policy).
                    // That is a normal outcome here, not a plugin failure.
                    console.warn("Desktop alerts: notification permission was not granted", error);
                    return notificationPermission();
                });
        }

        /**
         * Conversation names for the alert body. `session.name` frames only
         * announce a *change*, so a freshly loaded page knows nothing about
         * conversations named earlier. The plugin API's selection service does
         * carry the selected conversation's name, which is the one the user is
         * most likely to be alerted about — no extra HTTP lookup needed.
         */
        const selection = context?.selection;
        let unsubscribeSelection;
        if (selection !== undefined && typeof selection.subscribe === "function") {
            const remember = (snapshot) => {
                const selected = snapshot?.selectedSession;
                const machineId = snapshot?.selectedMachine?.id;
                if (selected === undefined || typeof selected.id !== "string")
                    return;
                if (typeof selected.name !== "string" || selected.name.trim() === "")
                    return;
                state.names.set(sessionKey(typeof machineId === "string" && machineId !== "" ? machineId : "local", selected.id), selected.name);
            };
            try {
                remember(selection.getSnapshot());
            }
            catch {
                /* Older hosts may omit getSnapshot. */
            }
            try {
                unsubscribeSelection = selection.subscribe(remember);
            }
            catch {
                /* A host without selection observation still works, with less detail. */
            }
        }

        // DevTools access, for the times Settings says "enabled" but nothing pops.
        try {
            globalThis.__piWebDesktopAlerts = diagnostics;
        }
        catch {
            /* A frozen global scope is not fatal. */
        }

        const lifetime = context?.lifetimeSignal;
        if (typeof lifetime?.addEventListener === "function")
            lifetime.addEventListener("abort", dispose, { once: true });
        connect();

        return {
            contributions: {
                actions: [
                    {
                        id: "enable",
                        get title() {
                            return "Desktop alerts: enable";
                        },
                        get description() {
                            return permissionDescription();
                        },
                        get group() {
                            return ACTION_GROUP;
                        },
                        // Only the undecided state has something to ask for. A
                        // granted, blocked, or unsupported page gets the reason
                        // instead of a button that cannot change anything.
                        enabled: () => notificationPermission() === "default",
                        disabledReason: () => {
                            switch (notificationPermission()) {
                                case "granted":
                                    return "Desktop alerts are already enabled.";
                                case "denied":
                                    return "Blocked in this browser. Allow notifications for this site in the browser's site settings, then reload PI WEB.";
                                default:
                                    return "This PI WEB page cannot show desktop notifications (they need https or localhost).";
                            }
                        },
                        run: () => requestPermission(),
                    },
                    {
                        id: "test",
                        get title() {
                            return "Desktop alerts: send a test notification";
                        },
                        get description() {
                            return "Show one now, even while PI WEB is focused. A real alert looks the same, with the waiting prompt's detail.";
                        },
                        get group() {
                            return ACTION_GROUP;
                        },
                        enabled: () => notificationPermission() === "granted",
                        disabledReason: () => "Enable desktop alerts first.",
                        // Deliberately ignores the focused/away gate: this is the
                        // one notification the user asked for while looking at
                        // the app. It never touches prompt state, so a test can
                        // neither consume nor suppress a real alert.
                        run: () => {
                            showAlert({
                                title: NOTIFICATION_TITLE,
                                body: "Test alert. Clicking a real one brings PI WEB to the front; nothing is answered or approved.",
                            }, "pi-web:test");
                        },
                    },
                    {
                        id: "diagnostics",
                        get title() {
                            return "Desktop alerts: copy diagnostics";
                        },
                        get description() {
                            return "Copy connection and alert counters to the clipboard (also logged to the console).";
                        },
                        get group() {
                            return ACTION_GROUP;
                        },
                        run: () => copyDiagnostics(),
                    },
                    {
                        id: "toggle-finished",
                        get title() {
                            return "Desktop alerts: toggle run-finished alerts";
                        },
                        get description() {
                            return runFinishedAlertsEnabled()
                                ? "Currently notifying when a conversation finishes a run (the unread dot)."
                                : "Currently silent when a run finishes.";
                        },
                        get group() {
                            return ACTION_GROUP;
                        },
                        run: () => {
                            storageSet(STORAGE_KEYS.runFinished, runFinishedAlertsEnabled() ? "0" : "1");
                        },
                    },
                    {
                        id: "toggle-context",
                        get title() {
                            return "Desktop alerts: toggle prompt details";
                        },
                        get description() {
                            return includeContext()
                                ? "Currently showing the dialog title or conversation name."
                                : "Currently showing generic text (nothing about the prompt).";
                        },
                        get group() {
                            return ACTION_GROUP;
                        },
                        run: () => {
                            storageSet(STORAGE_KEYS.includeContext, includeContext() ? "0" : "1");
                        },
                    },
                    {
                        id: "toggle-always",
                        get title() {
                            return "Desktop alerts: toggle alerts while focused";
                        },
                        get description() {
                            return alertWhileFocused()
                                ? "Currently alerting even while PI WEB is visible and focused."
                                : "Currently alerting only while PI WEB is hidden or unfocused.";
                        },
                        get group() {
                            return ACTION_GROUP;
                        },
                        run: () => {
                            storageSet(STORAGE_KEYS.always, alertWhileFocused() ? "0" : "1");
                        },
                    },
                ],
            },
            dispose,
        };
    },
};

export default plugin;
