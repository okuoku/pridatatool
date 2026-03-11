# extract_exif_from_git_repository.mjs 実装計画

## 概要
Git-LFS管理された写真リポジトリ(`photos.git`)から、全refの履歴に含まれる写真ファイルのEXIFデータを抽出しJSONファイルとして保存する。

## 依存関係
- `extract_exif.mjs` の `extract_exif` 関数
- Node.js 標準ライブラリ (child_process, fs, path, crypto)
- Gitea HTTP API への直接アクセス (tokenは環境変数 `GITEA_TOKEN` または起動時引数)

## 主要関数・フロー

### 1. 初期化
- `git show-ref` でref一覧取得
- `save_status.txt` を読み込み、処理済みref一覧を取得 (差分実行対応)

### 2. 全refのイテレーション
- 全てのrefを処理対象とする
- 各refについてコミット履歴を取得

### 3. コミット履歴の取得
- `git rev-list --all --format=%H` で全コミットSHAを取得
- 各コミットについて:
  - `git ls-tree` でツリー内の全ファイルを取得
  - ファイルパスを元に画像判定 (拡張子: .jpg, .jpeg, .png, .heic, .raw, .cr2, .nef, .arw, .dng, .orf, .rw2)

### 4. Git-LFSファイルの取得
- Git-LFSポインタファイルからOIDを取得 (正規表現: `^oid sha256:([a-f0-9]{64})`)
- OIDを使ってGitea LFS APIから直接バイナリを取得
  - エンドポイント: `https://[gitea-host]/info/lfs/objects/[OID]`
- 認証: Bearer token (環境変数または引数)

### 5. 非LFSファイルの処理
- LFSポインタがない場合、直接 `git cat-file` でblobを取得
- SHA256ハッシュを計算してOIDとして使用

### 6. EXIF抽出
- `extract_exif(bytes)` にバイナリを渡す
- 失敗時はfalseが返る

### 7. JSON保存
- 保存先: `save/aa/bb/aabbccdd...json`
- oidの先頭2文字を2階層使用
- 保存形式: EXIFデータそのままのJSON

### 8. 並列処理
- CONCURRENCY = 8 で並列処理
- バッチ単位でPromise.allを使用

### 9. 完了処理
- 処理完了したrefを `save_status.txt` に1行1refで追加
- 形式: `<sha1> <ref名>`
- 差分実行: save_status.txtに記録されているsha1以降のコミットのみ処理
- **重要**: save_status.txtの更新は全処理完了後に行い、中断時の正確再開を確保

## ファイル構成
```
extract_exif_from_git_repository.mjs  - メインスクリプト (独立実装)
```

## 実装メモ
- Git-LFSポインタは `git cat-file -p` で展開できず、`.git/lfs/objects` にもバイナリがない場合がある
- Gitea LFS APIへHTTP GETで直接OID指定して取得する方式
- 画像ファイル判定は拡張子ベースで実装
- 大量ファイル対応のため、バッチ単位で並列処理し逐次保存
- 処理済みOIDはメモリ上で管理し、重複処理をスキップ
