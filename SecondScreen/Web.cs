using System;
using System.Reflection;
using System.Security.Cryptography;
using System.Linq;
using System.Text;
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
    private readonly IPluginLog log;
    private readonly object gate = new();

    private WebServer? server;
    private StateSocketModule? socket;
    private CancellationTokenSource? cts;
    private Task? runTask;
    private Task? pushTask;

    public WebHost(Configuration config, Collector collector, IpcStore ipc, IPluginLog log)
    {
        this.config = config;
        this.collector = collector;
        this.ipc = ipc;
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
    });

    private static Task SendJson(IHttpContext ctx, string json)
    {
        ctx.Response.Headers["Cache-Control"] = "no-store";
        return ctx.SendStringAsync(json, "application/json", Encoding.UTF8);
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
