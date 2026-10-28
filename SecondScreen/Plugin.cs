using System;
using Dalamud.Game.Command;
using Dalamud.Interface.Windowing;
using Dalamud.IoC;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;

namespace SecondScreen;

public sealed class Plugin : IDalamudPlugin
{
    private const string CommandName = "/secondscreen";

    private readonly IDalamudPluginInterface pluginInterface;
    private readonly ICommandManager commandManager;
    private readonly IPluginLog log;
    private readonly Configuration config;
    private readonly Collector collector;
    private readonly IpcStore ipcStore = new();
    private readonly MapService mapService;
    private readonly GameSearch gameSearch;
    private readonly IconStore iconStore;
    private readonly TrackerService trackers;
    private readonly InventoryService inventory;
    private readonly NotificationService notifications;
    private readonly NotificationSources notificationSources;
    private readonly WebHost webHost;
    private readonly IpcGates ipcGates;
    private readonly WindowSystem windowSystem = new("SecondScreen");
    private readonly ConfigWindow configWindow;

    public Plugin(
        IDalamudPluginInterface pluginInterface,
        ICommandManager commandManager,
        IFramework framework,
        IDataManager dataManager,
        IClientState clientState,
        IPlayerState playerState,
        IObjectTable objectTable,
        IPartyList partyList,
        IFateTable fateTable,
        IChatGui chatGui,
        IPluginLog log)
    {
        this.pluginInterface = pluginInterface;
        this.commandManager = commandManager;
        this.log = log;

        config = pluginInterface.GetPluginConfig() as Configuration ?? new Configuration();
        if (config.Migrate() | config.EnsureToken()) pluginInterface.SavePluginConfig(config);

        collector = new Collector(framework, clientState, objectTable, partyList, fateTable, dataManager, log);
        mapService = new MapService(dataManager, log);
        gameSearch = new GameSearch(dataManager.GameData);
        iconStore = new IconStore(dataManager.GameData);
        trackers = new TrackerService(framework, clientState, pluginInterface, config, log, new MsqModel(dataManager.GameData), playerState);
        inventory = new InventoryService(framework, clientState, playerState, pluginInterface, new ItemInfoStore(dataManager.GameData), log);
        notifications = new NotificationService(config, () => pluginInterface.SavePluginConfig(config));
        notificationSources = new NotificationSources(framework, clientState, chatGui, playerState, dataManager, inventory, notifications, log);
        webHost = new WebHost(config, collector, ipcStore, mapService, trackers, gameSearch, iconStore, inventory, notifications, log);
        ipcGates = new IpcGates(pluginInterface, ipcStore, () => webHost.IsRunning);

        configWindow = new ConfigWindow(config, webHost, pluginInterface);
        windowSystem.AddWindow(configWindow);

        commandManager.AddHandler(CommandName, new CommandInfo(OnCommand)
        {
            HelpMessage = "Toggle the SecondScreen settings window.",
        });

        pluginInterface.UiBuilder.Draw += windowSystem.Draw;
        pluginInterface.UiBuilder.OpenConfigUi += configWindow.Toggle;
        pluginInterface.UiBuilder.OpenMainUi += configWindow.Toggle;

        if (config.AutoStart) webHost.Start();
    }

    private void OnCommand(string command, string args) => configWindow.Toggle();

    public void Dispose()
    {
        pluginInterface.UiBuilder.Draw -= windowSystem.Draw;
        pluginInterface.UiBuilder.OpenConfigUi -= configWindow.Toggle;
        pluginInterface.UiBuilder.OpenMainUi -= configWindow.Toggle;
        commandManager.RemoveHandler(CommandName);

        windowSystem.RemoveAllWindows();
        ipcGates.Dispose();
        webHost.Dispose();
        notificationSources.Dispose();
        inventory.Dispose();
        trackers.Dispose();
        collector.Dispose();
        ipcStore.ClearAll();
    }
}
