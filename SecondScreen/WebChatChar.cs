using System;
using System.Globalization;
using System.Threading.Tasks;
using EmbedIO;

namespace SecondScreen;

/// <summary>Chat and Character endpoints of <see cref="WebHost"/> (kept in their own file so Web.cs only gains the route / payload lines).</summary>
internal sealed partial class WebHost
{
    private ChatService? chat;
    private CharacterService? character;

    /// <summary>Wires the chat / character services in. Call before <see cref="Start"/>.</summary>
    public void AttachChatCharacter(ChatService chatService, CharacterService characterService)
    {
        chat = chatService;
        character = characterService;
    }

    private long ChatSeq => chat?.Seq ?? 0;
    private int CharacterVersion => character?.Version ?? 0;

    /// <summary>GET /api/chat?since=N[&limit=M]: chat lines with seq greater than N. Plain text, read-only; nothing is stored on disk.</summary>
    private Task HandleChatAsync(IHttpContext ctx)
    {
        if (chat == null) throw HttpException.NotFound();
        var query = ctx.GetRequestQueryData();
        long.TryParse(query["since"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var since);
        var limit = int.TryParse(query["limit"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var l) ? l : ChatService.Capacity;
        return SendJson(ctx, chat.GetJson(Math.Max(0, since), limit));
    }

    /// <summary>GET /api/character: job levels, gear, item level, gil, tomestones and currencies; "version" matches characterVersion in the WebSocket payload.</summary>
    private Task HandleCharacterAsync(IHttpContext ctx)
    {
        if (character == null) throw HttpException.NotFound();
        return SendJson(ctx, character.GetJson());
    }
}
