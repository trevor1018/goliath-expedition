"""替每個經過點判定所在國家（國旗用），輸出 data/wp_country.json。

用法：python tools/countries.py <ne_10m_admin_0_countries.geojson>

- 有座標：點在國界多邊形內 → 該國（basis=polygon）；不在任何國內但 8 km 內有國界 → 最近國（basis=near，海岸線誤差）；
  否則視為海上（iso=null，basis=sea）。
- 沒座標：名稱裡寫明國名 → 該國（basis=name）；前後已知點同一國 → 該國（basis=neighbors）；否則未知。
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEAR_KM = 15.0
ZH_SHORT = {"cn": "中國", "ec": "厄瓜多", "mn": "蒙古"}
EN_SHORT = {"cn": "China", "us": "United States"}
# 名稱中的地區名 → 國家（ISO）
ALIAS = {"alaska": "us", "chukotka": "ru", "yakutia": "ru", "siberia": "ru", "xinjiang": "cn", "china": "cn"}


def load(path):
    out = []
    for f in json.loads(Path(path).read_text(encoding="utf-8"))["features"]:
        p = f["properties"]
        iso = p.get("ISO_A2_EH") or p.get("ISO_A2")
        if not iso or iso == "-99":
            continue
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        rings = []
        for poly in polys:
            for k, ring in enumerate(poly):
                xs, ys = [q[0] for q in ring], [q[1] for q in ring]
                rings.append((min(xs), min(ys), max(xs), max(ys), ring, k > 0))
        zh = ZH_SHORT.get(iso.lower()) or p.get("NAME_ZHT") or p["NAME_EN"]
        en = EN_SHORT.get(iso.lower(), p["NAME_EN"])
        out.append({"iso": iso.lower(), "en": en, "en_full": p["NAME_EN"], "zh": zh, "rings": rings})
    return out


def inside(ring, x, y):
    c = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def km(a, b):
    p = math.pi / 180
    h = (math.sin((b[1] - a[1]) * p / 2) ** 2
         + math.cos(a[1] * p) * math.cos(b[1] * p) * math.sin((b[0] - a[0]) * p / 2) ** 2)
    return 2 * 6371 * math.asin(min(1, math.sqrt(h)))


def locate(cs, x, y):
    for c in cs:
        hits = 0
        for x0, y0, x1, y1, ring, hole in c["rings"]:
            if x0 <= x <= x1 and y0 <= y <= y1 and inside(ring, x, y):
                hits += -1 if hole else 1
        if hits > 0:
            return c, "polygon"
    best, bd = None, NEAR_KM
    for c in cs:
        for x0, y0, x1, y1, ring, hole in c["rings"]:
            if x0 - 0.2 <= x <= x1 + 0.2 and y0 - 0.2 <= y <= y1 + 0.2:
                for q in ring[::2]:
                    d = km((x, y), q)
                    if d < bd:
                        best, bd = c, d
    return (best, "near") if best else (None, "sea")


def main(path):
    cs = load(path)
    route = json.loads((ROOT / "data" / "route.json").read_text(encoding="utf-8"))
    wps = route["waypoints"]
    res = {}
    for w in wps:
        if w.get("lat") is None:
            continue
        c, basis = locate(cs, w["lon"], w["lat"])
        res[w["id"]] = {"iso": c["iso"], "en": c["en"], "zh": c["zh"], "basis": basis} if c else {"iso": None, "basis": "sea"}
    by_iso = {c["iso"]: c for c in cs}

    def named(text):
        t = text.lower()
        hits = [(t.find(c["en_full"].lower()), c) for c in cs if c["en_full"].lower() in t]
        hits += [(t.find(k), by_iso[v]) for k, v in ALIAS.items() if k in t]
        out = []
        for _, c in sorted(hits, key=lambda h: h[0]):
            if c not in out:
                out.append(c)
        return out

    for i, w in enumerate(wps):
        if w["id"] in res:
            if res[w["id"]]["basis"] == "sea":
                hit = named(w["name"])
                if hit:
                    res[w["id"]] = {"iso": hit[0]["iso"], "en": hit[0]["en"], "zh": hit[0]["zh"], "basis": "name"}
            continue
        hit = named(w["name"])
        if hit:
            res[w["id"]] = {"iso": hit[0]["iso"], "en": hit[0]["en"], "zh": hit[0]["zh"], "basis": "name"}
            if len(hit) > 1:
                res[w["id"]]["also"] = [{"iso": c["iso"], "en": c["en"], "zh": c["zh"]} for c in hit[1:]]
            continue
        prev = next((res[v["id"]] for v in reversed(wps[:i]) if v["id"] in res and v.get("lat") is not None), None)
        nxt = next((res[v["id"]] for v in wps[i + 1:] if v["id"] in res and v.get("lat") is not None), None)
        if prev and nxt and prev.get("iso") and prev.get("iso") == nxt.get("iso"):
            res[w["id"]] = {**prev, "basis": "neighbors"}
        else:
            res[w["id"]] = {"iso": None, "basis": "unknown"}
    (ROOT / "data" / "wp_country.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    from collections import Counter
    print(Counter(v["basis"] for v in res.values()))
    print(Counter(v.get("en") for v in res.values()).most_common())
    for w in wps:
        r = res[w["id"]]
        if r["basis"] not in ("polygon",):
            print(w["id"], r["basis"], r.get("en"), "|", w["name"][:60])


if __name__ == "__main__":
    main(sys.argv[1])
