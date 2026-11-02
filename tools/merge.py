"""合併 research/legNN.json → data/route.json，處理段落銜接並驗證。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEGS = ["01", "02", "03", "04", "05"]

# --- 段落銜接設定 -----------------------------------------------------------
# leg02 開頭（巴拿馬城→巴拿馬西部）與 leg01 結尾重疊，以 leg01 日誌為準
DROP_WAYPOINTS = {"w02-001", "w02-002", "w02-003", "w02-004", "w04-001"}
DROP_SEGMENTS = {"s02-001", "s02-002", "s02-003"}
REMAP = {
    "w02-001": "w01-160",  # Bridge of the Americas
    "w02-002": "w01-161",
    "w02-003": "w01-162",
    "w04-001": "w03-028",  # 俄蒙邊境（未知）兩段重複
}
# 日誌座標明顯不合理（落在海上）：不採用，原值保留在 reported_lat/lon
COORD_REJECT = {
    "w01-002": "日誌座標經度可疑（研究時已標記），換算位置落在 Otway 灣海面上；第一天實際是沿主幹道北行。",
    "w02-013": "日誌座標 14°21'N 92°10'W 落在太平洋外海約 15 km，可能是抄寫誤差。",
}
SEGMENT_FROM_OVERRIDE = {"s02-004": "w01-165"}  # 哥斯大黎加邊境前 → San José
EXPLICIT_VIA = {
    "s03-013": ["w03-015", "w03-016", "w03-017", "w03-018", "w03-019"],
    "s03-019": ["w03-026"],
}
SEAM_SEGMENTS = [
    {
        "id": "x-001", "from": "w02-082", "to": "w03-001", "mode": "offroute",
        "route_basis": "unknown", "route_detail": None, "companions": [],
        "counts_as_progress": False,
        "notes": "Return to Russia 2007: flight Nome→Anadyr 15 Mar 2007, then ATV to Uelen (per leg03 s03-001 notes).",
        "sources": [],
    },
    {
        "id": "x-002", "from": "w04-021", "to": "w05-001", "mode": "walk",
        "route_basis": "unknown", "route_detail": None, "companions": [],
        "counts_as_progress": True,
        "notes": "SEAM: Caspian landfall (Nardaran) → Baku. No source describes this ~25 km link; shown as unknown.",
        "sources": [], "seam_unsourced": True,
    },
]


def main():
    out = {"waypoints": [], "segments": [], "pauses": [], "conflicts": [],
           "unknowns": [], "sources": {}, "legs": []}
    problems = []

    for n in LEGS:
        d = json.loads((ROOT / "research" / f"leg{n}.json").read_text(encoding="utf-8"))
        out["legs"].append({"leg": n, "title": d.get("title")})
        sid = lambda s: f"{n}:{s}"  # 來源 id 加上段落前綴避免衝突
        for k, v in d["sources"].items():
            out["sources"][sid(k)] = v
        fix_src = lambda refs: [sid(s) for s in (refs or [])]
        remap = lambda w: REMAP.get(w, w)

        wp_order = [w["id"] for w in d["waypoints"]]
        linked = {x for s in d["segments"] for x in (s["from"], s["to"])}
        linked |= {x for v in EXPLICIT_VIA.values() for x in v}

        for w in d["waypoints"]:
            if w["id"] in DROP_WAYPOINTS:
                continue
            w = {**w, "leg": n, "sources": fix_src(w.get("sources"))}
            if w["id"] in COORD_REJECT:
                w.update(reported_lat=w["lat"], reported_lon=w["lon"], lat=None, lon=None,
                         coord_basis="rejected", coord_issue=COORD_REJECT[w["id"]])
            out["waypoints"].append(w)

        for s in d["segments"]:
            if s["id"] in DROP_SEGMENTS:
                continue
            s = {**s, "leg": n, "sources": fix_src(s.get("sources"))}
            s["from"] = remap(SEGMENT_FROM_OVERRIDE.get(s["id"], s["from"]))
            s["to"] = remap(s["to"])
            if s["id"] in EXPLICIT_VIA:
                s["via"] = EXPLICIT_VIA[s["id"]]
            elif s["from"] in wp_order and s["to"] in wp_order:
                i, j = wp_order.index(s["from"]), wp_order.index(s["to"])
                s["via"] = [x for x in wp_order[i + 1:j] if x not in linked]
            else:
                s["via"] = []
            out["segments"].append(s)

        for p in d.get("pauses", []):
            out["pauses"].append({**p, "leg": n, "at": remap(p.get("at")),
                                  "sources": fix_src(p.get("sources"))})
        for c in d.get("conflicts", []):
            claims = [{**cl, "source": sid(cl["source"]) if cl.get("source") else None}
                      for cl in c.get("claims", [])]
            out["conflicts"].append({**c, "leg": n, "claims": claims})
        out["unknowns"] += [{"leg": n, "text": u} for u in d.get("unknowns", [])]

    # 銜接段插在「終點為其起點」的路段之後，維持時間順序
    for s in SEAM_SEGMENTS:
        idx = max(i for i, x in enumerate(out["segments"]) if x["to"] == s["from"])
        out["segments"].insert(idx + 1, {**s, "leg": "seam", "via": []})

    # --- 驗證 ---------------------------------------------------------------
    W = {w["id"]: w for w in out["waypoints"]}
    for s in out["segments"]:
        for k in ("from", "to"):
            if s[k] not in W:
                problems.append(f"{s['id']}.{k} -> missing {s[k]}")
        for v in s.get("via", []):
            if v not in W:
                problems.append(f"{s['id']}.via -> missing {v}")
        for r in s["sources"]:
            if r not in out["sources"]:
                problems.append(f"{s['id']} -> missing source {r}")
    for w in out["waypoints"]:
        for r in w["sources"]:
            if r not in out["sources"]:
                problems.append(f"{w['id']} -> missing source {r}")
    for p in out["pauses"]:
        if p["at"] and p["at"] not in W:
            problems.append(f"{p['id']}.at -> missing {p['at']}")
    used = {x for s in out["segments"] for x in (s["from"], s["to"], *s.get("via", []))}
    orphans = [w for w in W if w not in used]
    if orphans:
        problems.append(f"orphan waypoints: {orphans}")

    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data" / "route.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    seg = out["segments"]
    print(f"waypoints={len(W)} segments={len(seg)} pauses={len(out['pauses'])} "
          f"conflicts={len(out['conflicts'])} sources={len(out['sources'])}")
    print("null coords:", sum(1 for w in W.values() if w["lat"] is None))
    for m in sorted({s["mode"] for s in seg}):
        print(f"  mode {m}: {sum(1 for s in seg if s['mode'] == m)}")
    for b in sorted({str(s["route_basis"]) for s in seg}):
        print(f"  basis {b}: {sum(1 for s in seg if str(s['route_basis']) == b)}")
    print("PROBLEMS:", *problems, sep="\n  ") if problems else print("validation OK")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
