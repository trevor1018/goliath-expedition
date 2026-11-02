"""替每個經過點找「附近的知名地點」照片（Wikidata + Wikimedia Commons），輸出 data/wp_places.json。

- 有座標：在 20 / 60 / 150 km 內找有照片（P18）的 Wikidata 項目（排除國家與一、二級行政區，它們的座標常落在首府），
  依「知名度 ÷ 距離」挑選：score = sitelinks / (1 + 距離 km / 10)，避免挑到邊界另一側較大的城市。
- 沒座標：不推測位置。名稱裡寫明的地區（REGION_ITEM，例如「Kolyma 公路」「新疆」）用該地區的照片；
  其餘用前一個有座標經過點的照片，並在說明中註明。
- 照片用 Commons 的 500 px 縮圖直接連結（web/img/places/ 有本機檔時優先用本機檔），作者與授權取自 Commons。
- 查詢結果快取在 data/places_cache.json，重跑只補缺的。

用法：python tools/fetch_places.py
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "places_cache.json"
IMG_DIR = ROOT / "web" / "img" / "places"
UA = "GoliathExpeditionMap/1.0 (personal research map; python urllib)"
RADII = [20, 60, 150]
# 人工排除：照片是地圖或不具代表性的項目
EXCLUDE_QIDS = {
    "Q909566",   # Outer Mongolia（歷史地區，照片是地圖）
    "Q1544714",  # State Great Khural（國會，照片是議員）
    "Q484433",   # Almaty Metro
    "Q2391429",  # 1948 Ashgabat earthquake（事件）
    "Q46362",    # Congress of Vienna（事件）
    "Q200173",   # South Caucasus（大區域）
    "Q386864", "Q428081", "Q4468436",  # 機場
    "Q1783660",  # Saraguros（族群，不是地點）
    "Q629818",   # Estadio Regional de Antofagasta（體育場）
}
# 經過點就在該城市，但城市本身是一級行政區而被查詢排除 → 直接指定城市項目
CITY_ITEM = {"w04-002": "Q23430", "w04-008": "Q35493", "w04-014": "Q23438", "w05-020": "Q1741", "w05-001": "Q9248"}
# 沒座標、但名稱指出所在地區的經過點 → 該地區的 Wikidata 項目
REGION_ITEM = {
    "w03-007": "Q7984",     # 'Valinistiy' mining camp ~200 km from Amguema → Chukotka
    "w03-009": "Q7984",     # Dvoynoye mining camp, between Komsomolsky and Bilibino → Chukotka
    "w03-012": "Q78879",    # Stadukhinskaya channel, Nizhnekolymsky district → Kolyma River
    "w03-023": "Q1142859",  # Road of Bones (R504 Kolyma Highway)
    "w04-004": "Q42070",    # Mongolian desert → Gobi Desert
    "w04-006": "Q34800",    # Xinjiang police stop → Xinjiang
}
WIDTH = 500

try:
    from opencc import OpenCC
    s2t = OpenCC("s2twp").convert
except ImportError:
    s2t = None


def get(url, data=None, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            wait = 5 * (k + 1)
            if getattr(e, "code", None) == 429:
                wait = max(30 * (k + 1), int(e.headers.get("Retry-After") or 0))
            print("  retry", k, e, f"wait {wait}s", file=sys.stderr, flush=True)
            time.sleep(wait)
    raise RuntimeError(url)


def sparql(q):
    body = urllib.parse.urlencode({"query": q, "format": "json"}).encode()
    time.sleep(1.0)
    return json.loads(get("https://query.wikidata.org/sparql", body))["results"]["bindings"]


def nearby(lat, lon, r):
    q = f"""SELECT ?item ?img ?sl ?dist WHERE {{
  SERVICE wikibase:around {{ ?item wdt:P625 ?loc .
    bd:serviceParam wikibase:center "Point({lon} {lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "{r}" . bd:serviceParam wikibase:distance ?dist . }}
  ?item wdt:P18 ?img . ?item wikibase:sitelinks ?sl .
  FILTER NOT EXISTS {{ ?item wdt:P31/wdt:P279? ?adm . VALUES ?adm {{ wd:Q6256 wd:Q10864048 wd:Q13220204 wd:Q3624078 }} }}
}} ORDER BY DESC(?sl) LIMIT 12"""
    return [{"qid": b["item"]["value"].rsplit("/", 1)[1],
             "file": urllib.parse.unquote(b["img"]["value"].rsplit("/", 1)[1]),
             "sitelinks": int(b["sl"]["value"]), "dist_km": round(float(b["dist"]["value"]), 1)} for b in sparql(q)]


def items(qids):
    vals = " ".join(f"wd:{q}" for q in sorted(set(qids)))
    q = f"SELECT ?item ?img ?sl WHERE {{ VALUES ?item {{ {vals} }} ?item wdt:P18 ?img ; wikibase:sitelinks ?sl . }}"
    out = {}
    for b in sparql(q):
        qid = b["item"]["value"].rsplit("/", 1)[1]
        out.setdefault(qid, {"qid": qid, "file": urllib.parse.unquote(b["img"]["value"].rsplit("/", 1)[1]),
                             "sitelinks": int(b["sl"]["value"])})
    return out


def labels(qids):
    out = {}
    qids = sorted(set(qids))
    for i in range(0, len(qids), 50):
        url = ("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|descriptions"
               "&languages=zh-tw|zh-hant|zh|en|mul|es|ru|fr|de&ids=" + "|".join(qids[i:i + 50]))
        time.sleep(0.5)
        for qid, e in json.loads(get(url))["entities"].items():
            def pick(field, langs):
                for lg in langs:
                    v = e.get(field, {}).get(lg)
                    if v:
                        return v["value"], lg
                return None, None
            zl, zlg = pick("labels", ["zh-tw", "zh-hant", "zh"])
            zd, zdg = pick("descriptions", ["zh-tw", "zh-hant", "zh"])
            if s2t:
                zl = s2t(zl) if zl and zlg == "zh" else zl
                zd = s2t(zd) if zd and zdg == "zh" else zd
            out[qid] = {"label_zh": zl, "label_en": pick("labels", ["en", "mul", "es", "ru", "fr", "de"])[0],
                        "desc_zh": zd, "desc_en": pick("descriptions", ["en", "es", "ru", "fr", "de"])[0]}
    return out


def strip_html(s):
    s = re.sub(r"<[^>]+>", "", s or "")
    return re.sub(r"\s+", " ", s).strip()


def file_info(files):
    out = {}
    files = sorted(set(files))
    for i in range(0, len(files), 40):
        titles = "|".join("File:" + f for f in files[i:i + 40])
        url = ("https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo"
               f"&iiprop=url|extmetadata&iiurlwidth={WIDTH}&titles=" + urllib.parse.quote(titles))
        time.sleep(0.5)
        d = json.loads(get(url))
        norm = {n["to"]: n["from"] for n in d["query"].get("normalized", [])}
        for p in d["query"]["pages"].values():
            if "imageinfo" not in p:
                continue
            ii = p["imageinfo"][0]
            md = ii.get("extmetadata", {})
            name = norm.get(p["title"], p["title"])[5:]
            out[name] = {"thumb": ii.get("thumburl"), "page": ii.get("descriptionurl"),
                         "artist": strip_html(md.get("Artist", {}).get("value"))[:120],
                         "license": strip_html(md.get("LicenseShortName", {}).get("value"))}
    return out


def main():
    route = json.loads((ROOT / "data" / "route.json").read_text(encoding="utf-8"))
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    cache.setdefault("near2", {})
    cache.pop("country", None)
    cache.pop("near", None)

    for n, w in enumerate(route["waypoints"]):
        if w.get("lat") is None or w["id"] in cache["near2"]:
            continue
        for r in RADII:
            res = nearby(w["lat"], w["lon"], r)
            if res:
                break
        cache["near2"][w["id"]] = res
        print(n, w["id"], len(res), flush=True)
        if n % 10 == 0:
            CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")

    if (set(REGION_ITEM.values()) | set(CITY_ITEM.values())) - set(cache.get("region", {})):
        cache["region"] = items(list(REGION_ITEM.values()) + list(CITY_ITEM.values()))
        CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    picks, prev = {}, None
    for w in route["waypoints"]:
        near = [c for c in cache["near2"].get(w["id"]) or [] if c["qid"] not in EXCLUDE_QIDS]
        if w["id"] in CITY_ITEM and cache["region"].get(CITY_ITEM[w["id"]]):
            picks[w["id"]] = {**cache["region"][CITY_ITEM[w["id"]]], "kind": "city"}
            prev = w["id"]
        elif near:
            best = max(near, key=lambda c: c["sitelinks"] / (1 + c["dist_km"] / 10))
            picks[w["id"]] = {**best, "kind": "near"}
            prev = w["id"]
        elif w["id"] in REGION_ITEM and cache["region"].get(REGION_ITEM[w["id"]]):
            picks[w["id"]] = {**cache["region"][REGION_ITEM[w["id"]]], "kind": "region"}
        elif prev:
            picks[w["id"]] = {**picks[prev], "kind": "prev", "ref_wp": prev}
    lab = labels([p["qid"] for p in picks.values()])
    info = file_info([p["file"] for p in picks.values()])

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    out = {}
    for wid, p in picks.items():
        fi = info.get(p["file"])
        if not fi or not fi["thumb"]:
            print("no file info", wid, p["file"])
            continue
        # 已下載過的用本機檔；其餘直接連結 Commons 縮圖（大量下載會被 upload.wikimedia.org 限流）
        local = next(IMG_DIR.glob(f"{p['qid']}.*"), None)
        img = f"img/places/{local.name}" if local else fi["thumb"].split("?")[0]
        out[wid] = {"qid": p["qid"], "kind": p["kind"], "dist_km": p.get("dist_km"), "ref_wp": p.get("ref_wp"),
                    "img": img, **lab.get(p["qid"], {}),
                    "file_page": fi["page"], "artist": fi["artist"], "license": fi["license"]}
    (ROOT / "data" / "wp_places.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    missing = [w["id"] for w in route["waypoints"] if w["id"] not in out]
    print(f"{len(out)} waypoints with place photos; missing: {missing}")


if __name__ == "__main__":
    main()
