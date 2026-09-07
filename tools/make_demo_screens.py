import os, re, pathlib
ROOT = pathlib.Path(os.environ.get("MES_ROOT", os.getcwd()))
SRC = ROOT / "app" / "static"
OUT = ROOT / "landing" / "demo"
OUT.mkdir(parents=True, exist_ok=True)

SHIM = """const api = (path, options) => window.MES_DEMO_API(path, options);
"""

def patch(name, extra_head_removals, refresh_call):
    t = (SRC / name).read_text(encoding="utf-8")
    # 1. подключаем демо-стор перед основным скриптом
    marker = "<script>\nconst $ ="
    if marker not in t:
        raise SystemExit(f"{name}: не найдено начало скрипта")
    t = t.replace(marker, '<script src="data.js"></script>\n<script src="store.js"></script>\n' + marker, 1)
    # 2. заменяем сетевой api() на демо-стор
    start = t.index("async function api(path, options) {")
    end = t.index("\n}\n", start) + len("\n}\n")
    t = t[:start] + SHIM + t[end:]
    # 3. убираем ссылки на серверные маршруты
    for frag in extra_head_removals:
        if frag not in t:
            raise SystemExit(f"{name}: не найден фрагмент для удаления: {frag[:40]}")
        t = t.replace(frag, "")
    # 4. точка обновления при переключении вкладки
    t = t.replace("</script>\n</body>", f"\nwindow.MES_DEMO_REFRESH = () => {{ {refresh_call} }};\n</script>\n</body>")
    (OUT / name).write_text(t, encoding="utf-8")
    print("написан", OUT / name, len(t), "байт")

patch("master.html",
      ['<a class="btn" href="/terminal">Терминал</a>\n  <a class="btn" href="/docs">API</a>\n  '],
      "load().catch(() => {});")
patch("terminal.html", [], "render().catch(() => {});")
