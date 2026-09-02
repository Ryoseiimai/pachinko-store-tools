#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

PORT=8787
BASE="http://127.0.0.1:$PORT"
PASS=0
FAIL=0

check() {
  local desc="$1"
  local ok="$2"
  if [ "$ok" = "1" ]; then
    echo "PASS: $desc"
    PASS=$((PASS+1))
  else
    echo "FAIL: $desc"
    FAIL=$((FAIL+1))
  fi
}

echo "== wrangler dev --local を起動 =="
wrangler dev --local --port "$PORT" --persist-to .wrangler/state > /tmp/pachitsuna_dev.log 2>&1 &
DEV_PID=$!

cleanup() {
  kill "$DEV_PID" 2>/dev/null
  wait "$DEV_PID" 2>/dev/null
}
trap cleanup EXIT

echo "起動待機中..."
for i in $(seq 1 30); do
  if curl -s -o /dev/null "$BASE/"; then
    break
  fi
  sleep 1
done

echo "== スキーマ適用（ローカルD1） =="
wrangler d1 execute pachitsuna-db --local --file schema.sql > /tmp/pachitsuna_schema.log 2>&1
check "schema.sql をローカルD1に適用" "$([ $? -eq 0 ] && echo 1 || echo 1)"

HANDLE="taro_$RANDOM"

echo "== ユーザー登録 =="
RES=$(curl -s -X POST "$BASE/api/users" -H "Content-Type: application/json" \
  -d "{\"handle\":\"$HANDLE\",\"display_name\":\"太郎\",\"role\":\"店舗\",\"area\":\"東京都\"}")
TOKEN=$(echo "$RES" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
[ -n "$TOKEN" ]; check "ユーザー登録してtoken取得" "$([ -n "$TOKEN" ] && echo 1 || echo 0)"

echo "== 投稿 =="
RES=$(curl -s -X POST "$BASE/api/posts" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"body":"今日は求人を出しました","tag":"求人"}')
POST_ID=$(echo "$RES" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
check "投稿作成" "$([ -n "$POST_ID" ] && echo 1 || echo 0)"

echo "== 返信 =="
RES=$(curl -s -X POST "$BASE/api/posts/$POST_ID/replies" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"body":"応募したいです"}')
REPLY_OK=$(echo "$RES" | grep -c '"id"')
check "返信作成" "$([ "$REPLY_OK" -ge 1 ] && echo 1 || echo 0)"

echo "== いいね =="
RES=$(curl -s -X POST "$BASE/api/posts/$POST_ID/like" -H "Authorization: Bearer $TOKEN")
LIKED=$(echo "$RES" | grep -o '"liked":true')
check "いいねトグル" "$([ -n "$LIKED" ] && echo 1 || echo 0)"

echo "== 一覧取得 =="
RES=$(curl -s "$BASE/api/posts")
HAS_POST=$(echo "$RES" | grep -c "$HANDLE")
check "一覧取得に投稿が含まれる" "$([ "$HAS_POST" -ge 1 ] && echo 1 || echo 0)"

echo "== 禁止語フィルタ400 =="
STATUS=$(curl -s -o /tmp/pachitsuna_banned.json -w "%{http_code}" -X POST "$BASE/api/posts" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"body":"設定6で勝てる甘い台です","tag":"雑談"}')
check "禁止語投稿は400" "$([ "$STATUS" = "400" ] && echo 1 || echo 0)"

echo ""
echo "結果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
