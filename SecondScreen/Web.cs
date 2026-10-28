using System;
using System.Collections.Generic;
using System.Reflection;
using System.Security.Cryptography;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Dalamud.Plugin.Services;
using EmbedIO;
using EmbedIO.Actions;
using EmbedIO.WebSockets;

namespace SecondScreen;

/// <summary>Rejects /api and /ws requests that don't carry the access token.</summary>
internal sealed class TokenAuthModule : WebModuleBase
{
    private readonly Func<string> getToken;

    public TokenAuthModule(string baseRoute, Func<string> getToken) : base(baseRoute)
    {
        this.getToken = getToken;
    }

    public override bool IsFinalHandler => false;

    protected override Task OnRequestAsync(IHttpContext context)
    {
        var path = context.Request.Url.AbsolutePath;
        var protectedPath = path.StartsWith("/api", StringComparison.OrdinalIgnoreCase)
                            || path.Equals("/ws", StringComparison.OrdinalIgnoreCase);
        if (!protectedPath) return Task.CompletedTask;

        var expected = getToken();
        var supplied = context.GetRequestQueryData()["token"];
        if (string.IsNullOrEmpty(supplied))
        {
            var header = context.Request.Headers["Authorization"];
            if (header != null && header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                supplied = header.Substring(7).Trim();
        }

        if (!string.IsNullOrEmpty(expected) && !string.IsNullOrEmpty(supplied)
            && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(supplied)))
            return Task.CompletedTask;

        throw HttpException.Unauthorized();
    }
}

/// <summary>Push-only WebSocket endpoint. Messages from clients are ignored.</summary>
internal sealed class StateSocketModule : WebSocketModule
{
    private readonly Func<string> buildPayload;

    public StateSocketModule(string path, Func<string> buildPayload) : base(path, true)
    {
        this.buildPayload = buildPayload;
        Encoding = Json.Utf8NoBom; // no BOM in WebSocket text frames
    }

    public int ClientCount => ActiveContexts.Count;

    public Task PushAsync(string payload) => BroadcastAsync(payload);

    protected override Task OnClientConnectedAsync(IWebSocketContext context) => SendAsync(context, buildPayload());

    protected override Task OnMessageReceivedAsync(IWebSocketContext context, byte[] buffer, IWebSocketReceiveResult result) => Task.CompletedTask;
}

/// <summary>Owns the EmbedIO server lifecycle. Never throws into callers.</summary>
internal sealed class WebHost : IDisposable
{
    private const int PushIntervalMs = 150; // ~6-7 Hz

    private readonly Configuration config;
    private readonly Collector collector;
    private readonly IpcStore ipc;
    private readonly MapService maps;
    private readonly TrackerService trackers;
    private readonly GameSearch search;
    private readonly IconStore icons;
    private readonly IPluginLog log;
    private readonly object gate = new();

    private WebServer? server;
    private StateSocketModule? socket;
    private CancellationTokenSource? cts;
    private Task? runTask;
    private Task? pushTask;

    public WebHost(Configuration config, Collector collector, IpcStore ipc, MapService maps,
        TrackerService trackers, GameSearch search, IconStore icons, IPluginLog log)
    {
        this.config = config;
        this.collector = collector;
        this.ipc = ipc;
        this.maps = maps;
        this.trackers = trackers;
        this.search = search;
        this.icons = icons;
        this.log = log;
    }

    public bool IsRunning => server?.State == WebServerState.Listening;
    public string? LastError { get; private set; }
    public int ClientCount => socket?.ClientCount ?? 0;
    public int BoundPort { get; private set; }

