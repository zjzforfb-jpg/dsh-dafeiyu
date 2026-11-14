"""Isolated, offline Qwen3-TTS synthesis. Text is read from a private file."""
import json
import os
import sys
from pathlib import Path

os.umask(0o077)
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"


def main():
    root, source, target = map(Path, sys.argv[1:4])
    config = json.loads((root / "tts.json").read_text())
    manifest = json.loads((root / "neural-model.json").read_text())
    speaker = config.get("speaker", "Serena")
    if speaker not in {"Serena", "Vivian", "Dylan", "Uncle_Fu", "Eric", "Ryan", "Aiden"}:
        raise ValueError("invalid_speaker")
    text = source.read_text().strip()
    if not text or len(text) > 240:
        raise ValueError("invalid_text_length")
    import numpy as np
    from scipy.io import wavfile
    from mlx_audio.tts.utils import load_model

    model = load_model(manifest["path"])
    chunks, rate = [], None
    for result in model.generate_custom_voice(
        text=text, speaker=speaker, language="Chinese",
        instruct=config.get("style", "自然、温柔地聊天，带一点轻快的笑意，不要播音腔。")[:240],
        max_tokens=750, temperature=0.7, verbose=False,
    ):
        if rate is not None and rate != result.sample_rate:
            raise ValueError("sample_rate_changed")
        rate = result.sample_rate
        chunks.append(np.asarray(result.audio, dtype=np.float32).reshape(-1))
    audio = np.concatenate(chunks) if chunks else np.array([])
    if not rate or not audio.size or not np.isfinite(audio).all() or audio.size > rate * 60:
        raise ValueError("invalid_audio")
    wavfile.write(target, rate, (np.clip(audio, -1, 1) * 32767).astype(np.int16))
    target.chmod(0o600)
    print(json.dumps({"samples": audio.size, "sample_rate": rate, "backend": "qwen3_mlx"}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never log text, library HTTP errors, or inherited environment values.
        print("neural_voice_failed", file=sys.stderr)
        sys.exit(1)
