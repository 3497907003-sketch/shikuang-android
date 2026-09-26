"use strict";

const DEEPSEEK_API_KEY = window.DEEPSEEK_API_KEY || localStorage.getItem("shikuang_ds_key") || "";
const DEEPSEEK_MODEL = window.DEEPSEEK_MODEL || "deepseek-flash";

const state = {
  mode: "photo",
  stream: null,
  recorder: null,
  recordedChunks: [],
  recording: false,
  currentImage: null,
  currentVideo: null,
  lastResult: null,
  onlineMode: false,
};

const $ = (sel) => document.querySelector(sel);
const camera = $("#camera");
const preview = $("#preview");
const placeholder = $("#placeholder");
const stage = $("#stage");
const recordingPill = $("#recordingPill");
const cameraBtn = $("#cameraBtn");
const recordBtn = $("#recordBtn");
const galleryBtn = $("#galleryBtn");
const clearBtn = $("#clearBtn");
const fileInput = $("#fileInput");
const predictBtn = $("#predictBtn");
const resultPanel = $("#result");

function setStatus(text, busy = false) {
  $("#statusText").textContent = text;
  $("#statusBadge").querySelector(".dot").style.background = busy ? "#d58a2a" : "#0f8f6b";
}

function initAmbient() {
  const canvas = $("#ambient");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let dots = [];
  const resize = () => {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const count = Math.min(70, Math.max(28, Math.round(innerWidth * innerHeight / 22000)));
    dots = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      r: Math.random() * 1.7 + 0.7,
      hue: Math.random() > 0.5 ? 154 : 34,
    }));
  };
  const tick = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < dots.length; i++) {
      const a = dots[i];
      a.x += a.vx;
      a.y += a.vy;
      if (a.x < 0 || a.x > canvas.width) a.vx *= -1;
      if (a.y < 0 || a.y > canvas.height) a.vy *= -1;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${a.hue}, 52%, 34%, .16)`;
      ctx.fill();
      for (let j = i + 1; j < dots.length; j++) {
        const b = dots[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 15000) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = "rgba(15,143,107,.055)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(tick);
  };
  addEventListener("resize", resize);
  resize();
  tick();
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  state.currentImage = null;
  state.currentVideo = null;
  preview.hidden = true;
  placeholder.hidden = false;
  camera.hidden = true;
  cameraBtn.disabled = mode !== "photo";
  recordBtn.disabled = mode !== "video";
  galleryBtn.disabled = mode !== "file";
  if (mode === "photo") {
    void startCamera();
  } else if (mode === "video") {
    void startCamera();
  } else {
    stopCamera();
  }
}

async function startCamera() {
  if (state.stream) return;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: state.mode === "video",
    });
    camera.srcObject = state.stream;
    camera.hidden = false;
    preview.hidden = true;
    placeholder.hidden = true;
  } catch (err) {
    setStatus("相机不可用");
    camera.hidden = true;
    placeholder.hidden = false;
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    camera.srcObject = null;
  }
  camera.hidden = true;
  if (!state.currentImage && !state.currentVideo) placeholder.hidden = false;
}

function showPreviewFromImage(url) {
  state.currentImage = url;
  state.currentVideo = null;
  preview.src = url;
  preview.hidden = false;
  camera.hidden = true;
  placeholder.hidden = true;
  stopCamera();
}

function showPreviewFromVideo(url) {
  state.currentVideo = url;
  state.currentImage = null;
  preview.src = "";
  preview.hidden = true;
  camera.hidden = true;
  placeholder.hidden = false;
  placeholder.innerHTML = '<i data-lucide="clapperboard"></i><p>视频已就绪</p><span>点击“识别矿物”开始分析</span>';
  if (window.lucide) lucide.createIcons();
  stopCamera();
}

function capturePhoto() {
  if (!state.stream) return;
  const canvas = document.createElement("canvas");
  canvas.width = camera.videoWidth || 1280;
  canvas.height = camera.videoHeight || 720;
  canvas.getContext("2d").drawImage(camera, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    showPreviewFromImage(URL.createObjectURL(blob));
    setStatus("照片已就绪");
  }, "image/jpeg", 0.92);
}

async function toggleRecording() {
  if (state.recording) {
    state.recorder.stop();
    return;
  }
  if (!state.stream) await startCamera();
  const mime = MediaRecorder.isTypeSupported("video/webm") ? "video/webm" : "video/mp4";
  state.recordedChunks = [];
  state.recorder = new MediaRecorder(state.stream, { mimeType: mime });
  state.recorder.ondataavailable = (e) => {
    if (e.data.size > 0) state.recordedChunks.push(e.data);
  };
  state.recorder.onstop = () => {
    state.recording = false;
    recordBtn.querySelector("i").dataset.lucide = "circle";
    if (window.lucide) lucide.createIcons();
    recordingPill.hidden = true;
    const blob = new Blob(state.recordedChunks, { type: mime });
    showPreviewFromVideo(URL.createObjectURL(blob));
    setStatus("视频已就绪");
  };
  state.recording = true;
  recordingPill.hidden = false;
  recordBtn.querySelector("i").dataset.lucide = "square";
  if (window.lucide) lucide.createIcons();
  state.recorder.start();
}

function clearAll() {
  state.currentImage = null;
  state.currentVideo = null;
  fileInput.value = "";
  $("#description").value = "";
  preview.hidden = true;
  camera.hidden = false;
  placeholder.innerHTML = '<i data-lucide="scan-line"></i><p>将矿物置于取景框内</p><span>支持照片、视频与文字描述</span>';
  placeholder.hidden = false;
  resultPanel.hidden = true;
  if (window.lucide) lucide.createIcons();
  if (state.mode === "photo" || state.mode === "video") void startCamera();
}

function dismissSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;
  splash.classList.add("done");
  setTimeout(() => splash.remove(), 700);
}

function setSplash(status) {
  const el = document.getElementById("splashStatus");
  if (el) el.textContent = status;
}

async function imageToDataUrl(src) {
  const resp = await fetch(src);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function predictOnline() {
  if (!DEEPSEEK_API_KEY) throw new Error("DeepSeek 密钥未配置，请在设置中填写后重试。");
  if (state.currentVideo) {
    const local = await predictOnnx();
    const text = await deepseekText(
      `本地识别为 ${local.name_zh}（${local.name_en}）。请判断图片是否为矿物，并补充产地、成因、工业用途和鉴别特征。`
    );
    return { ...local, ai: text };
  }
  const dataUrl = await imageToDataUrl(state.currentImage);
  const description = $("#description").value.trim();
  const prompt = [
    "你是矿物鉴定专家。请识别图片中的矿物。",
    "只能返回一个 JSON 对象，不要 Markdown，不要解释。字段：",
    '{"name_zh":"中文名","name_en":"英文名","formula":"化学式","confidence":0到1,"origin":"产地","formation":"形成原因","industrial_uses":["工业用途"],"features":["鉴别特征"]}',
    description ? `用户补充描述：${description}` : "",
    "如果不是矿物、图片不清晰、或属于人物/动物/日常物品，返回 {\"error\":\"这不是矿物，请您放入清晰的矿物照片。\"}",
  ].join("\n");
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 6000,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek 请求失败（${res.status}）`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  const jsonText = firstBrace >= 0 && lastBrace > firstBrace ? content.slice(firstBrace, lastBrace + 1) : content.trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_) {
    parsed = { name_zh: content.replace(/\n/g, " ").slice(0, 80) };
  }
  parsed = normalizeDeepSeekResult(parsed);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

