using System;
using System.Collections.Generic;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Numerics;
using Dalamud.Bindings.ImGui;
using Dalamud.Interface.Windowing;
using Dalamud.Plugin;

namespace SecondScreen;

internal sealed class ConfigWindow : Window
{
    private readonly Configuration config;
    private readonly WebHost host;
    private readonly IDalamudPluginInterface pi;

    private int editPort;
    private bool editBindAll;
    private List<string> lanAddresses = new();
    private DateTime lastAddressRefresh = DateTime.MinValue;

    public ConfigWindow(Configuration config, WebHost host, IDalamudPluginInterface pi)
        : base("SecondScreen##SecondScreenConfig")
    {
        this.config = config;
        this.host = host;
        this.pi = pi;
        editPort = config.Port;
        editBindAll = config.BindAll;
        SizeConstraints = new WindowSizeConstraints
        {
            MinimumSize = new Vector2(480, 320),
            MaximumSize = new Vector2(900, 800),
        };
        Size = new Vector2(560, 420);
        SizeCondition = ImGuiCond.FirstUseEver;
    }

    public override void Draw()
    {
        var running = host.IsRunning;
        ImGui.TextUnformatted("Server:");
        ImGui.SameLine();
        if (running) ImGui.TextColored(new Vector4(0.4f, 1f, 0.4f, 1f), $"running on port {host.BoundPort}");
        else ImGui.TextColored(new Vector4(1f, 0.4f, 0.4f, 1f), "stopped");
        if (!string.IsNullOrEmpty(host.LastError))
            ImGui.TextColored(new Vector4(1f, 0.7f, 0.3f, 1f), $"Last error: {host.LastError}");
        ImGui.TextUnformatted($"Connected clients: {host.ClientCount}");

        if (running)
        {
            if (ImGui.Button("Stop")) host.Stop();
        }
        else if (ImGui.Button("Start")) host.Start();

        ImGui.Separator();

        ImGui.SetNextItemWidth(120);
        ImGui.InputInt("Port", ref editPort);
        ImGui.Checkbox("Listen on all interfaces (LAN)", ref editBindAll);
        var autoStart = config.AutoStart;
        if (ImGui.Checkbox("Start server automatically", ref autoStart))
        {
            config.AutoStart = autoStart;
            Save();
        }

        var dirty = editPort != config.Port || editBindAll != config.BindAll;
        if (dirty) ImGui.TextColored(new Vector4(1f, 0.8f, 0.3f, 1f), "Unsaved changes");
        if (ImGui.Button("Apply and restart server"))
        {
            config.Port = Math.Clamp(editPort, 1024, 65535);
            config.BindAll = editBindAll;
            editPort = config.Port;
            Save();
            host.Restart();
        }

        ImGui.Separator();

        var token = config.AccessToken;
        ImGui.SetNextItemWidth(320);
        ImGui.InputText("Access token", ref token, 128, ImGuiInputTextFlags.ReadOnly);
        ImGui.SameLine();
        if (ImGui.Button("Regenerate"))
        {
            config.AccessToken = Configuration.GenerateToken();
            Save();
        }

        ImGui.Separator();
        ImGui.TextUnformatted("Open one of these on your other device:");
        RefreshAddresses();
        var addrs = config.BindAll ? lanAddresses : new List<string> { "localhost" };
        if (addrs.Count == 0) ImGui.TextDisabled("No LAN addresses found.");
        for (var i = 0; i < addrs.Count; i++)
        {
            var url = $"http://{addrs[i]}:{config.Port}/?token={config.AccessToken}";
            ImGui.PushID(i);
            if (ImGui.Button("Copy")) ImGui.SetClipboardText(url);
            ImGui.SameLine();
            ImGui.TextUnformatted(url);
            ImGui.PopID();
        }

        // TODO: render a QR code for the first URL so a phone/tablet can scan it.
        ImGui.Spacing();
        ImGui.TextDisabled("Windows Firewall must allow inbound TCP on the port above for LAN access (see README).");
    }

    private void Save() => pi.SavePluginConfig(config);

    private void RefreshAddresses()
    {
        if ((DateTime.UtcNow - lastAddressRefresh).TotalSeconds < 5) return;
        lastAddressRefresh = DateTime.UtcNow;

        var list = new List<string>();
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up) continue;
                if (nic.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel) continue;
                foreach (var ua in nic.GetIPProperties().UnicastAddresses)
                {
                    var ip = ua.Address;
                    if (ip.AddressFamily != AddressFamily.InterNetwork) continue;
                    if (IPAddress.IsLoopback(ip)) continue;
                    var b = ip.GetAddressBytes();
                    if (b[0] == 169 && b[1] == 254) continue; // link-local
                    list.Add(ip.ToString());
                }
            }
        }
        catch (Exception)
        {
            // Network enumeration can fail transiently; keep the previous list.
            return;
        }

        lanAddresses = list;
    }
}
