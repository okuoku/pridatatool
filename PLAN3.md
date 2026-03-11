# convert_to_geojson.py 実装計画

## 概要
SQLiteデータベースに保存された座標情報をGeoJSON形式に変換する。

## 依存関係
- Python 3
- sqlite3 (標準ライブラリ)
- json, datetime (標準ライブラリ)

## 主要関数・フロー

### 1. 初期化
- `db.sqlite` への接続
- 座標を持つレコードを取得 (latitude IS NOT NULL AND longitude IS NOT NULL)

### 2. GeoJSON生成
- FeatureCollection形式 出
```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [longitude, latitude]
      },
      "properties": {
        "oid": "aabbccdd...",
        "datetime": "2024:01:15 10:30:00",
        "camera_make": "Canon",
        "camera_model": "EOS R5",
        "file_path": "path/to/photo.jpg"
      }
    }
  ]
}
```

### 3. プロパティマッピング
| DBフィールド | GeoJSONプロパティ |
|-------------|-------------------|
| oid | oid |
| latitude | (geometry内) |
| longitude | (geometry内) |
| datetaken | datetime |
| camera_make | camera_make |
| camera_model | camera_model |
| file_path | file_path |
| ref_t | ref |

### 4. 出力
- 標準出力へのJSON出力
- オプション: ファイル出力 (引数 `--output=file.geojson`)

### 5. フィルタリング (オプション)
- 日付範囲指定: `--start=DATE`, `--end=DATE`
- カメラ指定: `--camera=MODEL`

## ファイル構成
```
convert_to_geojson.py  - メインスクリプト
output.geojson        - 出力ファイル (任意)
```

## 実装メモ
- 座標なしのレードは無視
- 無効な座標値もチェックしてスキップ (latitude: -90〜90, longitude: -180〜180)
- 大量データ対応: ストリーミング出力考慮
