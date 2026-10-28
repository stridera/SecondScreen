# SecondScreen

A Dalamud plugin for FFXIV that hosts a small embedded web server (EmbedIO) so a browser on your LAN
(iPad, Android, a second PC) can show live game data. Other plugins can publish their own data to it
through Dalamud IPC.

Tabs: **Party** (live HP/MP cards), **Map** (placeholder), **Inventory** (placeholder), **Plugins** (IPC-published data).

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
- `WS /ws` - pushes `{ snapshot, ipc }` about 6-7 times per second

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

## TODO

- QR code for the connect URL in the settings window
- Real Map tab, Inventory tab
