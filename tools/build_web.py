"""data/route.json → web/data/expedition.json（地圖線段、動畫鏈、時間軸、考證資料）。"""
import json
import math
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EPOCH = date(1970, 1, 1)

# 依考證報告的人工分類
DEADEND_OVERRIDE = {"s03-005"}           # Amguema → Egvekinot 支線（出境用，之後從 Amguema 重起）
SIDEWALK = {"s03-013"}
ROUTABLE = {"walk", "deadend", "sidewalk"}   # 這些類別嘗試沿道路畫線（游泳、海冰、離線不套用）                   # 2013–14 洛杉磯 → 華府請願步行（不算進度）
# 資料明載走在海冰上的路段
ICE_OVERRIDE = {"s02-062", "s02-063"}  # Norton Bay：route_detail 'straight across Norton Bay sea ice'
# 冬季無道路、只知經過點，直線會穿過海灣：改以「路徑未知」呈現
WATER_STRAIGHT = {"s02-061", "s02-064", "s02-066", "s02-068", "s02-071", "s03-002", "s03-003", "s03-004"}
WATER_NOTE = "冬季無道路，只知經過點；兩點直線會穿過海灣，實際應沿海岸、岸冰或內陸小徑行進，確切路徑未知。"
# 走支線出境、之後從支線起點重新出發時，停頓記錄在支線終點：重新出發的時間要套用該停頓
PAUSE_ALIAS = {"w03-005": "w03-006"}  # Amguema 重新起步 ← Egvekinot 出境後的停頓（2007/5–8）
POSSIBLE_GAP = {"s01-086": "2000/1/4 在 Arequipa 附近搭卡車回泛美公路，下車處是否就是 1999/12/1 離開公路的路口，日誌無法確認——可能有一段未步行。"}

