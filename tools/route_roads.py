"""把步行類路段沿道路推算線形，結果快取到 data/road_cache.json。

來源：FOSSGIS 公開 OSRM（routing.openstreetmap.de）汽車路網。
用汽車而非步行路網，是因為 Karl 多半推車沿幹道走（泛美公路、I-15…），
步行路網會避開禁止行人的幹道而大幅繞路。

每一小段（兩個相鄰經過點之間）個別判斷是否採用道路線形，否則退回直線：
  no_route  路網找不到路（例如阿拉斯加冬季河道、楚科奇凍原）
  snap_far  經過點離最近道路太遠
  detour    道路距離遠大於直線距離，不太可能是他走的路
  ferry     路線需要搭渡輪
流程：build_web.py（產生 raw_features.json）→ 本腳本 → 再跑一次 build_web.py
"""
import json
import math
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "road_cache.json"
URL = "https://routing.openstreetmap.de/routed-car/route/v1/driving/{}?overview=false&steps=true&geometries=geojson"
UA = "goliath-expedition-map/1.0 (static research map; cached, ~1 req/s)"

MAX_SNAP_KM = 5
MAX_FERRY_KM = 2
SIMPLIFY_DEG = 0.003


def km(a, b):
    p = math.pi / 180
    h = (math.sin((b[1] - a[1]) * p / 2) ** 2
         + math.cos(a[1] * p) * math.cos(b[1] * p) * math.sin((b[0] - a[0]) * p / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(h))


def norm(lon):
    return ((lon + 540) % 360) - 180


def simplify(pts, tol):
    """Ramer–Douglas–Peucker（迭代版）。"""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = pts[i], pts[j]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy) or 1e-12
        best, idx = 0, None
        for k in range(i + 1, j):
            x, y = pts[k]
            d = abs(dy * (x - x1) - dx * (y - y1)) / L
            if d > best:
                best, idx = d, k
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def request(points):
    q = ";".join(f"{norm(x):.5f},{y:.5f}" for x, y in points)
    req = urllib.request.Request(URL.format(q), headers={"User-Agent": UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 400:
                return json.load(e)
            time.sleep(5 * (attempt + 1))
        except Exception:
            time.sleep(5 * (attempt + 1))
    return {"code": "Error"}


def judge_leg(a, b, leg, snap_a, snap_b):
    straight = km(a, b)
    if snap_a > MAX_SNAP_KM or snap_b > MAX_SNAP_KM:
        return {"ok": False, "reason": "snap_far"}
    road_km = leg["distance"] / 1000
    if road_km > 1.6 * straight + 25:
        return {"ok": False, "reason": "detour"}
    ferry = sum(s["distance"] for s in leg["steps"] if s.get("mode") == "ferry") / 1000
    if ferry > MAX_FERRY_KM:
        return {"ok": False, "reason": "ferry"}
    line = []
    for s in leg["steps"]:
        c = s["geometry"]["coordinates"]
        line += c if not line else c[1:]
    line = simplify(line, SIMPLIFY_DEG)
    if snap_a > 0.05:
        line = [[norm(a[0]), a[1]]] + line
    if snap_b > 0.05:
        line = line + [[norm(b[0]), b[1]]]
    line = [[round(x, 5), round(y, 5)] for x, y in line]
    return {"ok": True, "reason": None, "road_km": round(road_km, 1), "coords": line}


def route_feature(raw):
    legs = [None] * (len(raw) - 1)
    for i in range(len(legs)):
        if km(raw[i], raw[i + 1]) < 1:
            legs[i] = {"ok": False, "reason": "short"}
    todo = [i for i, l in enumerate(legs) if l is None]
    if not todo:
        return legs
    # 先整段一次查；若任何一段找不到路，整個請求會失敗，再改逐段查
    d = request(raw) if len(todo) == len(legs) else {"code": "skip"}
    time.sleep(1.1)
    if d.get("code") == "Ok":
        wps = d["waypoints"]
        for i, leg in enumerate(d["routes"][0]["legs"]):
            legs[i] = judge_leg(raw[i], raw[i + 1], leg, wps[i]["distance"] / 1000, wps[i + 1]["distance"] / 1000)
        return legs
    for i in todo:
        d = request([raw[i], raw[i + 1]])
        time.sleep(1.1)
        if d.get("code") != "Ok":
            legs[i] = {"ok": False, "reason": "no_route"}
            continue
        wps = d["waypoints"]
        legs[i] = judge_leg(raw[i], raw[i + 1], d["routes"][0]["legs"][0], wps[0]["distance"] / 1000, wps[1]["distance"] / 1000)
    return legs


def main():
    feats = json.loads((ROOT / "data" / "raw_features.json").read_text(encoding="utf-8"))
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    todo = [f for f in feats if cache.get(f["key"], {}).get("raw") != f["raw"]]
    print(f"{len(feats)} features, {len(todo)} to route", flush=True)
    for n, f in enumerate(todo, 1):
        legs = route_feature(f["raw"])
        cache[f["key"]] = {"raw": f["raw"], "legs": legs}
        CACHE.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")
        ok = sum(l["ok"] for l in legs)
        print(f"[{n}/{len(todo)}] {f['key']}: {ok}/{len(legs)} legs on road "
              f"{[l['reason'] for l in legs if not l['ok']]}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
