# Demo video pipeline

Built as code so the cut can be regenerated after every product change.

1. `narrate.py`: local Kokoro TTS (voice `af_heart`, speed 1.06), one WAV per section, with `audio/durations.json`.
   Pronunciation fixes live in `FIX`.
2. `capture.py` (next): Playwright drives the real app in filming mode (`?clean=1`) and saves the shots per section.
3. `cards.py` (next): HTML → PNG cards (problem and sources, architecture) in the app's fonts. Every number on a card
   comes from a results file or a cited source.
4. `assemble.py` (next): ffmpeg. Rules enforced in code: total < 2:50; each section's footage ≥ its narration; hard cuts
   between different screens; captions as a separate `.srt`; no third-party logos or game art.

Setup: `uv venv video/.venv --python 3.11 && VIRTUAL_ENV=video/.venv uv pip install kokoro soundfile numpy playwright pillow`
plus the spaCy model `en_core_web_sm`.
