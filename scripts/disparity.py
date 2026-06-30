"""
주요 지수 50일 이동평균선 이격도 계산 핵심 라이브러리 (이그전 - 이은택의 그림전략 이론 응용)

이격도 = 현재가 / 50일 이동평균 × 100

응용법:
  - 130% 이상 : 과열권 진입 (Panic Buying 자제)
  - 105% 이하 : 과열 해소 진행 (Panic Selling 자제)
  - 그 사이   : 정상 범위 (130 근접 시 경계)

데이터 소스(무료 공개): Yahoo Finance 차트 API 단일 소스.
지원 지수 및 임계값:
  - kospi  : 코스피종합지수(현물, ^KS11)         과열≥130 / 경계≥120 / 해소≤105 (이그전 원안 그대로)
  - sp500  : S&P500 선물(E-mini, ES=F)           과열≥106 / 경계≥103 / 해소≤97  (최근 10년 분포 기준 재산정)
  - nasdaq : 나스닥 선물(E-mini Nasdaq-100, NQ=F) 과열≥108 / 경계≥104 / 해소≤96  (최근 10년 분포 기준 재산정)

코스피는 변동성이 커서(과거 10년 일평균 표준편차 약 5.9%p) 130%/105%처럼 넓은 임계값이 유효하지만,
S&P500·나스닥 선물은 변동성이 작아(표준편차 각각 약 3.8%p / 4.8%p) 같은 임계값을 적용하면
과열권에 거의 도달하지 않아 신호로서 무의미해진다. 그래서 두 지수는 각자의 50일 이격도
실측 분포(상위/하위 백분위수)를 바탕으로 임계값을 좁혀서 재산정했다.
"""
from __future__ import annotations

import datetime as dt
import urllib.parse
from dataclasses import dataclass, asdict
from typing import Optional
from zoneinfo import ZoneInfo

import requests

ET = ZoneInfo("America/New_York")
KST = ZoneInfo("Asia/Seoul")

MA_WINDOW = 50      # 50일 이동평균

# 지수 레지스트리: key -> 설정. overheat/caution/cooldown은 지수별로 다르게 산정된 임계값(%).
INDICES = {
    "sp500": {
        "symbol": "ES=F",
        "name": "S&P500 선물",
        "short": "S&P500",
        "tz": ET,
        "close_time": "16:00",
        "intraday_time": "12:00",
        "utc_offset": "-04:00",
        "overheat": 106.0,
        "caution": 103.0,
        "cooldown": 97.0,
        "gauge_min": 90.0,
        "gauge_max": 112.0,
    },
    "nasdaq": {
        "symbol": "NQ=F",
        "name": "나스닥 선물",
        "short": "나스닥",
        "tz": ET,
        "close_time": "16:00",
        "intraday_time": "12:00",
        "utc_offset": "-04:00",
        "overheat": 108.0,
        "caution": 104.0,
        "cooldown": 96.0,
        "gauge_min": 88.0,
        "gauge_max": 114.0,
    },
    "kospi": {
        "symbol": "^KS11",
        "name": "코스피종합지수",
        "short": "코스피",
        "tz": KST,
        "close_time": "15:40",
        "intraday_time": "12:00",
        "utc_offset": "+09:00",
        "overheat": 130.0,
        "caution": 120.0,
        "cooldown": 105.0,
        "gauge_min": 95.0,
        "gauge_max": 140.0,
    },
}


@dataclass
class DailyPoint:
    date: str       # YYYY-MM-DD
    close: float    # 종가
    ma50: Optional[float] = None
    ma100: Optional[float] = None
    ma200: Optional[float] = None
    disparity: Optional[float] = None  # % (50일선 기준)
    zone: Optional[str] = None
    zone_label: Optional[str] = None


