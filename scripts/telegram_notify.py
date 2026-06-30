"""텔레그램 채널 broadcast 모듈."""
from __future__ import annotations

import os
import requests

from disparity import Snapshot, zone_emoji, INDICES


def _fmt_signed(v, suffix=""):
    if v is None:
        return "-"
    sign = "+" if v > 0 else ("" if v == 0 else "")
    return f"{sign}{v:,.2f}{suffix}"


def build_message(index_key: str, snap: Snapshot) -> str:
    cfg = INDICES[index_key]
    name = cfg["name"]
    emoji = zone_emoji(snap.zone)
    arrow = "▲" if (snap.change or 0) > 0 else ("▼" if (snap.change or 0) < 0 else "—")

    change_line = "-"
    if snap.change is not None:
        change_line = f"{arrow} {abs(snap.change):,.2f}p ({_fmt_signed(snap.change_pct)}%)"

    disp_delta = ""
    if snap.prev_disparity is not None:
        d = round(snap.disparity - snap.prev_disparity, 2)
        disp_delta = f" ({_fmt_signed(d)}p)"

    lines = [
        f"📊 *{name} 50일 이격도* — {snap.type_label}",
        f"🗓 {snap.date} {snap.time}",
        "",
        f"{emoji} *{snap.disparity:.1f}%*  ·  {snap.zone_label}{disp_delta}",
        "",
        f"• {name}: *{snap.index:,.2f}*  {change_line}",
        f"• 50일 이평: {snap.ma50:,.2f}",
        f"• 이격도 = 현재가 ÷ 50일선 × 100",
    ]

    if snap.zone == "overheat":
        lines += ["", f"⚠️ {cfg['overheat']:.0f}% 이상 *과열권*. 추격매수(Panic Buying) 자제 구간."]
    elif snap.zone == "caution":
        lines += ["", f"🟠 과열 *경계* 구간. {cfg['overheat']:.0f}% 근접 — 분할·속도조절 관심."]
    elif snap.zone == "cooldown":
        lines += ["", f"🔵 {cfg['cooldown']:.0f}% 이하 *과열 해소*. 투매(Panic Selling) 자제, 이격조정 끝난 업종부터 관심."]
    else:
        lines += ["", f"🟢 정상 범위({cfg['cooldown']:.0f}~{cfg['overheat']:.0f}%). 추세 추종 유효."]

    lines += [
        "",
        f"기준: 이그전(이은택의 그림전략) 응용 · 과열 ≥{cfg['overheat']:.0f}% / 해소 ≤{cfg['cooldown']:.0f}%",
        f"{snap.note}",
    ]
    return "\n".join(lines)


def send(index_key: str, snap: Snapshot, web_url: str | None = None) -> bool:
    """텔레그램 채널로 broadcast. 토큰/챗ID 없으면 출력만 하고 False 반환."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    text = build_message(index_key, snap)
    if web_url:
        text += f"\n\n🔗 {web_url}"

    if not token or not chat_id:
        print("[telegram] TELEGRAM_BOT_TOKEN/CHAT_ID 미설정 — 전송 생략. 미리보기:\n")
        print(text)
        return False

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown",
        "disable_web_page_preview": True,
    }
    r = requests.post(url, json=payload, timeout=20)
    if r.status_code != 200:
        print(f"[telegram] 전송 실패 {r.status_code}: {r.text}")
        r.raise_for_status()
    print("[telegram] 전송 완료")
    return True
