"""檢查非游泳路段有沒有畫到海上。

用法：python tools/check_sea.py <ne_50m_land.geojson>
（Natural Earth 1:50m 陸地輪廓；海岸線精度約數公里，所以只回報連續 >5 km 的海上段。）
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STEP_KM = 1.0
MIN_RUN_KM = 5.0


def load_land(path):
    rings = []
    for f in json.loads(Path(path).read_text(encoding="utf-8"))["features"]:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            for k, ring in enumerate(poly):
                xs, ys = [p[0] for p in ring], [p[1] for p in ring]
                rings.append((min(xs), min(ys), max(xs), max(ys), ring, k > 0))
    grid = {}
    for i, (x0, y0, x1, y1, _, _) in enumerate(rings):
        for gx in range(math.floor(x0), math.floor(x1) + 1):
            for gy in range(math.floor(y0), math.floor(y1) + 1):
                grid.setdefault((gx, gy), []).append(i)
    return rings, grid


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


def on_land(rings, grid, x, y):
    x = ((x + 540) % 360) - 180
    hits = 0
    for i in grid.get((math.floor(x), math.floor(y)), []):
        x0, y0, x1, y1, ring, hole = rings[i]
        if x0 <= x <= x1 and y0 <= y <= y1 and inside(ring, x, y):
            hits += -1 if hole else 1
    return hits > 0


def km(a, b):
    p = math.pi / 180
    h = (math.sin((b[1] - a[1]) * p / 2) ** 2
         + math.cos(a[1] * p) * math.cos(b[1] * p) * math.sin((b[0] - a[0]) * p / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(h))


def main(land_path):
    rings, grid = load_land(land_path)
    d = json.loads((ROOT / "web" / "data" / "expedition.json").read_text(encoding="utf-8"))
    W = d["waypoints"]
    found = []
    for f in d["features"]["features"]:
        p = f["properties"]
        if p["cat"] not in ("walk", "deadend", "sidewalk"):
            continue
        c = f["geometry"]["coordinates"]
        run, worst = 0.0, 0.0
        for a, b in zip(c, c[1:]):
            L = km(a, b)
            n = max(1, int(L / STEP_KM))
            for k in range(n):
                t = (k + 0.5) / n
                x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                if on_land(rings, grid, x, y):
                    run = 0.0
                else:
                    run += L / n
                    worst = max(worst, run)
        if worst > MIN_RUN_KM:
            road = p.get("road")
            found.append((worst, p["members"], W[p["from"]]["name"], W[p["to"]]["name"],
                          f"road {road['ok']}/{road['n']} {road['fail']}" if road else "no road data"))
    for w, m, a, b, r in sorted(found, reverse=True):
        print(f"{w:7.1f} km  {','.join(m)}  {a[:40]} -> {b[:40]}  [{r}]")
    print(f"{len(found)} features with >{MIN_RUN_KM} km continuous over water")


if __name__ == "__main__":
    main(sys.argv[1])
