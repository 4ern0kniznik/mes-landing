"""Готовит demo/data.js: реальный прогон решателя + правдоподобная история недели."""
import json, os, random, sys, tempfile
from datetime import datetime, timedelta

ROOT = os.environ.get("MES_ROOT", os.getcwd())
sys.path.insert(0, ROOT)
tmp = tempfile.mkdtemp()
os.environ["MES_DB_URL"] = f"sqlite:///{tmp}/demo.db"
os.environ["MES_SECRET"] = "demo-secret-demo-secret-demo"
random.seed(20260907)

from fastapi.testclient import TestClient
from app.auth import create_user
from app.db import SessionLocal, init_db
from app.models import Downtime, Operation, OperationStatus, UserRole, WorkCenter
from app.seed import seed

now = datetime.now().replace(second=0, microsecond=0)
horizon_start = (now - timedelta(days=6)).replace(hour=8, minute=0)

init_db()
s = SessionLocal()
stats = seed(s, horizon_start=horizon_start)
create_user(s, "demo", "demo-demo-1", UserRole.MASTER, full_name="Демо-мастер")
s.commit()
s.close()

from app.main import app  # noqa: E402

c = TestClient(app)
c.post("/api/auth/login", json={"login": "demo", "password": "demo-demo-1"}).raise_for_status()
# добираем загрузку до полной недели цеха — иначе OEE считается по полупустому календарю
ITEMS = ["KRN-100", "VAL-220", "RAM-050", "KRP-310", "UZL-700"]
for i in range(38):
    code = f"ЗП-09{i + 21:02d}"
    r = c.post("/api/reference/orders", json={
        "code": code,
        "item_code": ITEMS[i % len(ITEMS)],
        "qty": [18, 24, 30, 12, 40][i % 5],
        "lot_size": 20 if i % 5 == 0 else None,
        "due_date": (horizon_start + timedelta(days=4 + i // 2)).isoformat(),
        "priority": (i % 3) + 1,
    })
    if r.status_code != 201:
        raise SystemExit(f"заказ {code} не создан: {r.status_code} {r.text}")
print("заказов всего:", len(c.get("/api/reference/orders").json()))

solve = c.post("/api/plan/solve", json={
    "horizon_start": horizon_start.isoformat(), "horizon_days": 21,
    "max_seconds": 60, "apply": True}).json()
if "status" not in solve:
    raise SystemExit(f"решатель не отработал: {solve}")
print("solve:", solve["status"], solve["solve_seconds"], "с, операций", solve["operations"])

# --- история: то, что по плану уже прошло, закрываем с реальным разбросом ---
s = SessionLocal()
done = started = 0
for op in s.query(Operation).filter(Operation.planned_start.isnot(None)).all():
    if op.planned_end and op.planned_end <= now:
        delay = random.randint(0, 12)
        factor = random.uniform(0.97, 1.10)
        op.actual_start = op.planned_start + timedelta(minutes=delay)
        op.actual_end = op.actual_start + timedelta(minutes=round(op.duration_minutes * factor))
        if op.actual_end > now:
            op.actual_end = now
        op.status = OperationStatus.DONE
        qty = max(1, op.lot_qty or op.order.qty)
        op.qty_scrap = 1 if random.random() < 0.22 else 0
        op.qty_good = max(0, qty - op.qty_scrap)
        done += 1
    elif op.planned_start and op.planned_start <= now < (op.planned_end or now):
        op.actual_start = op.planned_start + timedelta(minutes=random.randint(0, 20))
        op.status = OperationStatus.IN_PROGRESS
        started += 1

# на нескольких центрах смена уже идёт — иначе терминал выглядит пустым
for wc_code in ("ASSY", "CNC", "WELD", "QC"):
    nxt = (
        s.query(Operation)
        .join(WorkCenter, Operation.work_center_id == WorkCenter.id)
        .filter(WorkCenter.code == wc_code, Operation.status == OperationStatus.PLANNED)
        .order_by(Operation.planned_start)
        .first()
    )
    if nxt is not None:
        nxt.actual_start = now - timedelta(minutes=random.randint(10, 50))
        nxt.status = OperationStatus.IN_PROGRESS
        started += 1

# два закрытых простоя за неделю — иначе доступность выглядит стерильно
codes = {wc.code: wc.id for wc in s.query(WorkCenter).all()}
for code, reason, day, hour, minutes in [
    ("CNC", "Поломка оборудования", 4, 11, 95),
    ("WELD", "Нет материала", 2, 14, 55),
]:
    st = (now - timedelta(days=day)).replace(hour=hour, minute=0)
    s.add(Downtime(work_center_id=codes[code], reason=reason,
                   started_at=st, ended_at=st + timedelta(minutes=minutes)))
s.commit()
s.close()
print(f"история: закрыто {done}, в работе {started}")

wcs = c.get("/api/reference/work-centers").json()
data = {
    "meta": {"generated": now.isoformat(timespec="seconds"), "solve": solve, "seed": stats,
             "history": {"done": done, "in_progress": started}},
    "gantt": c.get("/api/plan/gantt-data").json(),
    "load": c.get("/api/reports/load").json(),
    "oee": c.get("/api/reports/oee?days=7").json(),
    "wip": c.get("/api/reports/wip").json(),
    "work_centers": wcs,
    "downtime_reasons": c.get("/api/terminal/downtime-reasons").json(),
    "queues": {wc["code"]: c.get(f"/api/terminal/queue/{wc['code']}").json() for wc in wcs},
}
empty = [q for q, v in data["queues"].items() if not v["queue"]]
print("OEE:", [(r["work_center"], r["availability"], r["performance"], r["quality"], r["oee"]) for r in data["oee"]])
print("очереди пусты у:", empty or "нет")

out = os.path.join(ROOT, "landing", "demo")
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "data.js"), "w", encoding="utf-8") as f:
    f.write("window.MES_DEMO = " + json.dumps(data, ensure_ascii=False, default=str, indent=1) + ";\n")
print("записан", os.path.join(out, "data.js"))
