"""
데이터 갱신 엔트리포인트. S&P500 선물/나스닥 선물/코스피 3개 지수를 모두 갱신한다.

사용:
  python run_update.py --type close      # 종가 확정(정규장 마감 후)
  python run_update.py --type intraday   # 장중 속보(정규장 중)
  python run_update.py --type close --force   # 비거래일에도 강제 실행
  python run_update.py --type close --only nasdaq   # 특정 지수만 갱신

동작(지수별로 반복):
  1) 과거 일봉 수집(Yahoo Finance) → 50일 이격도 계산
  2) docs/data/<지수>/history.json (일봉 히스토리) 갱신
  3) docs/data/<지수>/latest.json  (최신 스냅샷) 갱신
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

WEB_URL = os.environ.get("WEB_URL", "")


def update_one(index_key: str, run_type: str, force: bool, no_telegram: bool) -> None:
    cfg = D.INDICES[index_key]
    data_dir = DATA_DIR / index_key
    data_dir.mkdir(parents=True, exist_ok=True)
    history_path = data_dir / "history.json"
    latest_path = data_dir / "latest.json"

    print(f"[update:{index_key}] 과거 일봉 수집 중... ({cfg['symbol']})")
    raw = D.fetch_history(cfg["symbol"], cfg["tz"], days=900)
    history = D.compute_history(raw)
    print(f"[update:{index_key}] 일봉 {len(history)}개, 이격도 산출 {sum(1 for p in history if p.ma50)}개")

    latest_date = history[-1].date if history else None
    prev_committed = None
    if history_path.exists():
        try:
            prev = json.loads(history_path.read_text(encoding="utf-8"))
            prev_committed = prev[-1]["date"] if prev else None
        except Exception:  # noqa: BLE001
            prev_committed = None
    today = dt.datetime.now(cfg["tz"]).strftime("%Y-%m-%d")
    has_new_close = latest_date is not None and (
        prev_committed is None or latest_date > prev_committed
    )
    is_today = latest_date == today
    should_update = has_new_close or is_today

    if not should_update and not force:
        print(f"[update:{index_key}] 새 데이터 없음(최신 데이터일: {latest_date}, 직전 커밋: "
              f"{prev_committed}). 갱신/알림 생략. (--force로 강제)")
        return

    records = D.history_to_records(history)
    history_path.write_text(
        json.dumps(records, ensure_ascii=False, indent=0, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"[update:{index_key}] history.json 저장: {len(records)} rows")

    snap = D.build_snapshot(index_key, history, run_type=run_type)

    prev_latest = None
    if latest_path.exists():
        try:
            prev_latest = json.loads(latest_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            prev_latest = None

    if snap.type == "intraday" and prev_latest and not force:
        pd_, pt_ = prev_latest.get("date"), prev_latest.get("type")
        if pd_ and (snap.date < pd_ or (snap.date == pd_ and pt_ == "close")):
            print(f"[update:{index_key}] 장중 스냅샷({snap.date})이 기존 확정 스냅샷"
                  f"({pt_} {pd_})을 덮어쓰지 않음 — latest.json 갱신/알림 생략.")
            return

    latest_path.write_text(
        json.dumps(asdict(snap), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[update:{index_key}] latest.json 저장: {snap.type_label} "
          f"이격도 {snap.disparity:.2f}% ({snap.zone_label})")

    if no_telegram:
        print(f"[update:{index_key}] --no-telegram: 전송 생략")
    else:
        try:
            telegram_notify.send(index_key, snap, web_url=WEB_URL or None)
        except Exception as e:  # noqa: BLE001
            print(f"[update:{index_key}] 텔레그램 전송 오류: {e}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", choices=["intraday", "close"], required=True)
    ap.add_argument("--force", action="store_true", help="비거래일에도 실행")
    ap.add_argument("--no-telegram", action="store_true", help="텔레그램 전송 생략")
    ap.add_argument("--only", choices=list(D.INDICES.keys()), help="특정 지수만 갱신")
    args = ap.parse_args()

    keys = [args.only] if args.only else list(D.INDICES.keys())
    for key in keys:
        try:
            update_one(key, args.type, args.force, args.no_telegram)
        except Exception as e:  # noqa: BLE001
            print(f"[update:{key}] 갱신 실패: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
