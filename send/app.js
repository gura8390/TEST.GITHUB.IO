/* QR 2.7 sender: cancellable preparation and compact QR matrices. */
"use strict";
const $ = (id) => document.getElementById(id),
  T = QRTransfer;
let prepared = null,
  selectedFile = null,
  prepareWorker = null,
  prepareRevision = 0,
  prepareTimer = null;
let generation = 0,
  generating = false,
  transfer = null,
  matrices = [],
  frameIndex = 0,
  playing = false,
  raf = 0,
  lastTick = 0,
  missingFilter = null,
  toastTimer = null;
qrcode.stringToBytes = qrcode.stringToBytesFuncs.default;
// Yield a browser task without the nested setTimeout minimum delay per QR.
const generationYields = [],
  generationChannel = new MessageChannel();
generationChannel.port1.onmessage = () => generationYields.shift()?.();
function yieldGeneration() {
  return new Promise((resolve) => {
    generationYields.push(resolve);
    generationChannel.port2.postMessage(null);
  });
}
let rasterCanvas = null,
  rasterImage = null;
const blackPixel =
  new Uint8Array(new Uint32Array([0xff000000]).buffer)[3] === 255
    ? 0xff000000
    : 0x000000ff;
function notify(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("show");
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 4000);
}
function status(message) {
  $("statusText").textContent = message;
}
function options() {
  return {
    version: $("versionSelect").value,
    ecc: $("eccSelect").value,
    protocol: $("protoSelect").value,
    parity: $("parityCheck").checked,
  };
}
function setGenerating(value) {
  generating = value;
  document
    .querySelectorAll("[data-lock]")
    .forEach((el) => (el.disabled = value));
  $("inputText").disabled = value || !!selectedFile;
  $("btnCancel").hidden = !value;
  $("progressContainer").hidden = !value;
  $("btnGenerate").textContent = value ? "生成中…" : "开始发送";
  updateStats();
}
function updateStats() {
  $("parityCheck").disabled = generating || $("protoSelect").value === "v3";
  $("btnGenerate").disabled = true;
  if (!prepared) {
    $("compressedSize").textContent = "—";
    $("versionDisplay").textContent = "—";
    $("codeCount").textContent = "—";
    return;
  }
  $("byteCount").textContent = T.formatSize(prepared.dataLen);
  $("charCount").textContent = prepared.isFile
    ? "文件"
    : prepared.legacyLength.toLocaleString();
  $("compressedSize").textContent = T.formatSize(prepared.compressed.length);
  try {
    const spec = T.plan(prepared.compressed.length + 32, options());
    $("versionDisplay").textContent = "V" + spec.version + " / " + spec.ecc;
    $("codeCount").textContent = spec.k + " + " + spec.p + " 校验帧";
    $("inputStatus").textContent =
      "预计每轮 " +
      (spec.total / Number($("fpsSelect").value)).toFixed(1) +
      " 秒。传输完成以手机校验结果为准。";
    $("btnGenerate").disabled = generating;
  } catch (error) {
    $("codeCount").textContent = "超出容量";
    $("inputStatus").textContent = error.message;
  }
}
function cancelPreparation() {
  ++prepareRevision;
  clearTimeout(prepareTimer);
  if (prepareWorker) prepareWorker.terminate();
  prepareWorker = null;
}
function requestPreparation() {
  cancelPreparation();
  prepared = null;
  updateStats();
  const revision = prepareRevision,
    file = selectedFile,
    text = $("inputText").value;
  $("byteCount").textContent = file
    ? T.formatSize(file.size)
    : T.formatSize(new TextEncoder().encode(text).length);
  $("charCount").textContent = file ? "文件" : text.length.toLocaleString();
  if (!file && !text.length) {
    $("inputStatus").textContent = "粘贴文本或选择一个文件，内容仅在本机处理。";
    return;
  }
  if (file && file.size > T.MAX_INPUT) {
    $("inputStatus").textContent = "文件不能超过 16 MB";
    return;
  }
  $("inputStatus").textContent = "正在准备并计算实际压缩大小…";
  prepareTimer = setTimeout(async () => {
    function receive(result) {
      if (revision !== prepareRevision) return;
      prepared = result;
      updateStats();
    }
    function fail(error) {
      if (revision === prepareRevision) {
        prepared = null;
        $("inputStatus").textContent = error.message || String(error);
        updateStats();
      }
    }
    async function fallback() {
      try {
        const raw = file
          ? T.encodeFile(file.name, new Uint8Array(await file.arrayBuffer()))
          : T.encodeText(text);
        if (revision === prepareRevision) receive(T.prepare(raw));
      } catch (error) {
        fail(error);
      }
    }
    try {
      const w = new Worker("prepare.worker.js");
      prepareWorker = w;
      w.onmessage = (event) => {
        w.terminate();
        if (prepareWorker === w) prepareWorker = null;
        event.data.error
          ? fail(new Error(event.data.error))
          : receive(event.data.result);
      };
      w.onerror = () => {
        w.terminate();
        if (prepareWorker === w) prepareWorker = null;
        if (revision === prepareRevision) fallback();
      };
      w.postMessage({ file, text });
    } catch (error) {
      fallback();
    }
  }, 180);
}
function selectFile(file) {
  if (generating) return;
  selectedFile = file;
  $("inputText").disabled = !!file;
  $("fileInfo").textContent = file
    ? file.name + " · " + T.formatSize(file.size)
    : "";
  $("btnClearFile").hidden = !file;
  requestPreparation();
}
function stopPlayback(clear = false) {
  playing = false;
  cancelAnimationFrame(raf);
  raf = 0;
  lastTick = 0;
  $("btnPause").textContent = "继续";
  if (clear) {
    transfer = null;
    matrices = [];
    frameIndex = 0;
    missingFilter = null;
    $("displayCanvas").hidden = true;
    $("emptyState").hidden = false;
  }
  [
    "btnPause",
    "btnStop",
    "btnPrev",
    "btnNext",
    "btnRepair",
    "btnFullscreen",
  ].forEach((id) => ($(id).disabled = !transfer));
}
function matrixFor(qr) {
  const size = qr.getModuleCount(),
    data = new Uint8Array(size * size);
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) data[r * size + c] = qr.isDark(r, c) ? 1 : 0;
  return { size, data };
}
function playbackOrder() {
  return missingFilter || transfer.order;
}
function showFrame() {
  if (!transfer) return;
  const index = playbackOrder()[frameIndex],
    matrix = matrices[index],
    canvas = $("displayCanvas"),
    modules = matrix.size + 8;
  const available = Math.max(
    modules,
    Math.min(
      $("displayCanvasWrap").clientWidth - 16,
      document.fullscreenElement ? innerHeight - 190 : 680,
    ),
  );
  const scale = Math.max(
    1,
    Math.min(
      document.fullscreenElement ? 20 : Number($("sizeSelect").value),
      Math.floor(available / modules),
    ),
  );
  // Build a module-resolution bitmap, then perform one nearest-neighbor blit.
  // Keep two canvases and one ImageData, regardless of the number of frames.
  if (!rasterCanvas) rasterCanvas = document.createElement("canvas");
  if (rasterCanvas.width !== modules || !rasterImage) {
    rasterCanvas.width = rasterCanvas.height = modules;
    rasterImage = rasterCanvas
      .getContext("2d")
      .createImageData(modules, modules);
  }
  const pixels = new Uint32Array(rasterImage.data.buffer);
  pixels.fill(0xffffffff);
  for (let row = 0; row < matrix.size; row++)
    for (let col = 0; col < matrix.size; col++)
      if (matrix.data[row * matrix.size + col])
        pixels[(row + 4) * modules + col + 4] = blackPixel;
  rasterCanvas.getContext("2d").putImageData(rasterImage, 0, 0);
  const side = modules * scale;
  if (canvas.width !== side || canvas.height !== side)
    canvas.width = canvas.height = side;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(rasterCanvas, 0, 0, side, side);
  canvas.hidden = false;
  $("emptyState").hidden = true;
  const label =
    index < transfer.spec.k
      ? "数据 " + (index + 1)
      : "校验 P" + (index - transfer.spec.k + 1);
  $("frameIndicator").textContent =
    label + " · " + (frameIndex + 1) + " / " + playbackOrder().length;
}
function play() {
  if (!transfer || playing) return;
  playing = true;
  lastTick = 0;
  $("btnPause").textContent = "暂停";
  status(missingFilter ? "补帧轮播中" : "轮播中");
  showFrame();
  function tick(time) {
    if (!playing) return;
    const step = 1000 / Number($("fpsSelect").value);
    if (!lastTick) lastTick = time;
    if (time - lastTick >= step) {
      lastTick = time - ((time - lastTick) % step);
      frameIndex = (frameIndex + 1) % playbackOrder().length;
      showFrame();
    }
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);
}
async function generate() {
  if (generating || !prepared) return;
  const revision = ++generation,
    snapshot = prepared,
    settings = options();
  stopPlayback(true);
  setGenerating(true);
  status("正在生成二维码…");
  $("progressFill").style.width = "0%";
  try {
    const built = await T.build(snapshot, settings),
      pending = [];
    for (let i = 0; i < built.frames.length; i++) {
      if (revision !== generation) return;
      const qr = qrcode(built.spec.version, built.spec.ecc);
      let binary = "";
      for (const byte of built.frames[i]) binary += String.fromCharCode(byte);
      qr.addData(binary, "Byte");
      qr.make();
      pending.push(matrixFor(qr));
      $("progressFill").style.width =
        Math.round(((i + 1) / built.frames.length) * 100) + "%";
      $("btnGenerate").textContent =
        "生成 " + (i + 1) + " / " + built.frames.length;
      await yieldGeneration();
    }
    if (revision !== generation) return;
    transfer = built;
    matrices = pending;
    frameIndex = 0;
    $("repairInput").value = "";
    $("btnRepair").textContent = "只播缺帧";
    stopPlayback();
    play();
  } catch (error) {
    if (revision === generation) {
      stopPlayback(true);
      status("生成失败：" + error.message);
      notify(error.message);
    }
  } finally {
    if (revision === generation) setGenerating(false);
  }
}
function cancelGeneration() {
  ++generation;
  stopPlayback(true);
  setGenerating(false);
  status("已取消生成，可调整内容后重试");
}
function repair() {
  if (!transfer) return;
  if (missingFilter) {
    stopPlayback();
    missingFilter = null;
    frameIndex = 0;
    $("btnRepair").textContent = "只播缺帧";
    play();
    return;
  }
  const input = $("repairInput").value.trim();
  if (!/^\d+(?:[\s,，/]+\d+)*$/.test(input)) {
    notify("请输入手机提示的帧号，例如 3, 8, 12");
    return;
  }
  const ids = [...new Set(input.split(/[\s,，/]+/).map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n < 1 || n > transfer.spec.k)) {
    notify("数据帧号范围为 1～" + transfer.spec.k);
    return;
  }
  stopPlayback();
  missingFilter = ids.map((n) => n - 1);
  frameIndex = 0;
  $("btnRepair").textContent = "恢复全部帧";
  play();
}
const settingIds = [
  "versionSelect",
  "eccSelect",
  "protoSelect",
  "fpsSelect",
  "sizeSelect",
];
document.addEventListener("DOMContentLoaded", () => {
  try {
    settingIds.forEach((id) => {
      const value = localStorage.getItem("qr27." + id);
      if ([...$(id).options].some((o) => o.value === value))
        $(id).value = value;
    });
    $("parityCheck").checked = localStorage.getItem("qr27.parity") !== "0";
  } catch (error) {}
  settingIds.concat("parityCheck").forEach((id) =>
    $(id).addEventListener("change", () => {
      try {
        settingIds.forEach((key) =>
          localStorage.setItem("qr27." + key, $(key).value),
        );
        localStorage.setItem(
          "qr27.parity",
          $("parityCheck").checked ? "1" : "0",
        );
      } catch (error) {}
      updateStats();
      if (id === "sizeSelect") showFrame();
    }),
  );
  $("inputText").addEventListener("input", requestPreparation);
  $("fileInput").addEventListener("change", (e) =>
    selectFile(e.target.files[0] || null),
  );
  $("btnChooseFile").onclick = () => $("fileInput").click();
  $("btnClearFile").onclick = () => {
    $("fileInput").value = "";
    selectFile(null);
  };
  $("inputPanel").addEventListener("dragover", (e) => e.preventDefault());
  $("inputPanel").addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
  });
  $("btnGenerate").onclick = generate;
  $("btnCancel").onclick = cancelGeneration;
  $("btnPause").onclick = () => {
    if (playing) {
      stopPlayback();
      status("已暂停，可继续或逐帧查看");
    } else play();
  };
  $("btnStop").onclick = () => {
    stopPlayback(true);
    status("已停止");
    $("frameIndicator").textContent = "等待开始";
  };
  [
    ["btnPrev", -1],
    ["btnNext", 1],
  ].forEach(
    ([id, step]) =>
      ($(id).onclick = () => {
        stopPlayback();
        frameIndex =
          (frameIndex + step + playbackOrder().length) % playbackOrder().length;
        showFrame();
        status("逐帧查看");
      }),
  );
  $("btnRepair").onclick = repair;
  $("btnFullscreen").onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $("displayArea").requestFullscreen();
    } catch (error) {
      notify("当前浏览器无法进入全屏");
    }
  };
  document.addEventListener("fullscreenchange", () => {
    $("btnFullscreen").textContent = document.fullscreenElement
      ? "退出全屏"
      : "全屏";
    showFrame();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && playing) {
      stopPlayback();
      status("页面进入后台，已暂停；回来后点击继续");
    }
  });
  window.addEventListener("resize", showFrame);
  window.addEventListener("pagehide", () => {
    cancelPreparation();
    ++generation;
    stopPlayback();
  });
  requestPreparation();
});
