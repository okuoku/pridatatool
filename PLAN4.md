# `read_tracks.mjs` : GPS軌跡データのJSONファイル化

- Gitリポジトリに処理対象の軌跡データが格納されている。履歴全体を探索して消去されたファイルも処理すること。
- 同じbasenameで複数の拡張子のデータが入っていることがある。 txt / gpx / kml の順で優先して、どれか1つだけを選ぶ。
- データは track(軌跡データ) と segment(セグメント) に分割する。
- 軌跡データにはIDを振る。IDは sha256("pritrack" + "basename")。同一のIDのtrackが既に存在する場合は処理をスキップする。
- 軌跡データのIDは日付で整理する。 `track/tracks/YYYY/MM/DD/<sha256>.json` — 日付はGPSログに含まれる最古の日時を使う。
- セグメントはJSON形式で、1000点ごとにデータを分割する。
- セグメントのIDは sha256("segment" + インデックス + trackID) で整理する。 `track/segments/aa/bb/<sha256>.json` — OIDの先頭2文字を2階層使用する。

## txt / gpx / kml

txtはCSVファイルであり、先頭行はヘッダとなっている。

gpx / kml は標準XML。

## trackドキュメント形式

以下のフィールドを含むJSONとする:

- `filename` : 変換元のファイル名
- `ident` : ID
- `commit` : 元のGit commit SHA
- `date` : GPSログに含まれる最古の日時 (YYYY-MM-DD形式)
- `segments` : セグメントのIDのリストを含む配列(文字列の配列)。時系列順に並べること。(旧 → 新)

## segmentドキュメント形式

以下のフィールドを含むJSONとする:

- `track_ident` : trackのID
- `index` : セグメントのインデックス (0, 1, 2, ...)
- `seg` : セグメントデータの配列
- `keys` : セグメントを含む Plus Code矩形のリスト。文字列の配列。重複は排除すること。

セグメントデータは3要素から9要素の配列とする:

1. GPS時刻 : ISO8601文字列。元データを文字列で格納すること。
2. 経度 : 10進文字列。元データを文字列で格納すること。
3. 緯度 : 10進文字列。元データを文字列で格納すること。
4. (オプショナル) 速度(gpxの `speed` 要素、txtの `speed(m/s)`) : 10進文字列。元データを文字列で格納すること。
5. (オプショナル) 高度(gpxの `ele` 要素、txtの `altitude(m)`) :  10進文字列。元データを文字列で格納すること。
6. (オプショナル) GPS衛星カウント(gpxの `sat` 要素、txtの `sat_used`) : 数値。
7. (オプショナル) GPS衛星可視カウント(txtの `sat_inview`) : 数値。
8. (オプショナル) 精度(txtの `accuracy(m)`) : 10進文字列。元データを文字列で格納すること。
9. (オプショナル) 移動ベクトル(txt の `bearing(deg)`) : 10進文字列。元データを文字列で格納すること。

値が存在しない場合は `null` を格納し、さらに末尾の `null` の連続は省略する。

## Plus Code矩形

PlusCode矩形とは、経度、緯度を以下のようにしてエンコードした12文字の文字列とする:

https://raw.githubusercontent.com/google/open-location-code/refs/heads/main/js/src/openlocationcode.js:

```js
code = OpenLocationCode.encode(47.365590, 8.524997, 11);
```

## 実装メモ

- Git-LFS管理されたファイルはGitea LFS APIからダウンロードする
- 認証: 環境変数 `GITEA_TOKEN` または `--token` 引数
- refの差分処理は実装せず、常に全refの全コミットを読み取る
- 読み取り済みのtrack IDは `track/tracks/` ディレクトリから判定