function normalizeDeepSeekResult(data) {
  const first = (keys) => keys.map((k) => data[k]).find((v) => v !== undefined && v !== null && v !== "");
  return {
    ...data,
    name_zh: first(["name_zh", "矿物名称", "中文名", "名称", "矿物名"]) || data.name_zh || "",
    name_en: first(["name_en", "英文名称", "英文名", "English Name", "英文"]) || data.name_en || "",
    formula: first(["formula", "化学式", "分子式", "Formula"]) || data.formula || "",
    confidence: first(["confidence", "置信度", "Confidence"]) ?? data.confidence,
    origin: first(["origin", "产地", "Origin", "典型产地"]) || data.origin || "",
    formation: first(["formation", "形成原因", "成因", "Formation"]) || data.formation || "",
    industrial_uses: first(["industrial_uses", "工业用途", "用途", "Industrial Uses"]) || data.industrial_uses || [],
    features: first(["features", "鉴别特征", "特征", "Features"]) || data.features || [],
  };
}

async function deepseekText(prompt) {
  if (!DEEPSEEK_API_KEY) return "";
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 3000,
    }),
  });
  if (!res.ok) return "";
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function renderDeepSeekResult(data) {
  const result = {
    name_zh: data.name_zh || "未知矿物",
    name_en: data.name_en || "",
    formula: data.formula || "",
    confidence: Number(data.confidence || 0.7),
    threshold: 0.5,
    accepted: true,
    knowledge: {
      name_zh: data.name_zh,
      name_en: data.name_en,
      formula: data.formula,
      formation: data.formation,
      typical_localities: [data.origin],
      industrial_uses: data.industrial_uses || [],
      crystal_system: (data.features || []).join("；"),
      luster: "",
      hardness: "",
    },
    rankings: [{ key: data.name_en || "mineral", name_zh: data.name_zh, confidence: Number(data.confidence || 0.7) }],
    ai: data.ai || "",
  };
  renderResult(result);
  if (result.ai) {
    document.getElementById("tab-use").innerHTML += `<div class="kv"><dt>AI 辅助</dt><dd>${escapeHtml(result.ai)}</dd></div>`;
  }
}

