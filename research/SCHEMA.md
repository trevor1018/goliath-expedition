# Goliath Expedition 考證資料格式

每個路段研究輸出兩個檔案：`legNN.json`（結構化資料）與 `legNN.md`（考證筆記、矛盾、未解問題）。

## legNN.json

```json
{
  "leg": "01",
  "title": "Punta Arenas → Panama",
  "waypoints": [
    {
      "id": "w01-001",
      "name": "Punta Arenas, Chile",
      "lat": -53.1638, "lon": -70.9171,
      "coord_basis": "town_centroid | exact_reported | approximate_region",
      "date": "1998-11-01",
      "date_earliest": "1998-11-01", "date_latest": "1998-11-01",
      "date_precision": "day | month | season | year | unknown",
      "event": "Expedition start",
      "sources": ["S1"]
    }
  ],
  "segments": [
    {
      "id": "s01-001",
      "from": "w01-001", "to": "w01-002",
      "mode": "walk | swim | ice | offroute | other",
      "route_basis": "gps_track | named_road | waypoints_only | unknown",
      "route_detail": "e.g. Ruta 9 / Carretera Austral / Pan-American Hwy; null if unknown",
      "companions": [],
      "counts_as_progress": true,
      "notes": "",
      "sources": ["S1", "S2"]
    }
  ],
  "pauses": [
    {
      "id": "p01-001",
      "at": "w01-00X",
      "start": "YYYY-MM or range", "end": "YYYY-MM or range",
      "reason": "visa / funding / injury / covid / ...",
      "left_how": "flight to UK etc, or unknown",
      "sources": []
    }
  ],
  "conflicts": [
    { "topic": "", "claims": [{"value": "", "source": "S1"}], "assessment": "" }
  ],
  "unknowns": ["..."],
  "sources": {
    "S1": { "title": "", "url": "", "type": "primary | secondary", "publisher": "", "date": "", "quote": "verbatim supporting quote" }
  }
}
```

## 規則
- mode：walk=步行；swim=游泳；ice=冰上移動（白令海峽）；offroute=離開路線、不算進度的移動（飛機、遣返、辦簽證、2015 年請願步行等）；other=其他。
- 不可捏造。沒有來源的日期或路徑一律標 unknown。城鎮座標可用一般地理知識的城鎮中心座標，但 coord_basis 要標 town_centroid。
- primary 來源＝Karl 本人（書《Giant Steps》、官方網站/部落格/社群貼文、本人受訪直接引述）；其餘為 secondary。
- 每個非顯而易見的事實都要有 sources，並附逐字引文（quote）。
- 來源互相矛盾時，全部列入 conflicts，不要自行挑一個靜默採用。
