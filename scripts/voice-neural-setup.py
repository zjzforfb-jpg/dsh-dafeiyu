"""Run with runtime/voice/neural-venv/bin/python after installing requirements."""
import json
import os
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "runtime/voice"
os.umask(0o077)
os.environ["HF_HOME"] = str(root / "huggingface")
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
from huggingface_hub import snapshot_download

repo = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit"
revision = "f35faf19b0cc2160865af64ecf0f22f83d335135"
path = snapshot_download(repo, revision=revision)
manifest = root / "neural-model.json"
manifest.write_text(json.dumps({"repo": repo, "revision": revision, "path": path}))
manifest.chmod(0o600)
print("Neural voice model ready; production voice has not been changed.")
