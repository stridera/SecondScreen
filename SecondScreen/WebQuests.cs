using System;
using System.Threading.Tasks;
using EmbedIO;

namespace SecondScreen;

internal sealed partial class WebHost
{
    /// <summary>Set by the plugin right after construction (quest givers layer of the map).</summary>
    internal QuestService? Quests { get; init; }

    /// <summary>
    /// GET /api/quests/map/{mapId}: quests whose giver stands on that map, with per-character status
    /// (available | locked | accepted; completed quests are left out) and what each quest unlocks.
    /// GET /api/quests/{id}: one quest in detail (summary text, rewards, prerequisites with completion, quests it leads to).
    /// Character dependent, so never cached.
    /// </summary>
    private async Task HandleQuestsAsync(IHttpContext ctx)
    {
        var svc = Quests ?? throw HttpException.NotFound();
        var rest = ctx.Request.Url.AbsolutePath.Substring("/api/quests".Length).Trim('/');
        var parts = rest.Length == 0 ? Array.Empty<string>() : rest.Split('/');
        try
        {
            if (parts.Length == 2 && parts[0].Equals("map", StringComparison.OrdinalIgnoreCase))
            {
                if (!uint.TryParse(parts[1], out var mapId)) throw HttpException.BadRequest("Invalid map id");
                await SendJson(ctx, Json.Serialize(await svc.GetMapAsync(mapId).ConfigureAwait(false))).ConfigureAwait(false);
                return;
            }
            if (parts.Length == 1 && uint.TryParse(parts[0], out var questId))
            {
                var detail = await svc.GetDetailAsync(questId).ConfigureAwait(false) ?? throw HttpException.NotFound();
                await SendJson(ctx, Json.Serialize(detail)).ConfigureAwait(false);
                return;
            }
        }
        catch (Exception ex) when (ex is not HttpException)
        {
            log.Error(ex, "SecondScreen quest request failed");
            throw HttpException.InternalServerError();
        }
        throw HttpException.NotFound();
    }
}
