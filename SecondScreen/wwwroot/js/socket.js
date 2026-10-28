// WebSocket client with exponential-backoff auto-reconnect.
export function connect(token, { onMessage, onStatus }) {
  let ws = null;
  let delay = 500;
  let closed = false;
  let timer = null;

  const open = () => {
    onStatus("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => { delay = 500; onStatus("online"); };
    ws.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch (e) { console.warn("bad message", e); }
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus("offline");
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 1.7, 10000);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  };

  // Reconnect promptly when the tab/app returns to the foreground (iOS suspends sockets).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (!ws || ws.readyState > 1)) {
      clearTimeout(timer); delay = 500; open();
    }
  });

  open();
  return () => { closed = true; clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } };
}
