# PI WEB desktop alerts

Pops a **browser desktop notification** when PI WEB needs your attention:

- **Input needed** — an `ask_user` question, a `request_human_intervention` call,
  or an extension dialog such as a permission prompt.
- **Run finished** — PI WEB marks the conversation unread (the purple dot), which
  is its "settled and not yet reviewed" signal.

The plugin never answers a dialog, never grants a permission, and never writes to
a session. A notification click brings PI WEB to the front and nothing else.

## Install

1. PI WEB → **Settings → Pi packages** → enter `npm:pi-web-desktop-alerts` → **Install**.
2. **Settings → PI WEB plugins** → check that `desktop-alerts` is enabled (most
   plugins are). Enabling is a separate decision from installing.
3. Reload the browser page.
4. Action palette (Ctrl/Cmd-K) → **“Desktop alerts: enable”** → allow
   notifications. A test notification follows.

Browsers need a secure context: `https://`, `localhost`, or `127.0.0.1`. On a
plain-`http` LAN address the enable action explains that it cannot ask.

### Palette actions

| Action | Effect |
| --- | --- |
| Desktop alerts: enable | Requests notification permission (only the undecided state can ask). |
| Desktop alerts: send a test notification | Pops one immediately, even while PI WEB is focused. |
| Desktop alerts: copy diagnostics | JSON with socket state, frame and alert counters (also logged to the console). |
| Desktop alerts: toggle run-finished alerts | Notify when a run settles (on by default) ↔ silent. |
| Desktop alerts: toggle prompt details | Detailed body ↔ fully generic text. |
| Desktop alerts: toggle alerts while focused | Away-only (default) ↔ always. |

## Behavior

- **Away-only by default**: nothing pops while the PI WEB tab is visible and
  focused, because the prompt is already on screen.
- **One notification per prompt.** Pending dialog ids are diffed on every status
  frame, so repeated frames stay quiet, a second dialog opened on an already
  waiting conversation is its own alert (named after the addition), and closing a
  dialog never alerts.
- **One notification per conversation** per kind: a newer prompt replaces the
  older banner instead of stacking (`tag` per machine and session). Input and
  finished alerts have distinct tags, so one never replaces the other.
- **Run-finished alerts skip runs that ended by asking.** PI WEB publishes the
  unread mutation after the waiting status frame, so an `ask_user` produces only
  the input alert.
- **Body text** shows the dialog title when there is one; otherwise the
  conversation name, resolved from the selection service, a `session.name` frame,
  or read-only PI WEB GETs (cached, bounded by one 1.5s deadline; a failure falls
  back to generic text and still shows the banner). Turn prompt details off to
  keep prompt content out of the OS notification history entirely.
- **Reconnects do not replay.** A join snapshot seeds the baseline; a prompt that
  appeared while the socket was down is announced once, and a prompt answered
  during a name lookup is dropped rather than shown late.

## Compatibility

**Requires PI WEB's browser plugin API v5.** Tested on PI WEB `1.202611.2` and
Pi `1.5.2`. The plugin API's selection service is *optional*: hosts that omit it
still load the plugin, with less body detail.

One caveat worth knowing: the plugin reads PI WEB's realtime `status.update`,
`machine.status`, and `sessions.unread` frames. Those are PI WEB's *internal*
contract and are deliberately **not** part of `plugin-api.d.ts`. If a future
PI WEB reshapes them, this plugin can go quiet while its frame counters keep
rising — the `log` shows what it actually received. The whole plugin is one file,
so that is a small fix.

PI WEB can also mark a conversation unread by hand, so a run-finished alert means
"PI WEB says this conversation is unread", not proof that an agent run succeeded.

## Limits

- This is the Web Notifications API, not Web Push: **the PI WEB tab must be
  open**. Backgrounded is fine; closed gets nothing.
- Notification history, Do Not Disturb, and focus modes belong to the OS. A
  banner can be suppressed there even when the plugin did everything right; the
  diagnostics counters distinguish that from a plugin failure.
- A page reload while a prompt is already open does not re-alert for it, and the
  join snapshot only carries booleans, so a prompt that replaced another one
  entirely while the socket was down can only be reported generically.

## Diagnosing "nothing popped"

Run **Desktop alerts: copy diagnostics** (`__piWebDesktopAlerts()` in DevTools
returns the same snapshot live) and read:

- `channels[0].connection` / `readyState` — `connecting` with a rising
  `reconnectAttempt` means the realtime socket is being refused; `stats.lastCloseCode`
  usually says why.
- `stats.frames` — if `status.update` never appears while `joined` is true, frames
  are not arriving at all; if the counts rise but no alert fires, the frames arrived
  in a shape this version does not understand (see the caveat above).
- `stats.alertsShown`, `finishedShown`, `suppressedAwayOnly`,
  `finishedSuppressedAwayOnly`, `suppressedPermission` — which branch the alert took.
- `log` — timestamped events: connect, join, waiting frames, gate verdicts, HTTP
  legs that failed, names resolved, clicks, and dropped late results.

> **Privacy:** the snapshot is not anonymous. It can contain the page URL
> (project, workspace, and session ids), machine and session ids, and the URLs of
> failed lookups, which include workspace paths. Redact those before posting a
> snapshot publicly in an issue or the community listing.

## Development

No build step; the package is one ES module with no dependencies.

```sh
node --test dev/plugin.test.mjs
```

46 tests drive the real module through PI WEB's frame shapes with browser globals
stubbed: frame decoding (text, binary, Blob), dialog diffing, baselines and
reconnects, name resolution and its deadline, both alert kinds and their toggles,
permission states, clicks, disposal, and a guard that the reported version matches
`package.json` and that the package is publishable.

For a local checkout instead of npm:

```sh
mkdir -p ~/.pi-web/plugins
ln -s /path/to/pi-web-desktop-alerts ~/.pi-web/plugins/desktop-alerts
```

Use `$PI_WEB_DATA_DIR/plugins` when `PI_WEB_DATA_DIR` is set. Reload the browser
page afterwards; no daemon restart is needed for a browser-only plugin.

## Tested

Verified in a real browser against a live session daemon: an `ask_user` posted
while the tab is backgrounded, a run-finished alert, notification click raising
PI WEB, the palette test notification and its permission request, and an
extension dialog (the permission prompt's title appearing in the body).

## License

MIT © 2026 Steven Adger. See [LICENSE](LICENSE).