    public void Start()
    {
        lock (gate)
        {
            if (server != null) return;
            LastError = null;
            try
            {
                // EmbedIO resolves a wildcard host to IPv6Any (dual-mode) by default; use plain IPv4 Any
                // so exactly one socket is bound (LAN + Tailscale IPv4 addresses, no admin / URL ACL).
                EmbedIO.Net.EndPointManager.UseIpv6 = false;
                var prefix = config.BindAll ? $"http://*:{config.Port}/" : $"http://localhost:{config.Port}/";
                var ws = new StateSocketModule("/ws", BuildPayload);
                var srv = new WebServer(o => o
                        .WithUrlPrefix(prefix)
                        .WithMode(HttpListenerMode.EmbedIO))
                    .WithModule(new TokenAuthModule("/", () => config.AccessToken))
                    .WithModule(new ActionModule("/api/state", HttpVerbs.Get,
                        ctx => SendJson(ctx, Json.Serialize(collector.Current))))
                    .WithModule(new ActionModule("/api/ipc", HttpVerbs.Get,
                        ctx => SendJson(ctx, Json.Serialize(ipc.ToDictionary()))))
                    .WithModule(new ActionModule("/api/map", HttpVerbs.Get, HandleMapAsync))
                    .WithModule(new ActionModule("/api/trackers", HttpVerbs.Any, HandleTrackersAsync))
                    .WithModule(new ActionModule("/api/search", HttpVerbs.Get, HandleSearchAsync))
                    .WithModule(new ActionModule("/api/icon", HttpVerbs.Get, HandleIconAsync))
                    .WithModule(ws)
                    .WithEmbeddedResources("/", Assembly.GetExecutingAssembly(), "SecondScreen.wwwroot");

                srv.StateChanged += (_, e) => log.Debug("SecondScreen web server state: {Old} -> {New}", e.OldState, e.NewState);

                var source = new CancellationTokenSource();
                server = srv;
                socket = ws;
                cts = source;
                BoundPort = config.Port;
                runTask = Task.Run(() => RunAsync(srv, source.Token));
                pushTask = Task.Run(() => PushLoopAsync(ws, source.Token));
            }
            catch (Exception ex)
            {
                LastError = ex.Message;
                log.Error(ex, "Failed to start SecondScreen web server");
                StopInternal();
            }
        }
    }

    public void Stop()
    {
        lock (gate) StopInternal();
    }

    public void Restart()
    {
        lock (gate)
        {
            StopInternal();
        }
        Start();
    }

    public void Dispose() => Stop();

    private async Task RunAsync(WebServer srv, CancellationToken ct)
    {
        try
        {
            await srv.RunAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            LastError = ex.Message;
            log.Error(ex, "SecondScreen web server crashed");
        }
    }

    private async Task PushLoopAsync(StateSocketModule ws, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (ws.ClientCount > 0)
                    await ws.PushAsync(BuildPayload()).ConfigureAwait(false);
                await Task.Delay(PushIntervalMs, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                log.Warning(ex, "SecondScreen push failed");
                try { await Task.Delay(1000, ct).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
            }
        }
    }

    private string BuildPayload() => Json.Serialize(new
    {
        snapshot = collector.Current,
        ipc = ipc.ToDictionary(),
        trackers = trackers.Progress,
    });

    private static Task SendJson(IHttpContext ctx, string json)
    {
        ctx.Response.Headers["Cache-Control"] = "no-store";
        return ctx.SendStringAsync(json, "application/json", Json.Utf8NoBom);
    }

