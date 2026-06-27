"""
데이터 갱신 엔트리포인트.

사용:
  python run_update.py --type close      # 종가 확정(정규장 마감 후)
  python run_update.py --type intraday   # 장중 속보(정규장 중)
  python run_update.py --type close --force   # 비거래일에도 강제 실행

동작:
  1) 과거 일봉 수집(Yahoo Finance) → 50일 이격도 계산
  2) docs/data/history.json (일봉 히스토리) 갱신
  3) docs/data/latest.json  (최신 스냅샷) 갱신
  4) 텔레그램 채널로 broadcast
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

import disparity as D
import telegram_notify

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
HISTORY_PATH = DATA_DIR / "history.json"
LATEST_PATH = DATA_DIR / "latest.json"

WEB_URL = os.environ.get("WEB_URL", "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", choices=["intraday", "close"], required=True)
    ap.add_argument("--force", action="store_true", help="비거래일에도 실행")
    ap.add_argument("--no-telegram", action="store_true", help="텔레그램 전송 생략")
    args = ap.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[update] 과거 일봉 수집 중...")
    raw = D.fetch_history(days=900)
    history = D.compute_history(raw)
    print(f"[update] 일봉 {len(history)}개, 이격도 산출 {sum(1 for p in history if p.ma50)}개")

    latest_date = history[-1].date if history else None
    prev_committed = None
    if HISTORY_PATH.exists():
        try:
            prev = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
            prev_committed = prev[-1]["date"] if prev else None
        except Exception:  # noqa: BLE001
            prev_committed = None
    today = dt.datetime.now(D.ET).strftime("%Y-%m-%d")
    has_new_close = latest_date is not None and (
        prev_committed is None or latest_date > prev_committed
    )
    is_today = latest_date == today
    should_update = has_new_close or is_today

    if not should_update and not args.force:
        print(f"[update] 새 데이터 없음(최신 데이터일: {latest_date}, 직전 커밋: "
              f"{prev_committed}). 갱신/알림 생략. (--force로 강제)")
        return 0

    records = D.history_to_records(history)
    HISTORY_PATH.write_text(
        json.dumps(records, ensure_ascii=False, indent=0, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"[update] history.json 저장: {len(records)} rows")

    snap = D.build_snapshot(history, run_type=args.type)

    prev_latest = None
    if LATEST_PATH.exists():
        try:
            prev_latest = json.loads(LATEST_PATH.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            prev_latest = None

    if snap.type == "intraday" and prev_latest and not args.force:
        pd_, pt_ = prev_latest.get("date"), prev_latest.get("type")
        if pd_ and (snap.date < pd_ or (snap.date == pd_ and pt_ == "close")):
            print(f"[update] 장중 스냅샷({snap.date})이 기존 확정 스냅샷"
                  f"({pt_} {pd_})을 덮어쓰지 않음 — latest.json 갱신/알림 생략.")
            return 0

    LATEST_PATH.write_text(
        json.dumps(asdict(snap), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[update] latest.json 저장: {snap.type_label} "
          f"이격도 {snap.disparity:.2f}% ({snap.zone_label})")

    if args.no_telegram:
        print("[update] --no-telegram: 전송 생략")
    else:
        try:
            telegram_notify.send(snap, web_url=WEB_URL or None)
        except Exception as e:  # noqa: BLE001
            print(f"[update] 텔레그램 전송 오류: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
