using System;
using Dalamud.Plugin;
using Dalamud.Plugin.Ipc;

namespace SecondScreen;

/// <summary>Registers the SecondScreen.* Dalamud IPC gates.</summary>
internal sealed class IpcGates : IDisposable
{
    public const int ApiVersion = 1;

    private readonly ICallGateProvider<int> getApiVersion;
    private readonly ICallGateProvider<bool> isServerRunning;
    private readonly ICallGateProvider<string, string, string, object> publish;
    private readonly ICallGateProvider<string, object> clear;

    public IpcGates(IDalamudPluginInterface pi, IpcStore store, Func<bool> isRunning)
    {
        getApiVersion = pi.GetIpcProvider<int>("SecondScreen.GetApiVersion");
        isServerRunning = pi.GetIpcProvider<bool>("SecondScreen.IsServerRunning");
        publish = pi.GetIpcProvider<string, string, string, object>("SecondScreen.Publish");
        clear = pi.GetIpcProvider<string, object>("SecondScreen.Clear");

        getApiVersion.RegisterFunc(() => ApiVersion);
        isServerRunning.RegisterFunc(isRunning);
        publish.RegisterAction(store.Publish);
        clear.RegisterAction(store.Clear);
    }

    public void Dispose()
    {
        getApiVersion.UnregisterFunc();
        isServerRunning.UnregisterFunc();
        publish.UnregisterAction();
        clear.UnregisterAction();
    }
}