@dataclass
class Snapshot:
    """최신 상태(장중 속보 또는 종가 확정)."""
    date: str            # YYYY-MM-DD (지수별 거래소 시간대)
    time: str            # HH:MM
    type: str            # "intraday" | "close"
    type_label: str      # "장중 속보" | "종가 확정"
    index: float
    ma50: float
    disparity: float
    change: Optional[float]        # 전 거래일 종가 대비 포인트
    change_pct: Optional[float]    # 전 거래일 종가 대비 %
    prev_disparity: Optional[float]
    zone: str
    zone_label: str
    note: str
    updated_at: str      # ISO8601


# --------------------------------------------------------------------------
# 구간 판정
# --------------------------------------------------------------------------
def classify(index_key: str, disparity: float) -> tuple[str, str]:
    """이격도 → (zone key, 한글 라벨). 지수별 임계값(INDICES[index_key]) 기준."""
    cfg = INDICES[index_key]
    if disparity >= cfg["overheat"]:
        return "overheat", "과열권 (Panic Buying 자제)"
    if disparity >= cfg["caution"]:
        return "caution", "과열 경계 (관심)"
    if disparity <= cfg["cooldown"]:
        return "cooldown", "과열 해소 (Panic Selling 자제)"
    return "normal", "정상 범위"


def zone_emoji(zone: str) -> str:
    return {
        "overheat": "🔴",
        "caution": "🟠",
        "normal": "🟢",
        "cooldown": "🔵",
    }.get(zone, "⚪")


# --------------------------------------------------------------------------
# 데이터 수집 - 과거 일봉 (Yahoo Finance)
# --------------------------------------------------------------------------
def fetch_history_yahoo(symbol: str, tz: ZoneInfo, rng: str = "2y") -> list[DailyPoint]:
    """Yahoo Finance 차트 API로 일봉 종가 수집."""
    enc = urllib.parse.quote(symbol, safe="")
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{enc}"
        f"?range={rng}&interval=1d"
    )
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=20)
    r.raise_for_status()
    res = r.json()["chart"]["result"][0]
    ts = res["timestamp"]
    closes = res["indicators"]["quote"][0]["close"]
    points: list[DailyPoint] = []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        d = dt.datetime.fromtimestamp(t, tz).date()
        points.append(DailyPoint(date=d.strftime("%Y-%m-%d"), close=float(c)))
    return points


def fetch_history(symbol: str, tz: ZoneInfo, days: int = 900) -> list[DailyPoint]:
    """과거 일봉 수집(Yahoo Finance).

    range=max 는 오래된 구간을 일봉이 아닌 주/월봉으로 내려보내는 경우가 있어
    50/100/200일 이동평균이 깨질 수 있다. interval=1d 가 안정적으로 보장되는
    10y 범위를 사용한다(선물은 보통 10y 미만의 연속 데이터만 존재해 사실상 전체 기간).
    """
    pts = fetch_history_yahoo(symbol, tz, rng="10y")
    if len(pts) < MA_WINDOW:
        raise RuntimeError(f"yahoo 데이터 부족({len(pts)}개)")
    return pts


# --------------------------------------------------------------------------
# 데이터 수집 - 실시간(장중) 현재가
# --------------------------------------------------------------------------
def fetch_live_yahoo(symbol: str) -> float:
    """Yahoo Finance 실시간(지연) 현재가."""
    enc = urllib.parse.quote(symbol, safe="")
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{enc}"
        f"?range=1d&interval=1m"
    )
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
    r.raise_for_status()
    meta = r.json()["chart"]["result"][0]["meta"]
    return float(meta["regularMarketPrice"])


def fetch_live(symbol: str, reference_close: Optional[float] = None) -> float:
    """실시간 현재가(Yahoo). 참조 종가 대비 ±30% 넘는 이상치는 거부."""
    v = fetch_live_yahoo(symbol)
    if v <= 0:
        raise RuntimeError("실시간 현재가 수집 실패")
    if reference_close and abs(v - reference_close) / reference_close > 0.3:
        raise RuntimeError("실시간 현재가 이상치 감지")
    return v


# --------------------------------------------------------------------------
# 이격도 계산
# --------------------------------------------------------------------------
def _sma(closes: list[float], i: int, window: int) -> Optional[float]:
    if i + 1 < window:
        return None
    return sum(closes[i + 1 - window: i + 1]) / window


