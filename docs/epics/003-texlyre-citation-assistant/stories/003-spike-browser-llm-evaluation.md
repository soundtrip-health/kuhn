# Browser LLM Feasibility Evaluation: Qwen 3 1.7B for Kuhn

**Date:** 2026-04-11
**Story:** [003 — Spike in-browser Qwen 3 1.7B integration](003-spike-browser-llm.md)
**Status:** Complete

---

## Executive Summary

Qwen 3 1.7B is a viable browser-resident model for Kuhn's lightweight assistant tasks. It exists as a released model, is available in multiple browser-ready formats (MLC-compiled for WebLLM, ONNX for Transformers.js), and fits within browser memory constraints at 4-bit quantization (~1.1 GB download, ~1.5-2.0 GB VRAM). On Apple Silicon hardware, expect 80-120 tokens/second decode speed; on mid-range Windows machines with discrete GPUs, 40-70 tok/s; on integrated GPUs, 15-30 tok/s. Cold start is 10-25 seconds; warm start from cache is 1-3 seconds.

**Recommendation: Proceed with Qwen 3 1.7B via WebLLM as the primary runtime.** Use WebGPU with WASM as a degraded fallback. Consider Qwen 3.5 0.8B as a lighter alternative if the 1.7B proves too heavy for target hardware profiles. Defer to a server-side model for users on unsupported browsers or very old hardware.

### Notes
  - Let's start with Qwen 3.5B
  
---

## 1. Browser LLM Runtimes

### 1.1 WebLLM (MLC AI)