    /// <summary>GET /api/map/{mapId} (metadata JSON) and GET /api/map/{mapId}.png (cached map image).</summary>
    private async Task HandleMapAsync(IHttpContext ctx)
    {
        var rest = ctx.Request.Url.AbsolutePath.Substring("/api/map".Length).Trim('/');
        var wantPng = rest.EndsWith(".png", StringComparison.OrdinalIgnoreCase);
        if (wantPng) rest = rest.Substring(0, rest.Length - 4);
        if (!uint.TryParse(rest, out var mapId)) throw HttpException.BadRequest("Invalid map id");

        if (!wantPng)
        {
            var info = maps.GetInfo(mapId) ?? throw HttpException.NotFound();
            await SendJson(ctx, Json.Serialize(info)).ConfigureAwait(false);
            return;
        }

        byte[]? png;
        try
        {
            png = await Task.Run(() => maps.GetPng(mapId)).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            log.Error(ex, "SecondScreen failed to render map {MapId}", mapId);
            throw HttpException.InternalServerError();
        }
        if (png == null) throw HttpException.NotFound();

        ctx.Response.ContentType = "image/png";
        ctx.Response.ContentLength64 = png.Length;
        ctx.Response.Headers["Cache-Control"] = "private, max-age=86400";
        using var stream = ctx.OpenResponseStream(false, false);
        await stream.WriteAsync(png, 0, png.Length).ConfigureAwait(false);
    }

    /// <summary>
    /// GET/POST /api/trackers, PATCH/DELETE /api/trackers/{id}, POST /api/trackers/{id}/refresh.
    /// Mutations lock inside TrackerService and save the config; evaluation stays on the framework thread.
    /// </summary>
    private async Task HandleTrackersAsync(IHttpContext ctx)
    {
        var rest = ctx.Request.Url.AbsolutePath.Substring("/api/trackers".Length).Trim('/');
        var parts = rest.Length == 0 ? Array.Empty<string>() : rest.Split('/');
        var verb = ctx.Request.HttpVerb;

        if (parts.Length == 0)
        {
            if (verb == HttpVerbs.Get)
            {
                await SendJson(ctx, Json.Serialize(trackers.Progress)).ConfigureAwait(false);
                return;
            }
            if (verb == HttpVerbs.Post)
            {
                using var body = await ReadBodyAsync(ctx).ConfigureAwait(false);
                var root = body.RootElement;
                var kind = GetString(root, "kind");
                if (!GameSearch.IsKnownKind(kind) || !TrackerKinds.IsSupported(kind)) throw HttpException.BadRequest("Unsupported kind");
                if (!TryGetUInt(root, "targetId", out var targetId) || targetId == 0) throw HttpException.BadRequest("targetId required");
                var count = GetOptionalInt(root, "targetCount", out _);
                var found = await search.FindAsync(kind!, targetId).ConfigureAwait(false)
                            ?? throw HttpException.BadRequest("Unknown id for this kind");
                var title = GetString(root, "title")?.Trim();
                var includeHq = !root.TryGetProperty("includeHq", out var hq) || hq.ValueKind != JsonValueKind.False;
                var def = trackers.Add(kind!, targetId, count, string.IsNullOrEmpty(title) ? found.Name : title, found.IconId, includeHq);
                await SendJson(ctx, Json.Serialize(def)).ConfigureAwait(false);
                return;
            }
            throw HttpException.MethodNotAllowed();
        }

        var id = parts[0];
        if (parts.Length == 1 && verb == HttpVerbs.Delete)
        {
            if (!trackers.Remove(id)) throw HttpException.NotFound();
            await SendJson(ctx, "{\"ok\":true}").ConfigureAwait(false);
            return;
        }
        if (parts.Length == 1 && verb == HttpVerbs.Patch)
        {
            using var body = await ReadBodyAsync(ctx).ConfigureAwait(false);
            var root = body.RootElement;
            var count = GetOptionalInt(root, "targetCount", out var hasCount);
            int? order = root.TryGetProperty("order", out var o) && o.ValueKind == JsonValueKind.Number && o.TryGetInt32(out var ov) ? ov : null;
            var def = trackers.Update(id, hasCount, count, GetString(root, "title"), order) ?? throw HttpException.NotFound();
            await SendJson(ctx, Json.Serialize(def)).ConfigureAwait(false);
            return;
        }
        if (parts.Length == 2 && parts[1] == "refresh" && verb == HttpVerbs.Post)
        {
            if (!trackers.RequestRefresh(id)) throw HttpException.NotFound();
            await SendJson(ctx, "{\"ok\":true}").ConfigureAwait(false);
            return;
        }
        throw HttpException.NotFound();
    }

