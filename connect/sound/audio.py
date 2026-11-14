#!/usr/bin/env python3
"""Audio device bridge for the sound-card call channel.

Capture: read a device (default BlackHole 16ch), downmix to mono 16k PCM16,
write to stdout.
Playback: read mono PCM16 at 24k from stdin, resample to the output device rate,
write to the device (default BlackHole 2ch).

Status lines are JSON on stderr so the Node supervisor can report progress.
"""
import argparse
import json
import signal
import sys
import threading

import numpy as np
import sounddevice as sd

stop = threading.Event()


def fail(code, message):
    sys.stderr.write(json.dumps({"event": "error", "code": code, "message": message}) + "\n")
    sys.stderr.flush()
    raise SystemExit(1)


def find_device(name, kind):
    for index, info in enumerate(sd.query_devices()):
        if name.lower() not in info["name"].lower():
            continue
        if kind == "input" and info["max_input_channels"] > 0:
            return index, info
        if kind == "output" and info["max_output_channels"] > 0:
            return index, info
    fail("device_not_found", f"{kind} device not found: {name}")


def resample(samples, rate_from, rate_to):
    if rate_from == rate_to or not len(samples):
        return samples
    count = int(round(len(samples) * rate_to / rate_from))
    if count <= 0:
        return np.zeros(0, dtype=np.float32)
    source = np.linspace(0.0, 1.0, len(samples), endpoint=False)
    target = np.linspace(0.0, 1.0, count, endpoint=False)
    return np.interp(target, source, samples).astype(np.float32)


def capture(args):
    index, info = find_device(args.input, "input")
    channels = max(1, min(2, info["max_input_channels"]))
    frames = max(64, int(args.capture_rate * args.block_ms / 1000))
    monitor = None
    if args.monitor:
        monitor_index, monitor_info = find_device(args.monitor, "output")
        monitor_channels = max(1, min(2, monitor_info["max_output_channels"]))
        monitor = sd.OutputStream(device=monitor_index, channels=monitor_channels, samplerate=args.capture_rate, dtype="float32", blocksize=frames)
        monitor.start()
        sys.stderr.write(json.dumps({"event": "monitor", "device": monitor_info["name"]}) + "\n")
        sys.stderr.flush()
    sys.stderr.write(json.dumps({"event": "capture", "device": info["name"], "channels": channels, "rate": args.capture_rate}) + "\n")
    sys.stderr.flush()
    with sd.InputStream(device=index, channels=channels, samplerate=args.capture_rate, dtype="float32", blocksize=frames) as stream:
        while not stop.is_set():
            data, _ = stream.read(frames)
            mono = data.mean(axis=1) if channels > 1 else data[:, 0]
            if monitor is not None:
                monitor.write(np.repeat(mono[:, None], monitor_channels, axis=1))
            mono = resample(mono, args.capture_rate, args.stdout_rate)
            pcm = np.clip(mono, -1.0, 1.0)
            sys.stdout.buffer.write((pcm * 32767).astype("<i2").tobytes())
            sys.stdout.buffer.flush()


def playback(args):
    index, info = find_device(args.output, "output")
    channels = max(1, min(2, info["max_output_channels"]))
    frames = max(64, int(args.play_rate * args.block_ms / 1000))
    bytes_per_block = int(args.out_rate * args.block_ms / 1000) * 2
    sys.stderr.write(json.dumps({"event": "playback", "device": info["name"], "channels": channels, "rate": args.play_rate}) + "\n")
    sys.stderr.flush()
    with sd.OutputStream(device=index, channels=channels, samplerate=args.play_rate, dtype="float32", blocksize=frames) as stream:
        while not stop.is_set():
            block = sys.stdin.buffer.read(bytes_per_block)
            if not block:
                break
            samples = np.frombuffer(block, dtype="<i2").astype(np.float32) / 32768.0
            samples = resample(samples, args.out_rate, args.play_rate)
            if not len(samples):
                continue
            out = np.repeat(samples[:, None], channels, axis=1)
            stream.write(out)


def list_devices():
    devices = []
    for index, info in enumerate(sd.query_devices()):
        if info["max_input_channels"] <= 0 and info["max_output_channels"] <= 0:
            continue
        devices.append({
            "index": index,
            "name": info["name"],
            "input": info["max_input_channels"],
            "output": info["max_output_channels"],
            "rate": info["default_samplerate"],
        })
    print(json.dumps({"devices": devices}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--input", default="BlackHole 16ch")
    parser.add_argument("--output", default="BlackHole 2ch")
    parser.add_argument("--monitor", default="")
    parser.add_argument("--capture-rate", type=int, default=48000)
    parser.add_argument("--play-rate", type=int, default=48000)
    parser.add_argument("--out-rate", type=int, default=24000)
    parser.add_argument("--stdout-rate", type=int, default=16000)
    parser.add_argument("--block-ms", type=int, default=20)
    args = parser.parse_args()
    if args.list:
        list_devices()
        return
    if not args.input and not args.output:
        fail("no_devices", "nothing to capture or play")
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    output_thread = None
    if args.output:
        output_thread = threading.Thread(target=playback, args=(args,), daemon=True)
        output_thread.start()
    if args.input:
        capture(args)
    if output_thread:
        output_thread.join(timeout=2)


if __name__ == "__main__":
    main()
