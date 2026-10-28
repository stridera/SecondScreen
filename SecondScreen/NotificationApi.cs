using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using EmbedIO;

namespace SecondScreen;

/// <summary>
/// HTTP surface of the notification system (mounted at /api/notifications by WebHost):
///   GET  /api/notifications?since=N      { now, seq, events: [...] }  (events with seq > N; N=0 returns the whole buffer)
///   POST /api/notifications/test         emits a test event ({ priority?: high|normal|low, type?: test|duty_pop })
///   GET  /api/notifications/settings     { keywords: [...] }
///   PUT  /api/notifications/settings     { keywords: [...] }  -> { keywords }
/// </summary>
internal static class NotificationApi
{
    private static long lastTestMs;

    public static async Task HandleAsync(IHttpContext ctx, NotificationService svc)
    {
        var rest = ctx.Request.Url.AbsolutePath.Substring("/api/notifications".Length).Trim('/');
        var verb = ctx.Request.HttpVerb;

        if (rest.Length == 0)
        {
            if (verb != HttpVerbs.Get) throw HttpException.MethodNotAllowed();
            long since = 0;
            var q = ctx.GetRequestQueryData()["since"];
            if (!string.IsNullOrEmpty(q) && !long.TryParse(q, out since)) throw HttpException.BadRequest("since must be an integer");
            // Read the high-water mark first: anything emitted in between is simply delivered again next time (clients dedupe by seq).
            var seq = svc.Seq;
            var events = svc.Since(since);
            await Send(ctx, Json.Serialize(new { now = NotificationService.NowMs(), seq, events })).ConfigureAwait(false);
            return;
        }

        if (rest.Equals("test", StringComparison.OrdinalIgnoreCase))
        {
            if (verb != HttpVerbs.Post) throw HttpException.MethodNotAllowed();
            using var body = await ReadBodyAsync(ctx).ConfigureAwait(false);
            var now = NotificationService.NowMs();
            if (now - lastTestMs < 400) throw HttpException.BadRequest("Slow down");
            lastTestMs = now;

            var type = GetString(body.RootElement, "type") == "duty_pop" ? "duty_pop" : "test";
            var priority = GetString(body.RootElement, "priority") is "high" or "normal" or "low" ? GetString(body.RootElement, "priority")! : "normal";
            NotificationEvent ev;
            if (type == "duty_pop")
                ev = svc.Emit("duty_pop", "high", "Test Duty: The Praetorium", "This is a test of the duty pop alert. Nothing is queued in game.",
                    new Dictionary<string, object?> { ["test"] = true }, 45_000);
            else
                ev = svc.Emit("test", priority, "Test notification",
                    priority == "high" ? "This is a test of a high priority alert." : priority == "low" ? "This test only appears in the notification center." : "If you can see and hear this, alerts work on this device.",
                    new Dictionary<string, object?> { ["test"] = true }, priority == "high" ? 20_000 : null);
            await Send(ctx, Json.Serialize(new { ok = true, seq = ev.Seq })).ConfigureAwait(false);
            return;
        }

        if (rest.Equals("settings", StringComparison.OrdinalIgnoreCase))
        {
            if (verb == HttpVerbs.Get)
            {
                await Send(ctx, Json.Serialize(new { keywords = svc.Keywords })).ConfigureAwait(false);
                return;
            }
            if (verb == HttpVerbs.Put || verb == HttpVerbs.Post)
            {
                using var body = await ReadBodyAsync(ctx).ConfigureAwait(false);
                if (!body.RootElement.TryGetProperty("keywords", out var arr) || arr.ValueKind != JsonValueKind.Array)
                    throw HttpException.BadRequest("keywords must be an array of strings");
                var list = arr.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString());
                var saved = svc.SetKeywords(list);
                await Send(ctx, Json.Serialize(new { keywords = saved })).ConfigureAwait(false);
                return;
            }
            throw HttpException.MethodNotAllowed();
        }

        throw HttpException.NotFound();
    }

    private static Task Send(IHttpContext ctx, string json)
    {
        ctx.Response.Headers["Cache-Control"] = "no-store";
        return ctx.SendStringAsync(json, "application/json", Json.Utf8NoBom);
    }

    private static string? GetString(JsonElement root, string name)
        => root.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;

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
}
