# Goliath Expedition 互動地圖

Karl Bushby 1998–2026 從智利蓬塔阿雷納斯徒步回英國赫爾的路線考證與互動地圖。

**網站：https://trevor1018.github.io/goliath-expedition/**

發現錯誤請用網站上的「⚑ 問題回報」（會自動帶入經過點或章節），或直接[開 Issue](https://github.com/trevor1018/goliath-expedition/issues/new/choose)。

## 執行

```
cd web
python -m http.server 8000
```
開啟 http://localhost:8000 。純靜態網站；推送到 `main` 後，`.github/workflows/pages.yml` 會自動把 `web/` 發布到 GitHub Pages。
修改 `web/` 的 JS／CSS 後，請把 `index.html` 裡的 `?v=` 版本號加一，避免瀏覽器使用舊快取。

## 資料流程

```
research/legNN.json   各段考證（格式見 research/SCHEMA.md，筆記在 legNN.md）
        │  tools/merge.py      合併、處理段落銜接、驗證參照
        ▼
data/route.json
        │  tools/build_web.py  合併無座標路段、計算時間軸與動畫路徑
        ▼
web/data/expedition.json
```
修改任何 `research/legNN.json` 後依序執行：
```
python tools/merge.py
python tools/build_web.py      # 同時輸出 data/raw_features.json
python tools/route_roads.py    # 沿道路推算線形，只查快取裡沒有的路段（約 1 次/秒）
python tools/build_web.py      # 套用 data/road_cache.json
```
道路線形來自 FOSSGIS 公開 OSRM 汽車路網的最短路徑，只是示意；
找不到路、偏離太遠、繞路過頭或需要渡輪的小段會退回直線，原因記錄在快取中並顯示於網站。

檢查非游泳路段是否畫到海上（需要 Natural Earth `ne_10m_land.geojson`）：
```
python tools/check_sea.py path/to/ne_10m_land.geojson
```
人工判斷的覆寫（不合理的日誌座標、海冰段、冬季無路段）分別寫在
`tools/merge.py` 的 `COORD_REJECT` 與 `tools/build_web.py` 的 `ICE_OVERRIDE`、`WATER_STRAIGHT`。

## 圖片

經過點面板與導覽卡片會顯示三種圖片，`tools/build_web.py` 會把它們合併進 `expedition.json`：

| 圖片 | 來源 | 產生方式 |
|---|---|---|
| 國旗 | `web/img/flags/*.png`（flagcdn.com） | `python tools/countries.py path/to/ne_10m_admin_0_countries.geojson` → `data/wp_country.json` |
| 附近知名地點 | Wikidata + Wikimedia Commons，直接連結 Commons 500 px 縮圖（少數已下載的在 `web/img/places/`） | `python tools/fetch_places.py` → `data/wp_places.json`（快取 `data/places_cache.json`） |
| Karl 本人照片 | 他的網站存檔等，原圖不下載、直接連結 | 人工考證，存放於 `research/photos/karl_*.json`，每張附原文說明、出處、對應經過點 |

國家判定：有座標的點用國界多邊形；沒有座標的點依地名，或前後已知點同屬一國才採用，否則顯示「未知」。
地點照片挑選規則：在 20／60／150 km 內，排除國家與行政區，以「維基語言版本數 ÷ (1 + 距離/10 km)」排序取最高者；
挑錯的項目（事件、機場、國會等）列在 `EXCLUDE_QIDS`，本身是一級行政區的城市（烏蘭巴托、維也納等）列在 `CITY_ITEM`。
沒有座標的點不推測位置：名稱提到地區的用該地區照片（`REGION_ITEM`），其餘用前一個已知經過點的照片，網站上都會註明。
這些照片都不是 Karl 拍的，網站上會標示出來。

考證總結見 `research/REPORT.md`。

## 授權

- 程式碼（`tools/`、`web/*.js`、`web/*.css`、`web/index.html`）：[MIT](LICENSE)
- 考證資料（`research/`、`data/`、`web/data/`）：[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hant)，請註明出處並連回本儲存庫
- 不在上述授權內：
  - Karl Bushby 的照片：版權屬原作者，本站只連結、不轉存；權利人要求時會立即移除
  - Wikimedia Commons 照片（`web/img/places/` 與直接連結的縮圖）：依各照片標示的授權與作者
  - 國旗圖檔（`web/img/flags/`）：取自 flagcdn.com
  - 底圖：© OpenStreetMap contributors、OpenFreeMap／OpenMapTiles