DATE_RE = re.compile(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?")


def parse_day(s):
    """取字串中第一個日期，回傳 epoch 天數；月精度取 15 日、年精度取 7/1。"""
    if not s:
        return None
    m = DATE_RE.search(str(s))
    if not m:
        return None
    y, mo, d = m.group(1), m.group(2), m.group(3)
    try:
        dt = date(int(y), int(mo or 7), int(d or (15 if mo else 1)))
    except ValueError:
        return None
    return (dt - EPOCH).days


def wp_time(w):
    a, b = parse_day(w.get("date_earliest")), parse_day(w.get("date_latest"))
    if a is not None and b is not None:
        return (a + b) / 2
    return parse_day(w.get("date")) if parse_day(w.get("date")) is not None else (a if a is not None else b)


def km(a, b):
    p = math.pi / 180
    la1, la2 = a[1] * p, b[1] * p
    dla, dlo = la2 - la1, (b[0] - a[0]) * p
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def unwrap(coords):
    """避免跨國際換日線的線段繞地球一圈。"""
    out = [list(coords[0])]
    for lon, lat in coords[1:]:
        prev = out[-1][0]
        while lon - prev > 180:
            lon -= 360
        while lon - prev < -180:
            lon += 360
        out.append([lon, lat])
    return out


def arc(a, b, n=24):
    """離線移動畫成弧線，與實際路徑區分。"""
    (x1, y1), (x2, y2) = a, b
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    dx, dy = x2 - x1, y2 - y1
    off = 0.18
    cx, cy = mx - dy * off, my + dx * off
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append([(1 - t) ** 2 * x1 + 2 * (1 - t) * t * cx + t * t * x2,
                    (1 - t) ** 2 * y1 + 2 * (1 - t) * t * cy + t * t * y2])
    return pts


def category(s):
    if s["id"] in SIDEWALK:
        return "sidewalk"
    if s["mode"] in ("offroute", "other"):
        return "offroute"
    if s["id"] in DEADEND_OVERRIDE or not s["counts_as_progress"]:
        return "deadend"
    if s["id"] in ICE_OVERRIDE:
        return "ice"
    return s["mode"]  # walk / swim / ice


def main():
    d = json.loads((ROOT / "data" / "route.json").read_text(encoding="utf-8"))
    W = {w["id"]: w for w in d["waypoints"]}
    has = lambda wid: W[wid]["lat"] is not None
    pt = lambda wid: [W[wid]["lon"], W[wid]["lat"]]

    pause_end, pause_start = {}, {}
    for p in d["pauses"]:
        e, b = parse_day(p.get("end")), parse_day(p.get("start"))
        if p.get("at") and e is not None:
            pause_end[p["at"]] = max(pause_end.get(p["at"], e), e)
        if p.get("at") and b is not None:
            pause_start[p["at"]] = min(pause_start.get(p["at"], b), b)

    # --- 1. 合併經過無座標點的連續路段 ------------------------------------
    feats, pending = [], None
    for s in d["segments"]:
        cat = category(s)
        if pending is None and not has(s["from"]):
            continue  # 起點未知且無前段可接（例如伊朗邊境 → 阿什哈巴德）：只留在資料中
        if pending is not None:
            pending["members"].append(s["id"])
            pending["unknown_basis"] |= s["route_basis"] == "unknown"
            if has(s["to"]):
                pending["to"] = s["to"]
                pending["via"] += [v for v in s["via"] if has(v)]
                if all(W[x]["coord_basis"] == "rejected" for x in pending["nulls"]):
                    pending["gap"] = False
                    pending["uncertain"] = pending["unknown_basis"]
                feats.append(pending)
                pending = None
            else:
                pending["nulls"].append(s["to"])
            continue
        if not has(s["to"]):
            pending = {"members": [s["id"]], "from": s["from"], "via": [v for v in s["via"] if has(v)],
                       "cat": cat, "mode": s["mode"], "progress": s["counts_as_progress"] and cat in ("walk", "swim", "ice"),
                       "uncertain": True, "gap": True, "nulls": [s["to"]],
                       "unknown_basis": s["route_basis"] == "unknown"}
            continue
        feats.append({"members": [s["id"]], "from": s["from"], "to": s["to"],
                      "via": [v for v in s["via"] if has(v)], "cat": cat, "mode": s["mode"],
                      "progress": s["counts_as_progress"] and cat in ("walk", "swim", "ice"),
                      "uncertain": s["route_basis"] == "unknown" or s["id"] in WATER_STRAIGHT, "gap": False,
                      "water_note": WATER_NOTE if s["id"] in WATER_STRAIGHT else None})
    assert pending is None, pending
    for i, f in enumerate(feats):
        f["fid"] = i

    # --- 2. 幾何（可沿道路的路段套用 tools/route_roads.py 的快取）------------
    cache_path = ROOT / "data" / "road_cache.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    raw_list = []
    for f in feats:
        raw = [pt(f["from"])] + [pt(v) for v in f["via"]] + [pt(f["to"])]
        key = "|".join([f["from"], *f["via"], f["to"]])
        f["road"] = None
        if f["cat"] in ROUTABLE:
            raw_list.append({"key": key, "cat": f["cat"], "raw": raw})
            entry = cache.get(key)
            if entry and entry["raw"] == raw:
                line = []
                for i, leg in enumerate(entry["legs"]):
                    seg = leg["coords"] if leg["ok"] else [raw[i], raw[i + 1]]
                    line += seg if not line else seg[1:]
                f["road"] = {"ok": sum(l["ok"] for l in entry["legs"]), "n": len(entry["legs"]),
                             "fail": sorted({l["reason"] for l in entry["legs"] if not l["ok"]})}
                raw = line
        raw = unwrap(raw)
        f["coords"] = arc(raw[0], raw[-1]) if f["cat"] == "offroute" else raw
        f["km"] = sum(km(a, b) for a, b in zip(raw, raw[1:]))
    (ROOT / "data" / "raw_features.json").write_text(json.dumps(raw_list), encoding="utf-8")

    # --- 3. 時間：進度鏈 ---------------------------------------------------
    prog = [f for f in feats if f["progress"]]
    nodes = []  # (feature, 'start'|'end', time or None, cumulative km)
    cum = 0.0
    for f in prog:
        t0 = wp_time(W[f["from"]])
        for k in (f["from"], PAUSE_ALIAS.get(f["from"])):
            if t0 is not None and k in pause_end:
                t0 = max(t0, pause_end[k])
        nodes.append([f, "start", t0, cum])
        cum += f["km"]
        # 終點若有停頓，抵達時間取停頓開始（終點日期常是「離開」或「下一階段開始」的日期）
        te = wp_time(W[f["to"]])
        if te is not None and pause_start.get(f["to"]) is not None:
            te = min(te, pause_start[f["to"]])
        nodes.append([f, "end", te, cum])
    # 單調化（月精度造成的倒退）
    last = None
    for n in nodes:
        if n[2] is not None:
            if last is not None and n[2] < last:
                n[2] = last
            last = n[2]
    # 未知時間依累計距離內插
    known = [i for i, n in enumerate(nodes) if n[2] is not None]
    for i, n in enumerate(nodes):
        if n[2] is None:
            a = max(k for k in known if k < i)
            b = min(k for k in known if k > i)
            ka, kb = nodes[a][3], nodes[b][3]
            r = (n[3] - ka) / (kb - ka) if kb > ka else (i - a) / (b - a)
            n[2] = nodes[a][2] + r * (nodes[b][2] - nodes[a][2])
            n.append(True)  # interpolated
    for n in nodes:
        key = "t0" if n[1] == "start" else "t1"
        n[0][key] = n[2]
        n[0][key + "_interp"] = len(n) > 4
        n[0]["km0" if n[1] == "start" else "km1"] = n[3]

    # 非進度路段的時間
    last_t = nodes[0][2]
    for f in feats:
        if f["progress"]:
            last_t = f["t1"]
            continue
        a, b = wp_time(W[f["from"]]), wp_time(W[f["to"]])
        f["t0"] = a if a is not None else last_t
        f["t1"] = b if b is not None else f["t0"]
        if f["t1"] < f["t0"]:
            f["t1"] = f["t0"]
        f["t0_interp"] = a is None
        f["t1_interp"] = b is None

    # 經過無座標點的路段：若該點有停頓，動畫在路段中途停住（位置僅示意，該段本為路徑未知）
    for f in prog:
        knots = [(0.0, f["t0"])]
        n = len(f["members"])
        for j, x in enumerate(f.get("nulls", [])):
            if x in pause_start and x in pause_end:
                r = (j + 1) / n
                a = min(max(pause_start[x], knots[-1][1]), f["t1"])
                b = min(max(pause_end[x], a), f["t1"])
                knots += [(r, a), (r, b)]
        knots.append((1.0, f["t1"]))
        f["knots"] = knots

    def time_at(knots, q):
        for (r0, a), (r1, b) in zip(knots, knots[1:]):
            if r0 <= q <= r1 and r1 > r0:
                return a + (q - r0) / (r1 - r0) * (b - a)
        return knots[-1][1] if q >= 1 else knots[0][1]

    # --- 4. 動畫鏈：每個頂點的時間與累計距離 -------------------------------
    chain = []
    for f in prog:
        c = f["coords"]
        seglens = [km(a, b) for a, b in zip(c, c[1:])]
        tot = sum(seglens) or 1
        verts, acc = [], 0
        for i, p in enumerate(c):
            if i:
                acc += seglens[i - 1]
            verts.append((acc / tot, p, acc))
        for r, t in f["knots"][1:-1]:  # 停住點：在該比例位置插入兩個同座標頂點
            target, acc = r * tot, 0
            for i, L in enumerate(seglens):
                if acc + L >= target:
                    u = (target - acc) / L if L else 0
                    a, b = c[i], c[i + 1]
                    verts.append((r, [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], target, t))
                    break
                acc += L
        out_v = []
        for v in verts:
            t = v[3] if len(v) > 3 else time_at(f["knots"], v[0])
            out_v.append((v[0], t, v[1], v[2]))
        out_v.sort(key=lambda v: (v[0], v[1]))
        for q, t, p, a in out_v:
            chain.append([round(p[0], 4), round(p[1], 4), round(t, 2), round(f["km0"] + a, 1), f["fid"]])
    # --- 5. 輸出 -----------------------------------------------------------
    S = {s["id"]: s for s in d["segments"]}
    features = []
    for i, f in enumerate(feats):
        gap_note = next((POSSIBLE_GAP[m] for m in f["members"] if m in POSSIBLE_GAP), None)
        features.append({
            "type": "Feature", "id": i,
            "geometry": {"type": "LineString", "coordinates": [[round(x, 4), round(y, 4)] for x, y in f["coords"]]},
            "properties": {
                "fid": i, "cat": f["cat"], "mode": f["mode"], "uncertain": f["uncertain"],
                "gap": f["gap"], "progress": f["progress"], "members": f["members"],
                "leg": S[f["members"][0]]["leg"], "from": f["from"], "to": f["to"],
                "t0": round(f["t0"], 2), "t1": round(f["t1"], 2),
                "t0_interp": f["t0_interp"], "t1_interp": f["t1_interp"],
                "km": round(f["km"], 1), "possible_gap": gap_note, "road": f["road"],
                "water_note": f.get("water_note"),
            },
        })
    pauses = []
    for p in d["pauses"]:
        a, b = parse_day(p.get("start")), parse_day(p.get("end"))
        if a is None and b is None:
            continue
        w = W.get(p.get("at")) if p.get("at") else None
        pauses.append({**p, "t0": a if a is not None else b, "t1": b if b is not None else a,
                       "lon": w["lon"] if w else None, "lat": w["lat"] if w else None})

    # --- 6. 中文簡述與導覽分節 ---------------------------------------------
    zh_wp, zh_pause = {}, {}
    for f in sorted((ROOT / "research" / "zh").glob("leg*_zh.json")):
        z = json.loads(f.read_text(encoding="utf-8"))
        zh_wp.update(z.get("waypoints", {}))
        zh_pause.update(z.get("pauses", {}))
    for wid, w in W.items():
        if wid in zh_wp:
            w["zh_name"] = zh_wp[wid].get("name")
            w["zh_summary"] = zh_wp[wid].get("summary")
    for p in pauses:
        if p["id"] in zh_pause:
            p["zh_reason"] = zh_pause[p["id"]]
    missing_zh = [k for k in W if k not in zh_wp]
    sections = {}
    for f in sorted((ROOT / "research" / "story").glob("ch*.json")):
        z = json.loads(f.read_text(encoding="utf-8"))
        prev = None
        for sec in z["sections"]:
            bad = [x for x in sec.get("wps", []) if x not in W]
            if bad:
                print(f"  {f.name}: unknown wps {bad}")
                sec["wps"] = [x for x in sec["wps"] if x in W]
            if parse_day(sec["from"]) is None or parse_day(sec["to"]) is None or parse_day(sec["to"]) < parse_day(sec["from"]):
                print(f"  {f.name}: bad window {sec['from']}→{sec['to']}")
            if prev and parse_day(sec["from"]) < prev:
                print(f"  {f.name}: section '{sec['title']}' starts before previous ends")
            prev = parse_day(sec["to"])
        sections[str(z["chapter"])] = z["sections"]

    # --- 7. 圖片：國旗（tools/countries.py）、附近知名地點（tools/fetch_places.py）、Karl 本人照片（research/photos）
    def load_opt(path):
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    country = load_opt(ROOT / "data" / "wp_country.json")
    places = load_opt(ROOT / "data" / "wp_places.json")
    # 沒對應經過點的照片只放進導覽章節（依 id 前綴人工歸章，見 research/photos 各檔的 region/date）
    PHOTO_CHAPTER = [("kb-bs-", 9), ("kb-ru-07", 12), ("kb-ru-", 11), ("kb-mn-", 15), ("kb-uz-01", 16), ("kb-uz-02", 16),
                     ("kb-uz-", 17), ("kb-kz-", 17), ("kb-cs-01", 17), ("kb-cs-02", 17), ("kb-cs-", 18), ("kb-tr-", 19),
                     ("kb-uk-", 21)]
    REGION_CHAPTER = {"Argentina": 1, "Chile": 2, "Peru": 3, "Ecuador": 3, "Colombia": 4, "Darien": 5, "Panama": 6,
                      "Costa Rica": 6, "Nicaragua": 6, "Guatemala": 6, "El Salvador": 6, "Mexico": 6, "USA": 7,
                      "Canada": 8, "Alaska": 8, "Bering Strait": 9, "Russia": 10}
    # 兩份檔案重複的白令海峽照片：保留說明較完整的 karl_01_02 版本
    PHOTO_DROP = {"kb-bs-01", "kb-bs-02", "kb-bs-03"}
    # 只靠日期相同配到經過點、說明沒寫地名的照片：不放在經過點上
    PHOTO_UNPLACE = {"kb0102-012", "kb0102-013"}
    photo_list = []
    for f in sorted((ROOT / "research" / "photos").glob("karl_*.json")):
        for ph in json.loads(f.read_text(encoding="utf-8")).get("photos", []):
            if not ph.get("image_url") or ph.get("id") in PHOTO_DROP:
                continue
            if ph.get("id") in PHOTO_UNPLACE:
                ph["waypoint"] = None
            if ph.get("waypoint") and ph["waypoint"] not in W:
                print(f"  {f.name}: photo {ph.get('id')} has unknown waypoint {ph['waypoint']}")
                ph["waypoint"] = None
            ch = (ph.get("chapter") or next((c for pre, c in PHOTO_CHAPTER if (ph.get("id") or "").startswith(pre)), None)
                  or REGION_CHAPTER.get(ph.get("region")))
            photo_list.append({k: ph.get(k) for k in ("id", "image_url", "page_url", "caption_en", "caption_zh",
                                                       "caption_type", "date", "place", "credit", "waypoint")}
                              | {"chapter": ch, "small": (ph.get("image_variant") or "").startswith("thumbnail")})
    photos = {}
    for i, ph in enumerate(photo_list):
        if ph["waypoint"]:
            photos.setdefault(ph["waypoint"], []).append(i)
    orphan = [ph["id"] for ph in photo_list if not ph["waypoint"] and not ph["chapter"]]
    if orphan:
        print("  photos with neither waypoint nor chapter:", orphan)
    for wid, w in W.items():
        if country.get(wid):
            w["country"] = country[wid]
        if places.get(wid):
            w["place"] = places[wid]
        if photos.get(wid):
            w["photos"] = photos[wid]
    no_img = [wid for wid, w in W.items() if not (w.get("place") or w.get("photos"))]
    print(f"images: flags {sum(1 for w in W.values() if (w.get('country') or {}).get('iso'))}/{len(W)}, "
          f"place photos {len(places)}, Karl photos {len(photo_list)} ({sum(len(v) for v in photos.values())} at {len(photos)} waypoints); "
          f"no photo: {len(no_img)} {no_img[:8]}")

    out = {
        "story_sections": sections,
        "photos": photo_list,
        "generated": date.today().isoformat(),
        "legs": d["legs"],
        "features": {"type": "FeatureCollection", "features": features},
        "chain": chain,
        "waypoints": W,
        "segments": S,
        "pauses": pauses,
        "sources": d["sources"],
        "conflicts": d["conflicts"],
        "unknowns": d["unknowns"],
    }
    dst = ROOT / "web" / "data" / "expedition.json"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    from collections import Counter
    print("features", len(features), Counter((f["cat"], f["uncertain"]) for f in feats))
    print("chain vertices", len(chain), "progress km (straight)", round(cum))
    print("chain span", date.fromordinal(EPOCH.toordinal() + int(chain[0][2])),
          "→", date.fromordinal(EPOCH.toordinal() + int(chain[-1][2])))
    print("interpolated nodes", sum(1 for n in nodes if len(n) > 4))
    print("size KB", dst.stat().st_size // 1024)
    print(f"zh waypoints {len(W) - len(missing_zh)}/{len(W)}, zh pauses {sum('zh_reason' in p for p in pauses)}/{len(pauses)}, "
          f"story chapters with sections {len(sections)}")


if __name__ == "__main__":
    main()
