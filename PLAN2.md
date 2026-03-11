# save_to_sqlite.py 実装計画

## 概要
`save/` ディレクトリに保存されたEXIF JSONファイルから座標情報を抽出し、SQLiteデータベースに保存する。

## 依存関係
- Python 3
- sqlite3 (標準ライブラリ)
- json, os, glob, re (標準ライブラリ)

## 主要関数・フロー

### 1. 初期化
- `save/` ディレクトリ内の全JSONファイルを走査
- `db_status.txt` を読み込み、処理済みOID一覧を取得 (差分実行対応)
- SQLite DB初期化: `db.sqlite` テーブル作成

### 2. テーブル設計
```sql
CREATE TABLE IF NOT EXISTS photos (
    oid TEXT PRIMARY KEY,
    latitude REAL,
    longitude REAL,
    latitude_ref TEXT,
    longitude_ref TEXT,
    gps_timestamp TEXT,
    file_path TEXT,
    ref_t TEXT,
    dateaken TEXT,
    camera_make TEXT,
    camera_model TEXT,
    json_file TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_coords ON photos(latitude, longitude);
```

### 3. JSON処理
- `save/aa/bb/aabbccdd...json` を読み込み
- GPS座標抽出:
  - `GPSLatitude`, `GPSLongitude` (配列: [度, 分, 秒])
  - `GPSLatitudeRef`, `GPSLongitudeRef` ("N", "S", "E", "W")
  - 必要に応じて `GPSDateStamp`, `GPSTimeStamp`
- 変換: 度分秒を10進数に変換

### 4. 座標変換ロジック
```
decimal = degrees + (minutes / 60) + (seconds / 3600)
南緯・西経の場合は符号を反転
```

### 5. メタデータ保存
- OID (ファイル名から抽出)
- 座標 (latitude, longitude)
- ファイルパス (JSON内の `SourceFile` または推論)
- 参照ref情報 (必要に応じて)
- 撮影日時 (`DateTimeOriginal`)
- カメラ情報 (`Make`, `Model`)

### 6. 進捗管理
- 処理完了したOIDを `db_status.txt` に追加 (1行1OID)
- 差分実行: 未処理のOIDのみDBに追加

### 7. 実行エラー処理
- JSONパースエラー: スキップしてログ出力
- 座標なし: DBにoidのみ保存 (座標NULL)
- 重複OID: UPSERT (INSERT OR REPLACE)

## ファイル構成
```
save_to_sqlite.py  - メインスクリプト
db.sqlite         - 出力DB
db_status.txt     - 処理済みOIDリスト
```

## 実装メモ
- GPS座標がない写真也有很多、その場合は座標NULLで保存
- 低温房玉蟲寺対応のため、欠損値許容で設計
- 大量データ対応: トランザクション使用で高速化
