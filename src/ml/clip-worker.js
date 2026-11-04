// Фоновый поток для CLIP: превращает фото и текстовые запросы в векторы «смысла».
// Модели скачиваются с Hugging Face один раз и дальше берутся из кэша браузера.
//  - картинки: CLIP ViT-B/32 (≈ 89 МБ)
//  - текст: многоязычная версия CLIP (понимает русский, ≈ 136 МБ) — грузится только при поиске
import { AutoProcessor, CLIPVisionModelWithProjection, AutoTokenizer, AutoModel, RawImage, env } from '@huggingface/transformers';

// Движок ONNX Runtime (JS + WebAssembly) берём со своего сайта, а не с CDN jsdelivr:
// исполняемый код приходит только от нас, из сети скачиваются лишь веса моделей.
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL(ortMjs, self.location.href).href,
  wasm: new URL(ortWasm, self.location.href).href,
};

const VISION = 'Xenova/clip-vit-base-patch32';
const TEXT = 'aurantium/clip-ViT-B-32-multilingual-v1';

let visionP = null;
let textP = null;

function progress(model) {
  const files = new Map();
  return (e) => {
    if (e.status !== 'progress' || !e.total) return;
    files.set(e.file, [e.loaded, e.total]);
    let loaded = 0;
    let total = 0;
    for (const [l, t] of files.values()) {
      loaded += l;
      total += t;
    }
    postMessage({ type: 'progress', model, loaded, total });
  };
}

function loadVision() {
  return (visionP ||= (async () => {
    const cb = progress('vision');
    const processor = await AutoProcessor.from_pretrained(VISION, { progress_callback: cb });
    const model = await CLIPVisionModelWithProjection.from_pretrained(VISION, { dtype: 'q8', progress_callback: cb });
    postMessage({ type: 'ready', model: 'vision' });
    return { processor, model };
  })().catch((e) => {
    visionP = null;
    throw e;
  }));
}

function loadText() {
  return (textP ||= (async () => {
    const cb = progress('text');
    const tokenizer = await AutoTokenizer.from_pretrained(TEXT, { progress_callback: cb });
    const model = await AutoModel.from_pretrained(TEXT, { dtype: 'q8', progress_callback: cb });
    postMessage({ type: 'ready', model: 'text' });
    return { tokenizer, model };
  })().catch((e) => {
    textP = null;
    throw e;
  }));
}

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

const handlers = {
  async loadVision() {
    await loadVision();
    return true;
  },
  async loadText() {
    await loadText();
    return true;
  },
  async embedImage({ pixels, width, height }) {
    const { processor, model } = await loadVision();
    const img = new RawImage(new Uint8ClampedArray(pixels), width, height, 4).rgb();
    const { image_embeds } = await model(await processor(img));
    return normalize(image_embeds.data);
  },
  async embedText({ text }) {
    const { tokenizer, model } = await loadText();
    const out = await model(await tokenizer([text], { padding: true, truncation: true }));
    return normalize(out.sentence_embedding.data);
  },
};

onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    const result = await handlers[type](data);
    postMessage({ id, result }, result instanceof Float32Array ? [result.buffer] : []);
  } catch (e) {
    postMessage({ id, error: e?.message || String(e) });
  }
};