def compute_history(index_key: str, points: list[DailyPoint]) -> list[DailyPoint]:
    """일봉 리스트에 50/100/200일 이동평균·50일 이격도·구간 채우기 (날짜 오름차순 입력 가정)."""
    pts = sorted(points, key=lambda p: p.date)
    closes = [p.close for p in pts]
    for i, p in enumerate(pts):
        ma50 = _sma(closes, i, MA_WINDOW)
        ma100 = _sma(closes, i, 100)
        ma200 = _sma(closes, i, 200)
        if ma100 is not None:
            p.ma100 = round(ma100, 2)
        if ma200 is not None:
            p.ma200 = round(ma200, 2)
        if ma50 is not None:
            disp = p.close / ma50 * 100.0
            zone, label = classify(index_key, disp)
            p.ma50 = round(ma50, 2)
            p.disparity = round(disp, 2)
            p.zone = zone
            p.zone_label = label
    return pts


def build_snapshot(index_key: str, history: list[DailyPoint], run_type: str) -> Snapshot:
    """
    history: 50일 이평/이격도까지 계산된 일봉(오름차순).
    run_type: "intraday"(정규장 중) | "close"(종가 확정)

    - intraday: 마지막 '확정 종가'들로 MA50 산출, 분자는 실시간 현재가.
    - close   : history 마지막 점(오늘 확정 종가)을 그대로 사용.
    """
    cfg = INDICES[index_key]
    tz = cfg["tz"]
    now = dt.datetime.now(tz)
    hist = [p for p in history if p.ma50 is not None]
    if len(hist) < 1:
        raise RuntimeError("이격도 계산에 충분한 데이터가 없습니다(50거래일 필요).")

    last = hist[-1]
    prev = hist[-2] if len(hist) >= 2 else None

    if run_type == "close":
        index_val = last.close
        ma50 = last.ma50
        disparity = last.disparity
        prev_close = prev.close if prev else None
        prev_disp = prev.disparity if prev else None
        type_label = "updated"
        date_str = last.date
        time_str = cfg["close_time"]
        note = "정규장 마감 종가 기준 확정값입니다."
    else:  # intraday
        closes = [p.close for p in sorted(history, key=lambda p: p.date)]
        ma50 = round(sum(closes[-MA_WINDOW:]) / MA_WINDOW, 2)
        live = fetch_live(cfg["symbol"], reference_close=last.close)
        index_val = round(live, 2)
        disparity = round(index_val / ma50 * 100.0, 2)
        prev_close = last.close
        prev_disp = last.disparity
        type_label = "updated"
        date_str = now.strftime("%Y-%m-%d")
        time_str = cfg["intraday_time"]
        note = "정규장 중 실시간(지연) 현재가 기준 추정치입니다(종가 확정 시 갱신)."

    zone, zone_label = classify(index_key, disparity)
    change = round(index_val - prev_close, 2) if prev_close else None
    change_pct = round((index_val - prev_close) / prev_close * 100.0, 2) if prev_close else None

    return Snapshot(
        date=date_str,
        time=time_str,
        type=run_type,
        type_label=type_label,
        index=round(index_val, 2),
        ma50=round(ma50, 2),
        disparity=round(disparity, 2),
        change=change,
        change_pct=change_pct,
        prev_disparity=prev_disp,
        zone=zone,
        zone_label=zone_label,
        note=note,
        updated_at=f"{date_str}T{time_str}:00{cfg['utc_offset']}",
    )


# --------------------------------------------------------------------------
# 직렬화 헬퍼
# --------------------------------------------------------------------------
def history_to_records(history: list[DailyPoint]) -> list[dict]:
    out = []
    for p in history:
        if p.ma50 is None:
            continue
        out.append({
            "date": p.date,
            "close": round(p.close, 2),
            "ma50": p.ma50,
            "ma100": p.ma100,
            "ma200": p.ma200,
            "disparity": p.disparity,
            "zone": p.zone,
        })
    return out