async function predict() {
  if (!state.currentImage && !state.currentVideo) {
    setStatus("请先拍照或选择媒体");
    return;
  }
  predictBtn.disabled = true;
  predictBtn.classList.add("loading");
  $("#predictLabel").textContent = "识别中…";
  setStatus("识别中…", true);
  const form = new FormData();
  form.append("description", $("#description").value.trim());
  if (state.currentImage) {
    const resp = await fetch(state.currentImage);
    form.append("image", await resp.blob(), "specimen.jpg");
  } else if (state.currentVideo) {
    const resp = await fetch(state.currentVideo);
    form.append("video", await resp.blob(), "specimen.webm");
  }
  try {
    if (state.onlineMode) {
      const data = await predictOnline();
      renderDeepSeekResult(data);
      setStatus("识别完成");
    } else {
      const local = await predictOnnx();
      renderResult(local);
      setStatus("本地识别完成");
    }
  } catch (err) {
    let fallbackError = "";
    try {
      const local = await predictOnnx();
      renderResult(local);
      if (state.onlineMode) {
        const text = await deepseekText(`本地识别为 ${local.name_zh}（${local.name_en}）。请简要补充产地、成因、工业用途与最可靠鉴别特征。`);
        if (text) document.getElementById("tab-use").innerHTML += `<div class="kv"><dt>AI 辅助</dt><dd>${escapeHtml(text)}</dd></div>`;
      }
      setStatus("本地识别完成");
      return;
    } catch (localErr) {
      fallbackError = localErr.message || String(localErr);
    }
    setStatus("识别失败");
    resultPanel.hidden = false;
    resultPanel.classList.remove("show");
    void resultPanel.offsetWidth;
    resultPanel.classList.add("show");
    $("#resultName").textContent = "无法识别";
    $("#resultFormula").textContent = "";
    $("#resultConf").textContent = "—";
    $("#meterFill").style.width = "0";
    $("#verdict").textContent = fallbackError || err.message || "无法连接识别服务";
    $("#verdict").className = "verdict rejected";
    ["basic", "origin", "use", "graph", "rank"].forEach((id) => {
      document.getElementById(`tab-${id}`).innerHTML = "";
    });
  } finally {
    predictBtn.disabled = false;
    predictBtn.classList.remove("loading");
    $("#predictLabel").textContent = "识别矿物";
  }
}

