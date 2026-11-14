# 豆包语音回复的底层原理，与我们的复刻程度

## 豆包（端到端实时语音）是怎么做的

1. **一条链路**：用户音频直接进模型，模型直接出音频（speech-to-speech，S2S），中间没有「ASR → 文本 → TTS」三段拼接。
2. **全双工**：上行音频持续推流（`input_audio_buffer.append`），下行音频也是流式（`response.output_audio.delta`），边说边听。
3. **模型自己判轮次**：不靠外部 VAD，靠模型内部的语义断句（可配 `end_smooth_window_ms`，默认 1500ms 级别）。
4. **可打断**：用户一开口就 `response.cancel`，模型立刻停播，不需要等一句话说完。
5. **延迟来源**：首包延迟 ≈ 网络 RTT + 模型首 token + 音频编码，官方口径亚秒级。

## 我们现在的实现（对照）

| 环节 | 豆包 | 我们（/call 与声卡桥） |
| --- | --- | --- |
| 传输 | WebSocket 实时音频 | WebSocket PCM16（页面）/ BlackHole（桌面通话） |
| 断句 | 模型内部 | **外部 VAD**（RMS 阈值 + 700ms 静音） |
| 识别 | 模型内 | whisper.cpp 整段转写（0.8–1.2s） |
| 生成 | S2S | DeepSeek 文本，**已改流式**（首 token 450ms） |
| 合成 | 模型出音频 | MiniMax TTS，**已按句流式**（首包 524ms） |
| 打断 | response.cancel | 页面 barge-in（cancel + 停播），桌面桥暂未打断 |
| 音色 | 可换/可复刻 | 固定 ExplorativeGirl（为了音色不变） |

## 这次「简单复刻」做了什么

`connect/call/service.mjs` 增加**流水线分支**：

```
whisper 出文字 → DeepSeek 流式返回 → 遇到句号/问号就立刻合成这句
                                    → 第一句音频先下发，后面边说边合成
```

- 新增 `callBrainStream(home)`：SSE 逐字返回；
- `CallService` 收到 `askStream` 时按句切分，句子一完成就 `streamSynthesize` 下发 `audio_chunk`；
- 效果：不再等整段回复（原来要 3.4–5.3s 才出第一声），理论首包 ≈ whisper(1s) + 首句生成(0.5s) + 首句 TTS(0.5s)。

## 还差的

1. **流式 ASR**：whisper 仍是整段；要接近豆包需要边说边出字（whisper-stream / sherpa-onnx）。
2. **模型内断句**：仍是外部 VAD；可以先做「VAD 松一点 + 语句未说完也先送模型」的近似。
3. **桌面通话打断**：页面支持 barge-in，声卡桥还是一次说完再说。
4. **端到端音色**：要真正的 S2S 就得放弃当前音色（或做声音复刻），与「音色不变」冲突，暂不做。
