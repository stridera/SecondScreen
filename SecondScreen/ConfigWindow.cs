using System;
using System.Collections.Generic;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Numerics;
using Dalamud.Bindings.ImGui;
using Dalamud.Interface.Utility;
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
    private string? qrAddress;
    private string? qrUrl;
    private bool[,]? qrModules;
    private string? qrError;

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
            var url = BuildUrl(addrs[i]);
            ImGui.PushID(i);
            if (ImGui.Button("Copy")) ImGui.SetClipboardText(url);
            ImGui.SameLine();
            ImGui.TextUnformatted(url);
            ImGui.PopID();
        }

        if (addrs.Count > 0) DrawQr(addrs);

        ImGui.Spacing();
        ImGui.TextDisabled("Windows Firewall must allow inbound TCP on the port above for LAN access (see README).");
    }

    private string BuildUrl(string address) => $"http://{address}:{config.Port}/?token={config.AccessToken}";

    private static bool IsPrivateLan(string address)
    {
        if (!IPAddress.TryParse(address, out var ip) || ip.AddressFamily != AddressFamily.InterNetwork) return false;
        var b = ip.GetAddressBytes();
        return b[0] == 10 || (b[0] == 192 && b[1] == 168) || (b[0] == 172 && b[1] >= 16 && b[1] <= 31);
    }

    private void DrawQr(List<string> addrs)
    {
        if (!ImGui.CollapsingHeader("QR code", ImGuiTreeNodeFlags.DefaultOpen)) return;

        // Keep the selection while it is still valid; otherwise prefer a private LAN address.
        if (qrAddress == null || !addrs.Contains(qrAddress))
            qrAddress = addrs.Find(IsPrivateLan) ?? addrs[0];

        if (addrs.Count > 1)
        {
            for (var i = 0; i < addrs.Count; i++)
            {
                if (i > 0) ImGui.SameLine();
                if (ImGui.RadioButton($"{addrs[i]}##qr{i}", addrs[i] == qrAddress)) qrAddress = addrs[i];
            }
        }

        var url = BuildUrl(qrAddress);
        if (url != qrUrl)
        {
            qrUrl = url;
            try
            {
                qrModules = QrMatrix.Build(url);
                qrError = null;
            }
            catch (Exception ex)
            {
                qrModules = null;
                qrError = ex.Message;
            }
        }

        if (qrModules == null)
        {
            ImGui.TextColored(new Vector4(1f, 0.4f, 0.4f, 1f), $"QR code failed: {qrError}");
            return;
        }

        var n = qrModules.GetLength(0);
        var count = n + 2 * QrMatrix.QuietZone;
        var target = 260f * ImGuiHelpers.GlobalScale;
        var px = Math.Max(1, (int)Math.Floor(target / count)); // whole pixels per module keeps edges crisp
        var total = px * count;

        var origin = ImGui.GetCursorScreenPos();
        var dl = ImGui.GetWindowDrawList();
        dl.AddRectFilled(origin, origin + new Vector2(total, total), 0xFFFFFFFFu);
        for (var y = 0; y < n; y++)
        {
            var x = 0;
            while (x < n)
            {
                if (!qrModules[y, x]) { x++; continue; }
                var start = x;
                while (x < n && qrModules[y, x]) x++; // merge horizontal runs of dark modules
                var p0 = origin + new Vector2((start + QrMatrix.QuietZone) * px, (y + QrMatrix.QuietZone) * px);
                dl.AddRectFilled(p0, p0 + new Vector2((x - start) * px, px), 0xFF000000u);
            }
        }

        ImGui.Dummy(new Vector2(total, total));
        ImGui.TextWrapped(url);
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