function renderResult(data) {
  state.lastResult = data;
  resultPanel.hidden = false;
  resultPanel.classList.remove("show");
  void resultPanel.offsetWidth;
  resultPanel.classList.add("show");
  $("#resultName").textContent = `${data.name_zh} · ${data.name_en}`;
  $("#resultFormula").textContent = data.formula || "";
  const pct = Math.round(data.confidence * 100);
  $("#resultConf").textContent = `${pct}%`;
  $("#meterFill").style.width = `${pct}%`;
  const verdict = $("#verdict");
  if (data.accepted) {
    verdict.textContent = `置信度高于判定阈值 ${Math.round(data.threshold * 100)}%`;
    verdict.className = "verdict accepted";
  } else {
    verdict.textContent = `低于判定阈值 ${Math.round(data.threshold * 100)}%，建议补充描述或更换拍摄角度`;
    verdict.className = "verdict rejected";
  }

  const k = data.knowledge || {};
  $("#tab-basic").innerHTML = kvTable({
    "矿物名称": `${k.name_zh || data.name_zh} (${k.name_en || data.name_en})`,
    "化学式": k.formula || data.formula,
    "Strunz大类": k.classification?.strunz_10,
    "九大类体系": k.classification?.class_9,
    "八大类体系": k.classification?.class_8,
    "晶系": k.crystal_system,
    "摩氏硬度": k.hardness,
    "光泽": k.luster,
    "条痕": k.streak,
    "颜色": k.color,
    "晶体习性": k.habit,
  });
  $("#tab-origin").innerHTML = kvTable({
    "典型产地": (k.typical_localities || []).join("、"),
    "形成原因": k.formation,
  });
  $("#tab-use").innerHTML = tagList(k.industrial_uses || []);
  $("#tab-rank").innerHTML = (data.rankings || [])
    .map(
      (r, i) => `
      <div class="rank-row">
        <span>${i + 1}. ${r.name_zh}</span>
        <div class="rank-bar"><span style="width:${Math.round(r.confidence * 100)}%"></span></div>
        <span class="rank-conf">${Math.round(r.confidence * 100)}%</span>
      </div>`
    )
    .join("");
  renderGraph(data);
}

