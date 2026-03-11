# extract_exif_from_git_repository.mjs 実装計画

## 概要
Git-LFS管理された写真リポジトリ(`photos.git`)から、全refの履歴に含まれる写真ファイルのEXIFデータを抽出しJSONファイルとして保存する。

## 依存関係
- `extract_exif.mjs` の `extract_exif` 関数
- 既存の `gitutil.mjs` (`make_reader`, `make_enumerator`)
- Gitea HTTP API への直接アクセス (tokenは環境変数 `GITEA_TOKEN` または起動時引数)

## 主要関数・フロー

### 1. 初期化
- `gitutil.make_enumerator(gitdir)` でref一覧取得
- `save_status.txt` を読み込み、処理済みref一覧を取得 (差分実行対応)

### 2. 全refのイテレーション
- 全てのrefを処理対象とする
- 各refについて:
  - ref名とコミットSHAを取得

### 3. コミット履歴の辿り方
- `gitutil.make_enumerator().history_linear()` または `git diff` を使用
- 対象refのツリーに含まれる全ファイルを走査
- ファイルパスを元に画像判定 (拡張子: .jpg, .jpeg, .png, .heic, .raw 等)

### 4. Git-LFSファイルの取得
- Git-LFSポインタファイルからOIDを取得
- OIDを使ってGitea HTTP APIから直接バイナリを取得
  - エンドポイント: `https://[gitea-host]/raw/photos.git/oid/[OID]`
  - または Gitea LFS API: `https://[gitea-host]/git-lfs/objects/[OID]`
- 認証: Bearer token (環境変数または引数)
- 一時ファイルは処理後削除

### 5. EXIF抽出
- `extract_exif(bytes)` にバイナリを渡す
- 失敗時はfalseが返る

### 6. JSON保存
- 保存先: `save/aa/bb/aabbccdd...json`
- oidの先頭2文字を2階層 used
- 保存形式: EXIFデータそのままのJSON

### 7. 完了処理
- 処理完了したrefを `save_status.txt` に1行1refで追加
- 差分実行: 未処理のrefのみ処理

## ファイル構成
```
extract_exif_from_git_repository.mjs  - メインスクリプト
```

## 実装メモ
- Git-LFSポインタは `git cat-file -p` で展開できず、`.git/lfs/objects` にもバイナリがない場合がある
- GiteaエンドポイントへHTTP GETで直接OID指定して取得する方式
- 画像ファイル判定は拡張子ベースで実装
- 大量ファイル対応のため、1ファイルずつ処理し逐次保存
