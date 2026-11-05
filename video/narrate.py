"""Narration v0: one WAV per section with local Kokoro TTS (voice af_heart). Writes audio/durations.json.

Every number spoken here must come from a results file or a cited source; placeholders in {braces} are
filled from measured data before the final cut (see video/README.md).
"""
import json, sys
from pathlib import Path
import numpy as np, soundfile as sf

HERE = Path(__file__).parent
OUT = HERE / "audio"
SEGMENTS = {
    "a_open": "The final just ended. Prize Pool checked the match against public data, and every winning player "
              "has already been paid, with PayPal.",
    "b_problem": "Community tournaments run on trust. Someone collects the prize money into their own PayPal, and pays "
                 "the winners by hand, days later, if at all. At the top, FISSURE still owes teams from 2025. At the "
                 "grassroots, The National kept three thousand four hundred dollars, and nobody followed up.",
    "c_who": "Prize Pool is for the people who run these events, a Discord's Friday cup or a chess club's blitz night, "
             "and for the players who just want to be paid.",
    "d_create": "The organizer describes the event in plain English. Claude turns it into a rules card: eight teams, a "
                "sixty, thirty, ten split, the league, the stand-in rule. Fans chip in with PayPal. Each pledge is a "
                "hold, not a charge. If the final is never played, nobody pays a cent.",
    "e_verify": "Teams play as usual. For every match, Prize Pool reads the public match record and checks it in code: "
                "the right players, on the right sides, in the right league, inside the event window, and never "
                "reused. When a captain says they disconnected, Claude rules on it, quoting the organizer's own clause "
                "and the match facts. The organizer approves.",
    "f_pay": "When the final is verified, Prize Pool captures the holds, recomputes every cent, and sends one PayPal "
             "Payouts batch to every winning player. A policy gate stands in front of the money: no model can change "
             "a recipient or an amount. Every hold, capture and payout lands in the ledger, and you can ask it "
             "questions in plain English.",
    "g_try": "You can try it yourself. Start a one-minute chess game on Lichess from the demo, play it out, and watch "
             "the winner get paid.",
    "h_close": "Prize Pool. Prize money that only moves when the result is real. Built with PayPal Orders, Payouts and "
               "Invoicing, the PayPal Agent Toolkit, and Claude.",
}
# Pronunciation fixes for Kokoro (check the log for unknown-word warnings after every change).
FIX = {"Lichess": "Lee-chess", "OpenDota": "Open Dota", "FISSURE": "Fissure", "PayPal": "PayPal"}


def main(only=None):
    from kokoro import KPipeline
    OUT.mkdir(exist_ok=True)
    p = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
    path = OUT / "durations.json"
    dur = json.loads(path.read_text()) if path.exists() else {}
    for k, text in SEGMENTS.items():
        if only and k not in only:
            continue
        for a, b in FIX.items():
            text = text.replace(a, b)
        chunks = [np.asarray(a) for _, _, a in p(text, voice="af_heart", speed=1.06)]
        sr = 24000
        pad = np.zeros(int(sr * 0.25), dtype=np.float32)
        audio = np.concatenate([pad, *chunks, pad]).astype(np.float32)
        sf.write(OUT / f"{k}.wav", audio, sr)
        dur[k] = round(len(audio) / sr, 2)
        print(f"{k:10s} {dur[k]:6.2f}s  {len(SEGMENTS[k].split())} words")
    path.write_text(json.dumps(dur, indent=1))
    total = sum(dur[k] for k in SEGMENTS if k in dur)
    print(f"narration total {total:.1f}s (budget: < 170s narration so the cut stays under 2:50)")


if __name__ == "__main__":
    main(sys.argv[1:] or None)
