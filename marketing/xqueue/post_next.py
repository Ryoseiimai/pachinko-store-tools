#!/usr/bin/env python3
"""post_next.py: X連投キュー(queue.json)から「今日の日付」に一致する pending を
1件だけ投稿する日次バッチ。

実行体は必ず ~/.x-bookmark-triage/venv/bin/python を使うこと
(taiken_post.py と同じ依存 requests / requests_oauthlib がこのvenvにのみ入っている)。

投稿処理は taiken_post.oauth_session() / taiken_post.upload_video() /
post_manual.post_tweet() をそのまま再利用する(OAuth1署名・chunked upload・
投稿APIコールを自前で書き直さない)。

使い方:
    ~/.x-bookmark-triage/venv/bin/python post_next.py [--dry-run]

--dry-run のときは実際には投稿せず、今日該当する(またはid順で最初の)pending項目の
本文文字数(weighted, 280以内)・禁止語チェック・動画の存在とffprobeでの尺確認だけを
全件について行い、結果を表示して終了する(本投稿は行わない)。

二重投稿防止: queue.json の該当項目の status が既に "posted" ならスキップする。
同日に2回起動しても、1回目の投稿で status が posted に書き換わっているため
2件目は投稿されない。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
QUEUE_FILE = HERE / "queue.json"
LOG_FILE = HERE / "log.txt"

# taiken_post.py / post_manual.py の認証・投稿処理を再利用するため sys.path に追加
TAIKEN_POST_DIR = Path("/Users/ryoseiworld/dev/2026-08-25-x-taiken-post")
sys.path.insert(0, str(TAIKEN_POST_DIR))
import taiken_post  # noqa: E402
import post_manual  # noqa: E402

JST = ZoneInfo("Asia/Tokyo")

# 禁止語(パチンコ業界の広告規制/景品表示法まわりで避ける語。親の依頼で明示された6語)
FORBIDDEN_WORDS = ["設定", "出玉", "還元", "勝てる", "甘い", "回収", "完全無料"]

MIN_VIDEO_DURATION_SEC = 5.0


def log(msg: str) -> None:
    ts = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")
    line = "[%s] %s" % (ts, msg)
    print(line)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_queue() -> dict:
    if not QUEUE_FILE.exists():
        raise SystemExit("queue.json が見つかりません: %s" % QUEUE_FILE)
    try:
        data = json.loads(QUEUE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit("queue.json が壊れています: %s" % e)
    if "items" not in data or not isinstance(data["items"], list):
        raise SystemExit("queue.json の形式が不正です(items配列が無い)")
    return data


def save_queue(data: dict) -> None:
    tmp = QUEUE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(QUEUE_FILE)


def check_forbidden_words(text: str) -> list:
    return [w for w in FORBIDDEN_WORDS if w in text]


def check_video(video_rel: str) -> tuple:
    """(ok, message, duration_sec) を返す。ffprobeで尺を測り5秒未満はNG。"""
    video_path = REPO_ROOT / video_rel
    if not video_path.exists():
        return False, "動画ファイルが見つかりません: %s" % video_path, None
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(video_path),
            ],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, "ffprobe実行に失敗: %s" % e, None
    if result.returncode != 0:
        return False, "ffprobeエラー: %s" % result.stderr.strip()[:300], None
    try:
        duration = float(result.stdout.strip())
    except ValueError:
        return False, "ffprobeの尺出力が読めません: %r" % result.stdout, None
    if duration < MIN_VIDEO_DURATION_SEC:
        return False, "動画が%.1f秒しかありません(%.1f秒未満はNG)" % (duration, MIN_VIDEO_DURATION_SEC), duration
    return True, "OK(%.1f秒)" % duration, duration


def validate_item(item: dict) -> tuple:
    """(ok, messages) を返す。dry-runと本番の投稿前チェックの両方で使う。"""
    messages = []
    ok = True

    weight = taiken_post.weighted_length(item["text"])
    if weight > 280:
        ok = False
        messages.append("本文NG: 重み付き文字数=%d (上限280超過)" % weight)
    else:
        messages.append("本文OK: 重み付き文字数=%d / 280" % weight)

    forbidden = check_forbidden_words(item["text"])
    forbidden += check_forbidden_words(item.get("reply", ""))
    if forbidden:
        ok = False
        messages.append("禁止語NG: %s" % forbidden)
    else:
        messages.append("禁止語OK: 該当なし")

    reply = item.get("reply", "")
    if reply:
        rweight = taiken_post.weighted_length(reply)
        if rweight > 280:
            ok = False
            messages.append("リプライ本文NG: 重み付き文字数=%d (上限280超過)" % rweight)
        else:
            messages.append("リプライ本文OK: 重み付き文字数=%d / 280" % rweight)

    video_ok, video_msg, _duration = check_video(item.get("video", ""))
    if not video_ok:
        ok = False
    messages.append("動画: %s" % video_msg)

    return ok, messages


def find_today_pending(items: list) -> "dict | None":
    today_str = datetime.now(JST).strftime("%Y-%m-%d")
    for item in items:
        if item.get("date") == today_str and item.get("status") == "pending":
            return item
    return None


def run_dry_run(data: dict) -> int:
    print("---- dry-run: xqueue post_next (実際には投稿しません) ----")
    overall_ok = True
    for item in data["items"]:
        print("\n[id=%s date=%s status=%s]" % (item["id"], item["date"], item["status"]))
        ok, messages = validate_item(item)
        for m in messages:
            print("  " + m)
        print("  総合判定: %s" % ("OK" if ok else "NG"))
        if not ok:
            overall_ok = False

    today = find_today_pending(data["items"])
    print("\n---- 今日(%s)の対象 ----" % datetime.now(JST).strftime("%Y-%m-%d"))
    if today:
        print("id=%s が投稿対象になります(pending)" % today["id"])
    else:
        print("今日の日付に一致するpending項目はありません(投稿はスキップされます)")

    print("\n---- 総合判定(全件): %s ----" % ("OK" if overall_ok else "NG"))
    return 0 if overall_ok else 1


def run_post(data: dict) -> int:
    item = find_today_pending(data["items"])
    if item is None:
        log("今日の日付に一致するpending項目がありません。投稿スキップ。")
        return 0

    ok, messages = validate_item(item)
    if not ok:
        for m in messages:
            log("検証NG: " + m)
        log("id=%s は検証NGのため投稿しません。" % item["id"])
        return 1

    session = taiken_post.oauth_session()

    video_path = REPO_ROOT / item["video"]
    log("id=%s の動画をアップロード中: %s" % (item["id"], video_path))
    try:
        media_id = taiken_post.upload_video(session, video_path)
    except taiken_post.UploadError as e:
        log("動画アップロード失敗: %s" % e)
        return 1

    log("id=%s を投稿します" % item["id"])
    resp = post_manual.post_tweet(session, item["text"], media_id=media_id)
    if resp.status_code not in (200, 201):
        log("投稿失敗 HTTP %s: %s" % (resp.status_code, resp.text[:500]))
        return 1
    tweet_id = resp.json().get("data", {}).get("id")
    if not tweet_id:
        log("投稿応答にidが無い: %s" % resp.text[:500])
        return 1
    log("投稿成功 tweet_id=%s" % tweet_id)

    reply_id = None
    reply_text = item.get("reply", "")
    if reply_text:
        log("id=%s のリプライを投稿します" % item["id"])
        reply_resp = post_manual.post_tweet(session, reply_text, reply_to_id=tweet_id)
        if reply_resp.status_code not in (200, 201):
            log("リプライ投稿失敗 HTTP %s: %s (本体は投稿済みのため処理継続)" % (
                reply_resp.status_code, reply_resp.text[:500]))
        else:
            reply_id = reply_resp.json().get("data", {}).get("id")
            log("リプライ投稿成功 reply_id=%s" % reply_id)

    item["status"] = "posted"
    item["tweet_id"] = tweet_id
    item["reply_id"] = reply_id
    item["posted_at"] = datetime.now(JST).isoformat()
    save_queue(data)
    log("queue.json を更新しました(id=%s -> posted)" % item["id"])
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="投稿せず検証のみ行う")
    args = parser.parse_args()

    data = load_queue()

    if args.dry_run:
        return run_dry_run(data)
    return run_post(data)


if __name__ == "__main__":
    raise SystemExit(main())