function renderGraph(data) {
  const panel = document.getElementById("tab-graph");
  if (!panel) return;
  const key = data.key || data.rankings?.[0]?.key;
  const graph = window.MINERAL_GRAPH?.[key];
  if (!graph || !graph.nodes?.length) {
    panel.innerHTML = "<p>暂无关系图谱</p>";
    return;
  }
  const mineral = graph.nodes.find((n) => n.id === "mineral");
  const others = graph.nodes.filter((n) => n.id !== "mineral");
  const total = others.length;
  const cx = 300;
  const cy = 220;
  const radius = Math.min(155, 88 + total * 8);
  const positions = new Map();
  positions.set("mineral", { x: cx, y: cy });
  others.forEach((node, i) => {
    const angle = (Math.PI * 2 * i) / total - Math.PI / 2;
    positions.set(node.id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  });
  const color = (type) =>
    type === "mineral"
      ? "#0a6b50"
      : type === "formula"
        ? "#c9473f"
        : type === "locality"
          ? "#b6761b"
          : type === "use"
            ? "#315fa8"
            : "#68716a";
  const short = (text) => (text.length > 10 ? `${text.slice(0, 10)}…` : text);
  const nodesSvg = graph.nodes
    .map((node) => {
      const p = positions.get(node.id);
      const fill = color(node.type);
      const r = node.type === "mineral" ? 27 : 12;
      return `<g transform="translate(${p.x} ${p.y})">
        <circle r="${r}" fill="${fill}" opacity=".92"></circle>
        <circle r="${r}" fill="none" stroke="rgba(255,255,255,.8)" stroke-width="1"></circle>
        <text y="${r + 13}" text-anchor="middle" fill="#4c554e" font-size="11">${escapeHtml(short(node.label))}</text>
      </g>`;
    })
    .join("");
  const linksSvg = graph.links
    .map((link) => {
      const a = positions.get(link.source);
      const b = positions.get(link.target);
      if (!a || !b) return "";
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="rgba(15,143,107,.25)" stroke-width="1"></line>`;
    })
    .join("");
  panel.innerHTML = `
    <div class="graph-wrap">
      <svg viewBox="0 0 600 440" role="img" aria-label="矿物关系图谱">
        <g>${linksSvg}${nodesSvg}</g>
      </svg>
      <p class="graph-hint">中心为识别矿物，外圈为成分、晶系、产地与工业用途关系。</p>
    </div>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function kvTable(rows) {
  return Object.entries(rows)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<dl class="kv"><dt>${k}</dt><dd>${v}</dd></dl>`)
    .join("");
}

function tagList(items) {
  if (!items.length) return "<p>暂无资料</p>";
  return `<div class="tag-list">${items.map((x) => `<span class="tag">${x}</span>`).join("")}</div>`;
}

let ortSessions = null;
let gateSession = null;

async function waitFor(fn, timeout = 15000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("资源加载超时");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function getOnnxSessions() {
  if (ortSessions) return ortSessions;
  await waitFor(() => !!window.ort);
  if (!window.ort) throw new Error("浏览器推理组件未加载");
  const vendorBase = new URL("./vendor/", location.href).href;
  const modelBase = new URL("./models/", location.href).href;
  window.ort.env.wasm.wasmPaths = vendorBase;
  window.ort.env.wasm.numThreads = 1;
  window.ort.env.wasm.proxy = false;
  const eff = await window.ort.InferenceSession.create(modelBase + "efficientnet.onnx?v=4", { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  const mob = await window.ort.InferenceSession.create(modelBase + "mobilenet.onnx?v=4", { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  ortSessions = [eff, mob];
  return ortSessions;
}

async function getGateSession() {
  if (gateSession) return gateSession;
  await waitFor(() => !!window.ort && !!window.IMAGENET_CLASSES);
  const modelBase = new URL("./models/", location.href).href;
  gateSession = await window.ort.InferenceSession.create(modelBase + "imagenet_gate.onnx?v=2", { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  return gateSession;
}

async function imageToImageNetTensor(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const short = Math.min(img.width, img.height);
  const sx = (img.width - short) / 2;
  const sy = (img.height - short) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = 224;
  canvas.height = 224;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, short, short, 0, 0, 224, 224);
  const data = ctx.getImageData(0, 0, 224, 224).data;
  const input = new Float32Array(3 * 224 * 224);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < 224 * 224; i++) {
      input[c * 224 * 224 + i] = (data[i * 4 + c] / 255 - mean[c]) / std[c];
    }
  }
  return new window.ort.Tensor("float32", input, [1, 3, 224, 224]);
}

async function rejectNonMineral() {
  if (!state.currentImage) return false;
  try {
    const session = await getGateSession();
    const tensor = await imageToImageNetTensor(state.currentImage);
    const output = await session.run({ input: tensor });
    const logits = output.logits.data;
    const exp = logits.map((x) => Math.exp(x));
    const sum = exp.reduce((a, b) => a + b, 0);
    const probs = exp.map((x) => x / sum);
    let top = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[top]) top = i;
    const isBlocked = window.IMAGENET_BLOCKED?.[top] && probs[top] >= 0.18;
    return isBlocked ? { index: top, label: window.IMAGENET_CLASSES[top], confidence: probs[top] } : false;
  } catch (_) {
    return false;
  }
}

async function imageSkinRatio(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const short = Math.min(img.width, img.height);
  const sx = (img.width - short) / 2;
  const sy = (img.height - short) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, short, short, 0, 0, 96, 96);
  const data = ctx.getImageData(0, 0, 96, 96).data;
  let skin = 0;
  const total = 96 * 96;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (
      r > 95 && g > 40 && b > 20 &&
      r > g && r > b &&
      r - Math.min(g, b) > 15 &&
      Math.abs(r - g) > 15
    ) {
      skin++;
    }
  }
  return skin / total;
}

async function imageToTensor(src, flipH = false, flipV = false) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const short = Math.min(img.width, img.height);
  const sx = (img.width - short) / 2;
  const sy = (img.height - short) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = 224;
  canvas.height = 224;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, short, short, 0, 0, 224, 224);
  const data = ctx.getImageData(0, 0, 224, 224).data;
  const input = new Float32Array(3 * 224 * 224);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < 224; y++) {
      for (let x = 0; x < 224; x++) {
        const sx = flipH ? 223 - x : x;
        const sy = flipV ? 223 - y : y;
        const idx = (sy * 224 + sx) * 4 + c;
        input[c * 224 * 224 + y * 224 + x] = (data[idx] / 255 - mean[c]) / std[c];
      }
    }
  }
  return new window.ort.Tensor("float32", input, [1, 3, 224, 224]);
}

async function predictOnnx() {
  if (!state.currentImage) throw new Error("请先拍照或选择图片");
  await waitFor(() => !!window.MINERAL_CLASSES && !!window.MINERAL_KB);
  if ((await imageSkinRatio(state.currentImage)) > 0.32) {
    throw new Error("这不是矿物，请您放入清晰的矿物照片。");
  }
  if (await rejectNonMineral()) {
    throw new Error("这不是矿物，请您放入清晰的矿物照片。");
  }
  const sessions = await getOnnxSessions();
  const tensor = await imageToTensor(state.currentImage);
  const classCount = Object.keys(window.MINERAL_CLASSES || {}).length;
  const summed = new Array(classCount).fill(0);
  for (const session of sessions) {
    const output = await session.run({ input: tensor });
    const logits = output.logits.data;
    for (let i = 0; i < classCount; i++) summed[i] += logits[i];
  }
  const probs = summed.map((x) => x / sessions.length);
  const classes = Object.keys(window.MINERAL_CLASSES || {});
  const description = ($("#description").value || "").trim().toLowerCase();
  if (description) {
    for (let i = 0; i < classes.length; i++) {
      const key = classes[i];
      const info = window.MINERAL_CLASSES?.[key] || {};
      const kb = window.MINERAL_KB?.[key] || {};
      const names = [info.zh, kb.name_zh, kb.name_en, key, info.formula, kb.formula].filter(Boolean).map((s) => String(s).toLowerCase());
      if (names.some((name) => name && description.includes(name))) {
        probs[i] += 2.5;
      }
    }
  }
  const maxLogit = Math.max(...probs);
  const shifted = probs.map((x) => x - maxLogit);
  const exp = shifted.map((x) => Math.exp(x));
  const sum = exp.reduce((a, b) => a + b, 0);
  const softmax = exp.map((x) => x / sum);
  if (softmax.reduce((a, b) => Math.max(a, b), 0) < 0.18) {
    throw new Error("这不是矿物，请您放入清晰的矿物照片。");
  }
  const order = softmax.map((v, i) => i).sort((a, b) => softmax[b] - softmax[a]).slice(0, 5);
  const rankings = order.map((idx, rank) => ({
    key: classes[idx],
    name_zh: window.MINERAL_CLASSES[classes[idx]].zh,
    confidence: softmax[idx],
    rank: rank + 1,
  }));
  const top = rankings[0];
  const kb = window.MINERAL_KB?.[top.key] || {};
  return {
    name_zh: kb.name_zh || top.name_zh,
    name_en: kb.name_en || classes[top.key],
    formula: kb.formula || window.MINERAL_CLASSES[top.key].formula || "",
    confidence: top.confidence,
    threshold: 0.2,
    accepted: top.confidence >= 0.2,
    knowledge: kb,
    rankings,
  };
}

async function assistOnline(result) {
  const prompt = `用户上传了一张矿物照片，本地识别结果：${result.name_zh}（${result.name_en}，${result.formula || "未知化学式"}），置信度 ${Math.round(result.confidence * 100)}%。请补充该矿物的产地、形成原因和工业用途，并说明识别时最可靠的鉴别特征。`;
  try {
    const res = await fetch("/api/deepseek", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || data.detail || "";
    document.getElementById("tab-use").innerHTML += `<div class="kv"><dt>AI 辅助</dt><dd>${text}</dd></div>`;
  } catch (_) {
    // offline fallback
  }
}

document.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
cameraBtn.addEventListener("click", () => {
  if (state.mode !== "photo") setMode("photo");
  void startCamera().then(capturePhoto);
});
recordBtn.addEventListener("click", () => {
  if (state.mode !== "video") setMode("video");
  toggleRecording();
});
galleryBtn.addEventListener("click", () => {
  if (state.mode !== "file") setMode("file");
  fileInput.click();
});
clearBtn.addEventListener("click", clearAll);
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  if (file.type.startsWith("video/")) showPreviewFromVideo(url);
  else showPreviewFromImage(url);
  setStatus("媒体已就绪");
});
predictBtn.addEventListener("click", predict);
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.id !== `tab-${t.dataset.tab}`));
  })
);
document.querySelectorAll(".mode-chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    state.onlineMode = chip.dataset.netmode === "online";
    document.querySelectorAll(".mode-chip").forEach((c) => c.classList.toggle("active", c === chip));
    setStatus(state.onlineMode ? "联网模式" : "离线模式");
  })
);

window.addEventListener("load", () => {
  if (window.lucide) lucide.createIcons();
  initAmbient();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
  }
  setMode("photo");
  setTimeout(() => {
    getOnnxSessions().catch(() => {});
    getGateSession().catch(() => {});
  }, 1700);
  setTimeout(() => {
    setSplash("识别服务已就绪");
    setStatus("就绪");
    dismissSplash();
  }, 1600);
});
