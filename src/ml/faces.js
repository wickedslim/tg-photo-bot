// Поиск лиц и их «отпечатков» (векторов) на устройстве — библиотека Human (TensorFlow.js, WebGL).
// Модели лежат на нашем же сайте (public/models/human), их ≈ 9 МБ.
let humanP = null;

const CONFIG = {
  modelBasePath: import.meta.env.BASE_URL + 'models/human/',
  backend: 'humangl',
  debug: false,
  async: true,
  warmup: 'none',
  cacheSensitivity: 0,
  filter: { enabled: false },
  face: {
    enabled: true,
    detector: { modelPath: 'blazeface.json', rotation: true, maxDetected: 12, minConfidence: 0.55, return: false },
    mesh: { enabled: true, modelPath: 'facemesh.json' },
    attention: { enabled: false },
    iris: { enabled: false },
    description: { enabled: true, modelPath: 'faceres.json' },
    emotion: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
};

export function loadFaces() {
  return (humanP ||= (async () => {
    const { default: Human } = await import('@vladmandic/human');
    for (const backend of ['humangl', 'webgl', 'cpu']) {
      try {
        const human = new Human({ ...CONFIG, backend });
        await human.load();
        await human.tf.ready();
        return human;
      } catch (e) {
        console.warn('human backend failed', backend, e);
      }
    }
    throw new Error('Распознавание лиц не поддерживается на этом устройстве');
  })().catch((e) => {
    humanP = null;
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

// Возвращает лица: рамка в долях кадра и нормализованный вектор. Мелкие и сомнительные лица отбрасываем —
// по ним всё равно не узнать человека, а в «Людях» они дают мусор.
export async function detectFaces(canvas) {
  const human = await loadFaces();
  const res = await human.detect(canvas);
  const W = canvas.width;
  const H = canvas.height;
  const out = [];
  for (const f of res.face || []) {
    if (!f.embedding?.length) continue;
    const [x, y, w, h] = f.box;
    if (w < Math.max(36, W * 0.06) || (f.faceScore ?? f.score) < 0.6) continue;
    out.push({ b: [x / W, y / H, w / W, h / H], e: normalize(f.embedding), s: f.faceScore ?? f.score });
  }
  return out;
}
