# SecondScreen

A Dalamud plugin for FFXIV that hosts a small embedded web server (EmbedIO) so a browser on your LAN
(iPad, Android, a second PC) can show live game data. Other plugins can publish their own data to it
through Dalamud IPC.

Tabs: **Party** (live HP/MP cards), **Map** (zone map with live markers), **Tracker** (item/currency and achievement trackers), **Inventory** (bags, armoury, equipped, crystals, currency, saddlebag and cached retainers with search and ventures), **Plugins** (IPC-published data).

## Build

From the repo root (Windows, .NET SDK 10, XIVLauncher with Dalamud installed so the dev hooks exist):

```
dotnet build -c Debug
```

The build uses the `Dalamud.NET.Sdk` project SDK, which finds the Dalamud dev hooks in
`%AppData%\XIVLauncher\addon\Hooks\dev`. Output: `SecondScreen\bin\Debug\SecondScreen.dll`.

## Load as a dev plugin

1. In game: `/xlsettings` -> Experimental -> Dev Plugin Locations -> add the full path to `SecondScreen.dll`
   (the Debug output above) -> Save.
2. `/xlplugins` -> Dev Tools -> Installed Dev Plugins -> enable SecondScreen.
3. `/secondscreen` opens the settings window with the access token and the URLs to open.

## Using it

Open `http://<your-pc-ip>:47435/?token=<token>` on the other device. The token is stored in the
browser's localStorage and removed from the address bar. "Add to Home Screen" works on iOS/Android
(on iOS, the home-screen app has separate storage: it will ask for the token once; paste it in).

Settings (`/secondscreen`): port (default 47435), listen on all interfaces vs localhost only, auto-start,
token regeneration. Changing port/bind mode needs "Apply and restart server".

## LAN access / Windows Firewall

The server listens on `http://*:<port>/` using EmbedIO's own listener, so no URL ACL or admin rights
are needed. Windows Firewall will still block inbound LAN connections until you allow the port. This
plugin does not change firewall rules. Run once in an elevated PowerShell if you want LAN access:

```
New-NetFirewallRule -DisplayName "SecondScreen" -Direction Inbound -Protocol TCP -LocalPort 47435 -Action Allow -Profile Private
```

Security note: traffic is plain HTTP and protected only by the access token. Only use it on a trusted
network. `/api/*` and `/ws` require the token (`?token=` or `Authorization: Bearer`); static files are open.

## HTTP API

- `GET /api/state` - latest snapshot JSON
- `GET /api/ipc` - data published by other plugins, `{ plugin: { key: { updated, value } } }`
- `WS /ws` - pushes `{ snapshot, ipc, trackers }` about 6-7 times per second
- `GET /api/trackers` - evaluated tracker list; `POST /api/trackers` `{kind, targetId, targetCount?, title?}`;
  `PATCH /api/trackers/{id}` `{targetCount?, title?, order?}` (`targetCount: null` clears the target);
  `DELETE /api/trackers/{id}`; `POST /api/trackers/{id}/refresh` (re-request achievement progress)
- `GET /api/search?kind=item|achievement&q=...` - top 25 `{id, name, iconId, subtitle}` (case-insensitive substring)
- `GET /api/icon/{iconId}.png` - game icon rendered to PNG
- `GET /api/inventory` - inventory model (containers by group, gil, free slots, cached retainers with ventures, static item info); the WebSocket payload carries `inventoryVersion` and the client refetches only when it changes

## Tracker tab

Trackers are stored in the plugin config (`Configuration.Trackers`, config version 3). Kinds: `item` (counts bags,
armoury, equipped, crystals, currency and the saddlebag when loaded; retainers are not counted) and `achievement`
(completion flag plus server-side progress, requested one achievement at a time, at most every 5 minutes, on add
and on the refresh button). Kinds `goal` and `quest` are reserved for later phases.

## IPC for other plugins

| Name | Signature |
| --- | --- |
| `SecondScreen.GetApiVersion` | `() -> int` (currently 1) |
| `SecondScreen.IsServerRunning` | `() -> bool` |
| `SecondScreen.Publish` | `(string pluginName, string key, string json) -> void` |
| `SecondScreen.Clear` | `(string pluginName) -> void` |

```csharp
var publish = pluginInterface.GetIpcSubscriber<string, string, string, object>("SecondScreen.Publish");
try { publish.InvokeAction("MyPlugin", "status", "{\"kills\":12}"); } catch (IpcNotReadyError) { /* SecondScreen not loaded */ }
```

Invalid JSON is stored as a plain string. Call `Clear` when your plugin unloads.

## Notifications

The plugin detects events and the web app alerts you (full-screen alert, toast, sound, vibration); there is no external push service, so alerts only work while the page is open and the device is awake (use Keep awake). Events: `duty_pop` (+ `duty_pop_cleared`), `queue_ended`, `tell`, `mention`, `party_invite`, `ready_check`, `venture_done`, `reset`; the connection-lost alert is client-side.

- `GET /api/notifications?since=<seq>` - `{now, seq, events:[{seq, ts, type, priority, title, body, data, expiresAt}]}`; every WebSocket push carries `notifySeq` (high-water mark) and `queue` (Duty Finder state or null)
- `POST /api/notifications/test` `{priority?: high|normal|low, type?: duty_pop}` - emit a test event
- `GET|PUT /api/notifications/settings` `{keywords:[...]}` - extra words that raise a `mention` (your first name always does)

## TODO

- QR code for the connect URL in the settings window
- Tracker phase 2: shop/recipe "goal" trackers and quest chains