**Maturity:** Production-grade. Version 0.2.82+. Published [academic paper](https://arxiv.org/html/2412.15803v1). Active development on [GitHub](https://github.com/mlc-ai/web-llm) with regular releases.

**Architecture:** Uses Apache TVM machine-learning compiler to produce optimized WebGPU kernels. Models are compiled ahead of time into an MLC format that includes the computation graph and quantized weights. The runtime loads these shards and executes inference entirely in-browser via WebGPU.

**Qwen 3 support:** Direct. MLC-AI publishes prebuilt Qwen3 models on Hugging Face:
- [`mlc-ai/Qwen3-1.7B-q0f16-MLC`](https://huggingface.co/mlc-ai/Qwen3-1.7B-q0f16-MLC) (f16 weights, ~3.4 GB)
- [`mlc-ai/Qwen3-0.6B-q4f16_1-MLC`](https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_1-MLC) (4-bit, smaller)
- [`mlc-ai/Qwen3-4B-q4f16_1-MLC`](https://huggingface.co/mlc-ai/Qwen3-4B-q4f16_1-MLC) (4-bit)

A prebuilt `Qwen3-1.7B-q4f16_1-MLC` variant does not appear on Hugging Face as of this writing, but MLC-LLM supports [custom model compilation](https://llm.mlc.ai/docs/compilation/compile_models.html), and the 0.6B q4 variant is already published, so compiling the 1.7B at q4 is straightforward.

**Quantization:** MLC uses its own quantization scheme (`q0f16`, `q4f16_1`, `q4f32_1`). The `q4f16_1` format uses 4-bit weights with f16 activations, achieving the best size/quality tradeoff for browser deployment.

**Key strengths:**
- Fastest browser LLM runtime in benchmarks (71-80% of native MLC-LLM speed)
- OpenAI-compatible chat API (`engine.chat.completions.create`)
- Built-in grammar/JSON-constrained generation (critical for structured output)
- Web Worker support for non-blocking UI
- Built-in model caching (Cache API or IndexedDB)
- Streaming token support

**Key weaknesses:**
- WebGPU-only for the fast path (no WASM fallback built in)
- Requires MLC-compiled model format (cannot use GGUF directly)
- Custom model compilation adds a build step

**Verdict:** Best choice for Kuhn. Fastest runtime, excellent Qwen 3 support, structured generation, and a clean API.

### 1.2 Transformers.js (Hugging Face)

**Maturity:** Stable. Version 3.8.1+. Widely adopted. Active development on [GitHub](https://github.com/huggingface/transformers.js/).

**Architecture:** Uses ONNX Runtime for inference. Supports both WASM (CPU) and WebGPU (GPU) backends. Models are converted to ONNX format via Hugging Face Optimum.

**Qwen 3 support:** Available. [`onnx-community/Qwen3-1.7B-ONNX`](https://huggingface.co/onnx-community/Qwen3-1.7B-ONNX) exists on Hugging Face and is marked as Transformers.js compatible. Qwen3 architecture support was added in recent releases, including Qwen3-VL support. However, some users have reported [ONNX export challenges](https://huggingface.co/onnx-community/Qwen3-1.7B-ONNX/discussions/1) with novel Qwen3 architecture features.

**Quantization:** ONNX supports fp32, fp16, q8, and q4 via ONNX Runtime's built-in quantization.

**Key strengths:**
- Dual backend: WebGPU for fast inference, WASM for universal fallback
- Huge ecosystem of pre-converted models
- Familiar HF pipeline API
- Good for non-LLM tasks too (embeddings, classification, etc.)
- New C++-based WebGPU runtime in latest versions

**Key weaknesses:**
- Slower than WebLLM for LLM text generation (ONNX overhead)
- ONNX conversion can be fragile for newer architectures
- No built-in grammar-constrained generation
- Lower community adoption for browser LLM specifically vs. WebLLM

**Verdict:** Strong fallback option, especially if WASM CPU support is needed. Lower performance ceiling than WebLLM for text generation.

### 1.3 MediaPipe LLM Inference (Google)

**Maturity:** Active but transitional. Google [recommends migrating to LiteRT-LM](https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference/web_js). Primarily optimized for Google's own Gemma models.

**Qwen 3 support:** Not explicitly documented for the web version. The API primarily targets Gemma-3n E4B and E2B models. Qwen support exists on mobile platforms but browser support is Gemma-focused.

**Key weaknesses:**
- Gemma-centric; third-party model support unclear for web
- Migration path to LiteRT-LM creates uncertainty
- Requires WebGPU (no WASM fallback)

**Verdict:** Not recommended for Kuhn. Too tightly coupled to the Gemma ecosystem and undergoing a platform transition.

### 1.4 Other Options

**Chrome Built-in AI (Prompt API):** Chrome ships a built-in Gemini Nano model accessible via `window.ai`. Zero download, instant load. However: Chrome-only, Gemini Nano only (no Qwen), limited customization, and still behind an origin trial. Not suitable as a primary path but worth monitoring.

**wllama / llama.cpp WASM:** Direct port of llama.cpp to WebAssembly. Supports GGUF models natively. Very slow (CPU-only, 2-5 tok/s). Only viable as a last-resort fallback.

---

## 2. Qwen 3 1.7B Specifics

### 2.1 Existence and Release Status

**Confirmed released.** Qwen3-1.7B was released on April 29, 2025 as part of the Qwen3 family. It is a dense (non-MoE) model available under the **Apache 2.0 license** (fully permissive).

The full Qwen3 size lineup: 0.6B, **1.7B**, 4B, 8B, 14B, 32B (dense) and 30B-A3B, 235B-A22B (MoE).

### 2.2 Architecture

| Property | Value |
|----------|-------|
| Parameters | 1.7B total (1.4B non-embedding) |
| Layers | 28 |
| Hidden dimension | 2048 |
| Attention | GQA: 16 query heads, 8 KV heads |
| Activation | SwiGLU |
| Normalization | RMSNorm (pre-norm) |
| Position encoding | RoPE with adjusted base frequency |
| Context window | 32,768 tokens (extensible via YaRN) |
| Training data | ~36T tokens, 119 languages |
| Knowledge cutoff | December 2024 |

**Dual-mode operation:** Qwen3 models support both "thinking" (step-by-step reasoning, uses `<think>` tags) and "non-thinking" (direct response) modes within the same weights. For Kuhn's tasks, non-thinking mode is preferred for speed.

### 2.3 Available Formats and Download Sizes

**GGUF (via [unsloth/Qwen3-1.7B-GGUF](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF)):**

| Quantization | File Size | Notes |
|-------------|-----------|-------|
| BF16 | 3.45 GB | Full precision baseline |
| Q8_0 | 1.83 GB | Near-lossless |
| Q6_K | 1.42 GB | Best quality/size ratio |
| Q5_K_M | 1.26 GB | |
| Q4_K_M | 1.11 GB | Sweet spot for browser |
| Q4_0 | 1.06 GB | |
| Q3_K_M | 940 MB | |
| Q2_K | 778 MB | Noticeable quality loss |
| UD-IQ1_S | 538 MB | Extreme compression |

**MLC format:**
- `q0f16` (f16 weights): ~3.4 GB — too large for browser
- `q4f16_1` (4-bit weights, f16 activations): estimated ~1.1 GB based on the 0.6B variant scaling

**ONNX format:**
- [`onnx-community/Qwen3-1.7B-ONNX`](https://huggingface.co/onnx-community/Qwen3-1.7B-ONNX) exists; specific sizes vary by quantization level

### 2.4 Task Suitability

Qwen3-1.7B is a general-purpose language model. For Kuhn's specific tasks:

| Task | Suitability | Notes |
|------|-------------|-------|
| Intent classification | High | Straightforward classification well within 1.7B capability |
| Nearby-context reading | High | 32K context window is more than sufficient |
| Search query generation | High | Core strength — language understanding + reformulation |
| Result summarization | Medium-High | Quality adequate for short summaries; may struggle with nuance |
| Bibliographic fact generation | **Do not use** | Will hallucinate DOIs, authors, venues, dates |

Qwen3-1.7B-Base performs comparably to Qwen2.5-3B-Base, and outperforms larger Qwen2.5 models in STEM, coding, and reasoning. This suggests good quality for a 1.7B model. The dual-mode design means we can use non-thinking mode for fast responses and thinking mode for more complex query construction when latency budget allows.

---

## 3. Performance Expectations

### 3.1 Benchmarked Performance (WebLLM on Apple M3 Max)

From the [WebLLM paper](https://arxiv.org/html/2412.15803v1) and [community benchmarks](https://dev.to/refactory/i-ran-three-llms-entirely-in-the-browser-to-power-an-ai-coaching-feature-heres-what-i-measured-9jm):

| Model | Download | Cold Load | Warm Load | Decode (tok/s) | GPU VRAM |
|-------|----------|-----------|-----------|----------------|----------|
| Llama-3.2-1B q4f16 | 0.7 GB | 11.7s | 1.4s | 118.6 | ~1.1 GB |
| Llama-3.2-3B q4f16 | 1.3 GB | 23.7s | 2.3s | 49.8 | ~3.0 GB |
| Phi-3.5-mini q4f16 | 2.0 GB | 37.4s | 2.4s | 52.5 | ~2.3 GB |

Hardware: Apple MacBook Pro M3 Max, 64 GB, Chrome with WebGPU. WebLLM v0.2.82.

**Extrapolated Qwen3-1.7B q4 performance on M3 Max:** The 1.7B parameter count sits between Llama-3.2-1B and Llama-3.2-3B. Based on scaling:
- **Download:** ~1.1 GB
- **Cold load:** ~15-20 seconds
- **Warm load:** ~1.5-2.0 seconds
- **Decode speed:** ~70-100 tokens/second
- **GPU VRAM:** ~1.5-2.0 GB

### 3.2 Hardware-Specific Estimates

| Hardware | Decode (tok/s) | Cold Load | Warm Load | Practical? |
|----------|----------------|-----------|-----------|------------|
| Apple M1/M2 Mac | 50-80 | 15-25s | 1.5-2.5s | Yes |
| Apple M3/M4 Mac | 80-120 | 12-20s | 1.5-2.0s | Yes |
| Windows + RTX 3060/4060 | 40-70 | 15-25s | 2-3s | Yes |
| Windows + Intel iGPU (12th+ gen) | 15-30 | 25-40s | 3-5s | Marginal |
| Windows + older Intel iGPU | 5-15 | 40-60s | 5-10s | Poor |
| WASM fallback (any CPU) | 2-5 | N/A | N/A | Too slow for interactive use |

### 3.3 Latency Budget for Kuhn Tasks

For Kuhn's `/cite` flow, the critical path is:

1. **Intent classification:** ~10-20 tokens output -> 0.1-0.3s on decent hardware
2. **Query generation from context:** ~30-80 tokens output -> 0.3-1.0s
3. **Result summarization:** ~50-150 tokens output -> 0.5-2.0s

These latencies are acceptable for an interactive assistant. The user perceives the external API call to citation providers (PubMed, arXiv, etc.) as the bottleneck, not the local model.

### 3.4 First-Token Latency (Prefill)

Prefill speed (processing the input prompt) depends on context length. For typical Kuhn prompts (system prompt + nearby paragraph + user hint, ~500-1000 tokens), expect:
- M3 Max: 200-500ms prefill
- Discrete GPU: 300-800ms prefill
- Integrated GPU: 500-1500ms prefill

This is fast enough that streaming output feels responsive.

---

## 4. Packaging Considerations

### 4.1 Model Delivery and Caching

**WebLLM's built-in caching** handles the heaviest lift:

1. **First visit:** Model weights (~1.1 GB for q4) are downloaded from a CDN (Hugging Face or self-hosted) in parallel chunks. WebLLM shows a progress callback.
2. **Subsequent visits:** Weights are loaded from browser cache (Cache API or IndexedDB). Load time drops from ~15-25s to ~1.5-2.5s.
3. **Cache eviction:** Browser Cache API entries persist until the browser evicts them under storage pressure. Using the `navigator.storage.persist()` API can request persistent storage.

**Recommended CDN strategy:** Host model weights on a CDN (Cloudflare R2, AWS CloudFront, or even Hugging Face Hub directly). WebLLM supports custom model URLs via `modelUrl` configuration.

### 4.2 Impact on Initial Page Load

**The model should NOT block page load.** Strategy:

1. **Lazy initialization:** Load the editor immediately. Initialize the LLM engine in a Web Worker when the user first invokes a command that needs it (e.g., `/cite`), or after a short idle period.
2. **Progress indicator:** Show a one-time "Downloading AI assistant (~1.1 GB)" progress bar on first use. Subsequent loads show "Loading AI assistant..." for 1-2 seconds.
3. **Graceful degradation:** If the model is still loading when the user invokes `/cite`, fall back to a simpler heuristic query construction (keyword extraction from the sentence) while the model loads in the background.

### 4.3 Progressive Loading Architecture

```
Page load
  |
  +-- Editor renders immediately
  |
  +-- (idle / first command) --> Web Worker spawns
  |                                |
  |                                +-- Check cache (Cache API / IndexedDB)
  |                                |     |
  |                                |     +-- HIT: Load from cache (~2s)
  |                                |     +-- MISS: Download from CDN (~15-25s)
  |                                |
  |                                +-- WebGPU engine initialized
  |                                +-- Ready signal sent to main thread
  |
  +-- User invokes /cite
        |
        +-- If engine ready: process immediately
        +-- If engine loading: show "AI loading..." + use fallback
```

### 4.4 Offline Capability

Once cached, the model runs entirely offline. This is a significant advantage for Kuhn's privacy model. The LLM processes context locally; only the citation provider API calls require network access (and users can configure which providers to use).

### 4.5 Storage Budget

| Component | Size |
|-----------|------|
| Model weights (q4) | ~1.1 GB |
| WASM runtime (if used) | ~10-20 MB |
| WebGPU shader cache | ~5-10 MB |
| **Total** | **~1.1-1.15 GB** |

This is within the bounds of modern web apps. For context, Google Earth uses ~500 MB of cached data, and many PWAs cache hundreds of megabytes of assets.

---

## 5. Alternative Models

### 5.1 Comparison Matrix

| Model | Params | License | Q4 Size | Browser Runtime | Quality (relative) | Notes |
|-------|--------|---------|---------|-----------------|---------------------|-------|
| **Qwen 3 1.7B** | 1.7B | Apache 2.0 | ~1.1 GB | WebLLM (MLC), Transformers.js (ONNX) | Baseline | Dual-mode thinking/non-thinking. Strong reasoning for size. |
| **Qwen 3 0.6B** | 0.6B | Apache 2.0 | ~400 MB | WebLLM (MLC q4f16 prebuilt) | 60-70% of 1.7B | Much lighter. May suffice for intent classification + simple query gen. |
| **Qwen 3.5 0.8B** | 0.8B | Apache 2.0 | ~500 MB | Likely (released March 2026) | 75-85% of Qwen3 1.7B | Newer architecture (hybrid Gated Delta + MoE). Gains ~2.5 pts over Qwen3 0.6B. |
| **Qwen 3.5 2B** | 2B | Apache 2.0 | ~1.2 GB | Likely (released March 2026) | 110-120% of Qwen3 1.7B | Better quality, similar size. But MLC-compiled format may not be available yet. |
| **Phi-4 Mini** | 3.8B | MIT | ~2.0 GB | WebLLM (prebuilt), ONNX (prebuilt) | Higher quality | Strong reasoning, but 2x the download size. 37s cold load. |
| **Gemma 4 E2B** | ~2B effective | Gemma license | ~500 MB-1 GB | WebLLM, Transformers.js, MediaPipe | Competitive | Google's latest. Purpose-built for edge. Multimodal. New (April 2026). |
| **Gemma 3n E2B** | ~2B effective | Gemma license | ~500 MB-1 GB | MediaPipe, WebLLM | Competitive | Predecessor to Gemma 4. Uses parameter skipping for efficiency. |
| **Llama 3.2 1B** | 1.3B | Llama 3.2 license | ~700 MB | WebLLM (prebuilt) | 85-90% of 1.7B | Fast (118 tok/s on M3 Max). Meta license has some restrictions. |
| **Llama 3.2 3B** | 3.2B | Llama 3.2 license | ~1.3 GB | WebLLM (prebuilt) | Higher quality | Good quality but heavier. License restrictions for large deployments. |
| **SmolLM2 1.7B** | 1.7B | Apache 2.0 | ~1.0 GB | WebLLM, Transformers.js | 90-95% of Qwen3 1.7B | HuggingFace's model. Trails Qwen3 in recent benchmarks. |

### 5.2 Analysis

**Qwen 3 1.7B remains the best default choice** because:
1. Apache 2.0 license (no restrictions)
2. Strong quality-to-size ratio (performs like Qwen2.5-3B)
3. Dual-mode architecture gives flexibility
4. MLC-compiled format already exists (just needs q4 compilation)
5. Active ecosystem with Qwen 3.5 as an upgrade path

**If 1.1 GB download is too heavy,** consider:
- **Qwen 3.5 0.8B** (~500 MB): Newer, better architecture, nearly as capable for simple tasks. Best lighter alternative.
- **Qwen 3 0.6B** (~400 MB): Already has a prebuilt MLC q4 variant. Lowest-friction option but weakest quality.

**If higher quality is needed,** consider:
- **Qwen 3.5 2B** (~1.2 GB): Better quality at similar size. Wait for MLC compilation.
- **Gemma 4 E2B** (~500 MB-1 GB): Strong contender from Google, purpose-built for edge. Watch for browser runtime maturity.

---

## 6. WebGPU Browser Support Status

As of April 2026, [WebGPU is supported by all major browsers](https://web.dev/blog/webgpu-supported-major-browsers):

| Browser | Status |
|---------|--------|
| Chrome / Edge | Stable since v113 (2023). Android since v121. |
| Firefox | Windows stable since v141. macOS ARM64 since v145. Linux expected 2026. |
| Safari | macOS Tahoe 26, iOS 26, iPadOS 26 (released 2026). |

**Coverage:** ~70% of global browser traffic supports WebGPU natively. For the remaining ~30%, the WASM fallback path (via Transformers.js) provides degraded but functional service for simple tasks, or the server-side API fallback handles the request entirely.

For Kuhn's audience (researchers and technical writers on relatively modern hardware), WebGPU coverage is likely higher than the global average.

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| q4 MLC compilation not available for 1.7B | Low | Medium | Compile ourselves (documented process), or use q0f16 on high-memory devices, or drop to 0.6B q4 |
| Model too slow on integrated GPUs | Medium | Medium | Offer server-side fallback; use smaller model (0.6B); detect GPU capability at runtime |
| 1.1 GB download deters users | Medium | Low | Show progress bar with explanation; cache aggressively; model is optional for basic editing |
| WebGPU bugs on specific hardware | Medium | Low | Runtime detection; WASM fallback; server fallback |
| Model quality insufficient for query generation | Low | High | Test empirically in spike; swap to 3.5-2B or Phi-4 Mini if needed |
| Browser storage quota exceeded | Low | Low | `navigator.storage.persist()`; handle eviction gracefully |
| Qwen 3.5 renders Qwen 3 obsolete quickly | Medium | Low | Architecture supports model swaps; Qwen 3.5 is an upgrade, not a pivot |

---

## 8. Recommendation

### Primary Path: Proceed with Qwen 3 1.7B via WebLLM

**Runtime:** WebLLM (MLC AI) with WebGPU backend.

**Model:** Qwen3-1.7B at q4f16_1 quantization (~1.1 GB download).

**Rationale:**
- WebLLM is the fastest browser LLM runtime and has direct Qwen3 support
- 1.7B at q4 provides good quality for intent classification and query generation at a reasonable download size
- Apache 2.0 license imposes no restrictions
- ~70-100 tok/s on Apple Silicon and ~40-70 tok/s on discrete GPUs is fast enough for all Kuhn tasks
- Warm load from cache is ~1.5-2s, which feels instant
- Grammar-constrained generation in WebLLM enables reliable structured output (JSON intents, structured queries)

**Action items for the spike:**
1. Compile `Qwen3-1.7B` to MLC `q4f16_1` format (or check if MLC-AI has published it by the time work begins)
2. Build a minimal test harness: load model in a Web Worker, measure cold/warm load time, prefill latency, decode speed
3. Test on three hardware profiles: M-series Mac, Windows + discrete GPU, Windows + integrated GPU
4. Evaluate output quality on 20+ sample prompts covering intent classification, query generation, and summarization
5. Measure memory pressure and verify the browser remains responsive during inference

### Fallback Tiers

| Tier | Trigger | Action |
|------|---------|--------|
| **Tier 0** | WebGPU available, model cached | Full local inference via WebLLM (~2s ready) |
| **Tier 1** | WebGPU available, model not cached | Download + cache model; use heuristic query gen during download |
| **Tier 2** | WebGPU unavailable or too slow | Server-side model inference (API call to hosted Qwen or equivalent) |
| **Tier 3** | No model, no server | Pure heuristic: extract keywords from sentence, pass directly to citation providers |

### Future Upgrade Path

When MLC-compiled Qwen 3.5 models become available for browser deployment:
- **Qwen 3.5 0.8B** as a lighter option for users on constrained hardware
- **Qwen 3.5 2B** as a quality upgrade at similar download cost
- Model selection could be user-configurable or auto-detected based on hardware capability

---

## Sources

- [Qwen3 Official Blog Post](https://qwenlm.github.io/blog/qwen3/)
- [Qwen3 Technical Report](https://arxiv.org/html/2505.09388v1)
- [Qwen3-1.7B Specifications](https://apxml.com/models/qwen3-1-7b)
- [WebLLM GitHub Repository](https://github.com/mlc-ai/web-llm)
- [WebLLM Paper](https://arxiv.org/html/2412.15803v1)
- [WebLLM Documentation](https://webllm.mlc.ai/docs/)
- [MLC-AI Qwen3-1.7B-q0f16-MLC](https://huggingface.co/mlc-ai/Qwen3-1.7B-q0f16-MLC)
- [MLC-AI Qwen3-0.6B-q4f16_1-MLC](https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_1-MLC)
- [Unsloth Qwen3-1.7B-GGUF (all quantizations)](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF)
- [ONNX Community Qwen3-1.7B-ONNX](https://huggingface.co/onnx-community/Qwen3-1.7B-ONNX)
- [Transformers.js GitHub](https://github.com/huggingface/transformers.js/)
- [Transformers.js v3 Blog Post](https://huggingface.co/blog/transformersjs-v3)
- [Browser LLM Benchmarks (3 models tested)](https://dev.to/refactory/i-ran-three-llms-entirely-in-the-browser-to-power-an-ai-coaching-feature-heres-what-i-measured-9jm)
- [WebGPU Browser Support Status](https://web.dev/blog/webgpu-supported-major-browsers)
- [WebGPU Can I Use](https://caniuse.com/webgpu)
- [MediaPipe LLM Inference for Web](https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference/web_js)
- [Chrome Cache Models Guide](https://developer.chrome.com/docs/ai/cache-models)
- [Mozilla 3W Architecture (WebLLM + WASM + WebWorkers)](https://blog.mozilla.ai/3w-for-in-browser-ai-webllm-wasm-webworkers/)
- [WebGPU vs WebASM Benchmarks](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/)
- [Qwen 3.5 Small Series](https://www.marktechpost.com/2026/03/02/alibaba-just-released-qwen-3-5-small-models-a-family-of-0-8b-to-9b-parameters-built-for-on-device-applications/)
- [Gemma 4 Announcement](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/)
- [Small Language Models Guide 2026](https://localaimaster.com/blog/small-language-models-guide-2026)
- [Qwen3 0.6B Intent Classification Fine-tune](https://huggingface.co/empathyai/Qwen3-0.6B-Books-Intent)
- [WebGPU Browser AI Cost Analysis 2026](https://www.buildmvpfast.com/blog/webgpu-browser-ai-inference-cost-savings-2026)
- [Koyeb WebLLM + Qwen 3 Tutorial](https://www.koyeb.com/tutorials/build-a-hybrid-ai-app-with-web-llm-qwen-3-next-js)
