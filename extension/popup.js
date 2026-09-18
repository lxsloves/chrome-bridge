fetch("http://127.0.0.1:17321/health")
  .then((r) => r.json())
  .then((h) => {
    const el = document.getElementById("st");
    if (!h.ok) throw new Error("daemon down");
    el.className = h.extension ? "ok" : "bad";
    el.textContent = h.extension
      ? "已连接（ON），可以让 agent 操作这个 Chrome"
      : "守护进程在线，扩展正在握手…关掉弹窗等 1 秒再点一次";
  })
  .catch(() => {
    const el = document.getElementById("st");
    el.className = "bad";
    el.textContent = "连不上 127.0.0.1:17321。先在终端运行：python3 ~/.chrome-bridge/daemon.py";
  });