    private static async Task<JsonDocument> ReadBodyAsync(IHttpContext ctx)
    {
        if (ctx.Request.ContentLength64 > 16 * 1024) throw HttpException.BadRequest("Body too large");
        var text = await ctx.GetRequestBodyAsStringAsync().ConfigureAwait(false);
        try
        {
            var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) { doc.Dispose(); throw HttpException.BadRequest("Expected a JSON object"); }
            return doc;
        }
        catch (JsonException)
        {
            throw HttpException.BadRequest("Invalid JSON");
        }
    }

    private static string? GetString(JsonElement root, string name)
        => root.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;

    private static bool TryGetUInt(JsonElement root, string name, out uint value)
    {
        value = 0;
        return root.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetUInt32(out value);
    }

    /// <summary>Reads an optional int that may be absent (present=false), null (present, clears) or a number.</summary>
    private static int? GetOptionalInt(JsonElement root, string name, out bool present)
    {
        present = root.TryGetProperty(name, out var p);
        if (!present || p.ValueKind != JsonValueKind.Number) return null;
        return p.TryGetInt32(out var v) ? v : null;
    }

    /// <summary>GET /api/search?kind=item|achievement&q=... -> top 25 { id, name, iconId, subtitle }.</summary>
    private async Task HandleSearchAsync(IHttpContext ctx)
    {
        var query = ctx.GetRequestQueryData();
        var kind = query["kind"];
        if (!GameSearch.IsKnownKind(kind)) throw HttpException.BadRequest("kind must be item or achievement");
        try
        {
            var results = await search.SearchAsync(kind!, query["q"] ?? "").ConfigureAwait(false);
            await SendJson(ctx, Json.Serialize(results)).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not HttpException)
        {
            log.Error(ex, "SecondScreen search failed");
            throw HttpException.InternalServerError();
        }
    }

    /// <summary>GET /api/icon/{iconId}.png (game icon rendered to PNG, cached).</summary>
    private async Task HandleIconAsync(IHttpContext ctx)
    {
        var rest = ctx.Request.Url.AbsolutePath.Substring("/api/icon".Length).Trim('/');
        if (rest.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) rest = rest.Substring(0, rest.Length - 4);
        if (!uint.TryParse(rest, out var iconId)) throw HttpException.BadRequest("Invalid icon id");

        byte[]? png;
        try { png = await Task.Run(() => icons.GetPng(iconId)).ConfigureAwait(false); }
        catch (Exception ex)
        {
            log.Error(ex, "SecondScreen failed to render icon {IconId}", iconId);
            throw HttpException.InternalServerError();
        }
        if (png == null) throw HttpException.NotFound();

        ctx.Response.ContentType = "image/png";
        ctx.Response.ContentLength64 = png.Length;
        ctx.Response.Headers["Cache-Control"] = "private, max-age=604800";
        using var stream = ctx.OpenResponseStream(false, false);
        await stream.WriteAsync(png, 0, png.Length).ConfigureAwait(false);
    }

    private void StopInternal()
    {
        var source = cts;
        var srv = server;
        var tasks = new[] { runTask, pushTask }.Where(t => t != null).Cast<Task>().ToArray();
        cts = null; server = null; socket = null; runTask = null; pushTask = null;

        try { source?.Cancel(); } catch (Exception ex) { log.Warning(ex, "Cancel failed"); }
        // Let RunAsync/PushLoop observe the cancellation, then dispose the server so the listening
        // socket is released before any restart tries to bind the same port again.
        try { Task.WaitAll(tasks, 3000); } catch { /* cancelled/faulted: already logged */ }
        try { srv?.Dispose(); } catch (Exception ex) { log.Warning(ex, "Server dispose failed"); }
        source?.Dispose();
    }
}
