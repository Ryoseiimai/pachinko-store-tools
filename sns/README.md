# パチつな（仮） MVP

パチンコ業界専用SNS。Cloudflare Workers + D1 の依存ゼロ実装。

## デプロイ手順（実行するのは親エージェント/本人。ここでは実行しない）

1. D1データベースを作成する
   ```
   wrp d1 create pachitsuna-db
   ```
2. 出力された `database_id` を `wrangler.toml` の `REPLACE_ME` に差し替える
3. スキーマを本番D1に反映する
   ```
   wrp d1 execute pachitsuna-db --remote --file schema.sql
   ```
4. デプロイする
   ```
   wrp deploy
   ```

## ローカル動作確認

```
npm install --ignore-scripts
wrangler dev --local --port 8787
```

または `./test.sh` でAPIの一連の動作を自動確認できる。

## 実装済みの割り切り（MVP）

- 禁止語フィルタは単純な部分一致（文脈判定なし）。「設定」等の語は文脈を問わず一律ブロックする。
- 認証はランダムトークンをSHA-256でハッシュ化してusersテーブルに保存する簡易方式。パスワードやメール認証はない。
- 画像投稿・通知・DM・検索機能は未実装。
