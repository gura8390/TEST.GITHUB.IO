/* Camera lifecycle and UI for the shared, bounded transfer collector. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id),
    T = QRTransfer,
    collector = new T.Collector();
  let video,
    track = null,
    worker = null,
    pendingDecode = null,
    decodeId = 0,
    cameraEpoch = 0,
    scanTimer = null;
  let videoCallback = null,
    scanBusy = false,
    lastVideoTime = -1,
    knownVersion = 0,
    progressAt = 0;
  let scanning = false,
    starting = false,
    assembling = false,
    result = null,
    devices = [],
    deviceIndex = -1;
  let scanSize,
    processCanvas,
    processCtx,
    roi = null,
    misses = 0,
    detector = null;
  let torch = false,
    sound = false,
    audio = null,
    toastTimer = null,
    gridKey = "",
    busyTorch = false;
  function status(text) {
    if ($("statusText").textContent !== text)
      $("statusText").textContent = text;
  }
  function toast(text) {
    clearTimeout(toastTimer);
    $("toast").textContent = text;
    $("toast").classList.add("show");
    toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3000);
  }
  function controls() {
    $("btnCamera").disabled = starting || assembling;
    $("btnCamera").textContent = starting
      ? "正在打开…"
      : scanning
        ? "暂停扫描"
        : collector.meta
          ? "继续扫描"
          : "开始扫描";
    $("btnSwitchCam").disabled = !scanning || devices.length < 2;
    $("btnRetry").disabled = starting || assembling;
  }
  function progress(force = false) {
    const now = performance.now();
    if (!force && now - progressAt < 100) return;
    progressAt = now;
    const m = collector.meta,
      count = collector.data.size,
      k = m ? m.k : 0,
      elapsed = collector.started ? (Date.now() - collector.started) / 1000 : 0;
    const rate = elapsed > 0 && m ? (count * m.chunkBytes) / 1024 / elapsed : 0;
    $("progressFill").style.width = (k ? (count / k) * 100 : 0) + "%";
    $("progressBar").setAttribute(
      "aria-valuenow",
      k ? Math.round((count / k) * 100) : 0,
    );
    $("progressText").textContent =
      count +
      " / " +
      k +
      (rate > 0 ? " · " + rate.toFixed(1) + " KB/s" : "") +
      (k > count && rate > 0
        ? " · 约剩 " +
          Math.ceil(((k - count) * m.chunkBytes) / 1024 / rate) +
          " 秒"
        : "");
    const missing = collector.missing();
    $("missingText").textContent = missing.length
      ? "缺少数据帧：" + missing.join(", ")
      : m
        ? "数据帧已收齐"
        : "接收到首帧后显示进度";
    $("badFrames").textContent = collector.bad
      ? "已拒收异常帧：" + collector.bad
      : "";
    const key = m ? collector.key : "";
    if (gridKey !== key) {
      gridKey = key;
      $("chunkGrid").replaceChildren();
      if (m)
        for (let i = 1; i <= m.totalParts; i++) {
          const cell = document.createElement("span");
          cell.className = "chunk-tag" + (i > k ? " parity" : "");
          cell.textContent = i > k ? "P" + (i - k) : i;
          cell.dataset.part = i;
          $("chunkGrid").appendChild(cell);
        }
    }
    for (const cell of $("chunkGrid").children) {
      const i = Number(cell.dataset.part),
        received = collector.data.has(i) || collector.parity.has(i);
      const visual = (received ? 1 : 0) + (collector.recovered.has(i) ? 2 : 0);
      if (cell.dataset.state === String(visual)) continue;
      cell.dataset.state = String(visual);
      cell.classList.toggle("collected", received);
      cell.classList.toggle("recovered", collector.recovered.has(i));
      cell.title =
        (i <= k ? "数据帧 " + i : "校验帧 " + (i - k)) +
        (collector.recovered.has(i)
          ? " · 已恢复"
          : received
            ? " · 已接收"
            : " · 未接收");
    }
  }
  function beep() {
    if (!sound || !audio) return;
    try {
      const oscillator = audio.createOscillator(),
        gain = audio.createGain();
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.frequency.value = 880;
      gain.gain.value = 0.03;
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.04);
    } catch (error) {}
  }
  function hideResults() {
    result = null;
    $("resultSection").hidden = true;
    $("fileResultSection").hidden = true;
    $("resultText").value = "";
    $("fileName").textContent = "";
  }
  function stopCamera() {
    ++cameraEpoch;
    scanning = false;
    starting = false;
    clearTimeout(scanTimer);
    if (videoCallback !== null && video?.cancelVideoFrameCallback)
      video.cancelVideoFrameCallback(videoCallback);
    videoCallback = null;
    scanBusy = false;
    lastVideoTime = -1;
    knownVersion = 0;
    scanTimer = null;
    if (pendingDecode) {
      pendingDecode(null);
      pendingDecode = null;
    }
    if (worker) {
      worker.terminate();
      worker = null;
    }
    if (video && video.srcObject) {
      video.srcObject.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    track = null;
    torch = false;
    roi = null;
    misses = 0;
    detector = null;
    $("btnTorch").hidden = true;
    $("btnTorch").textContent = "手电筒";
    controls();
  }
  async function complete() {
    if (assembling || !collector.meta || collector.missing().length) return;
    assembling = true;
    stopCamera();
    const epoch = cameraEpoch;
    status("正在校验并还原内容…");
    controls();
    try {
      const value = await collector.finish();
      if (epoch !== cameraEpoch) return;
      result = value;
      const elapsed = Math.max(0.001, (Date.now() - collector.started) / 1000);
      status(
        "校验完成 · " +
          collector.data.size +
          " 帧 · " +
          elapsed.toFixed(1) +
          " 秒" +
          (collector.recovered.size
            ? " · 恢复 " + collector.recovered.size + " 帧"
            : ""),
      );
      if (value.isFile) {
        $("fileName").textContent = value.name;
        $("fileSize").textContent = T.formatSize(value.bytes.length);
        $("fileResultSection").hidden = false;
      } else {
        $("resultText").value = value.text;
        $("charResult").textContent = value.text.length.toLocaleString();
        $("byteResult").textContent = T.formatSize(value.bytes.length);
        $("resultSection").hidden = false;
      }
      $("btnCamera").hidden = true;
      document.querySelector(".camera-wrap").hidden = true;
      progress(true);
    } catch (error) {
      if (epoch === cameraEpoch) {
        status("接收失败：" + error.message + "。请点击重新扫描。");
        hideResults();
        $("btnCamera").hidden = true;
      }
    } finally {
      if (epoch === cameraEpoch) {
        assembling = false;
        controls();
      }
    }
  }
  function accept(bytes) {
    const before = collector.data.size,
      outcome = collector.accept(bytes);
    if (outcome.changed) {
      gridKey = "";
      progressAt = 0;
      hideResults();
      toast("检测到新的传输内容，已重新收集");
    }
    if (outcome.accepted && !outcome.duplicate) {
      status("接收中，请保持二维码与白边完整可见");
      if (collector.data.size > before) beep();
    }
    progress();
    if (outcome.complete) complete();
    return outcome.accepted;
  }
  function bounds(rect) {
    const x = Math.max(0, Math.min(Math.floor(rect.x), scanSize.width - 16)),
      y = Math.max(0, Math.min(Math.floor(rect.y), scanSize.height - 16));
    return {
      x,
      y,
      w: Math.max(16, Math.min(Math.ceil(rect.w), scanSize.width - x)),
      h: Math.max(16, Math.min(Math.ceil(rect.h), scanSize.height - y)),
    };
  }
  function around(points, expand = 1.4) {
    const xs = points.map((p) => p.x),
      ys = points.map((p) => p.y),
      x = Math.min(...xs),
      y = Math.min(...ys),
      w = Math.max(...xs) - x,
      h = Math.max(...ys) - y;
    return bounds({
      x: x - (w * (expand - 1)) / 2,
      y: y - (h * (expand - 1)) / 2,
      w: w * expand,
      h: h * expand,
    });
  }
  function makeWorker() {
    try {
      worker = new Worker("decoder.worker.js");
      worker.onmessage = (e) => {
        if (e.data.id === decodeId && pendingDecode) {
          const resolve = pendingDecode;
          pendingDecode = null;
          resolve(e.data);
        }
      };
      worker.onerror = () => {
        if (worker) worker.terminate();
        worker = null;
        if (pendingDecode) {
          const resolve = pendingDecode;
          pendingDecode = null;
          resolve(null);
        }
      };
    } catch (error) {
      worker = null;
    }
  }
  function decode(image) {
    if (!worker) {
      try {
        const value = jsQR(image.data, image.width, image.height, {
          inversionAttempts: misses > 25 ? "attemptBoth" : "dontInvert",
        });
        return Promise.resolve(
          value
            ? {
                found: true,
                bytes: value.binaryData,
                location: value.location,
                version: value.version,
              }
            : null,
        );
      } catch (error) {
        return Promise.resolve(null);
      }
    }
    return new Promise((resolve) => {
      let timer;
      pendingDecode = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      const currentWorker = worker;
      timer = setTimeout(() => {
        if (worker === currentWorker) {
          worker.terminate();
          worker = null;
        }
        if (pendingDecode) {
          const done = pendingDecode;
          pendingDecode = null;
          done(null);
        }
      }, 5000);
      try {
        worker.postMessage(
          {
            id: ++decodeId,
            pixels: image.data.buffer,
            width: image.width,
            height: image.height,
            invMode: misses > 25 ? "attemptBoth" : "dontInvert",
          },
          [image.data.buffer],
        );
      } catch (error) {
        clearTimeout(timer);
        currentWorker.terminate();
        worker = null;
        pendingDecode = null;
        resolve(null);
      }
    });
  }
  async function scan(epoch) {
    if (epoch !== cameraEpoch || !scanning) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        if (
          scanSize.width !== video.videoWidth ||
          scanSize.height !== video.videoHeight
        ) {
          scanSize.width = video.videoWidth;
          scanSize.height = video.videoHeight;
          roi = null;
        }
        let crop = roi;
        if (!crop && detector) {
          try {
            const codes = await detector.detect(video);
            if (epoch !== cameraEpoch || !scanning) return;
            if (codes[0] && codes[0].cornerPoints)
              crop = around(codes[0].cornerPoints);
          } catch (error) {
            if (epoch !== cameraEpoch) return;
            detector = null;
          }
        }
        if (!crop) {
          const ratio = misses < 10 ? 0.8 : 1;
          crop = bounds({
            x: (scanSize.width * (1 - ratio)) / 2,
            y: (scanSize.height * (1 - ratio)) / 2,
            w: scanSize.width * ratio,
            h: scanSize.height * ratio,
          });
        }
        crop = bounds(crop);
        const scale = Math.min(
          1,
          (misses >= 12
            ? 1280
            : knownVersion
              ? Math.ceil((17 + knownVersion * 4) * 1.4 * 5) *
                (misses >= 3 ? 1.4 : 1)
              : 960) / Math.max(crop.w, crop.h),
        );
        const width = Math.max(16, Math.round((crop.w * scale) / 16) * 16),
          height = Math.max(16, Math.round((crop.h * scale) / 16) * 16);
        if (processCanvas.width !== width) processCanvas.width = width;
        if (processCanvas.height !== height) processCanvas.height = height;
        processCtx.drawImage(
          video,
          crop.x,
          crop.y,
          crop.w,
          crop.h,
          0,
          0,
          processCanvas.width,
          processCanvas.height,
        );
        const decoded = await decode(
          processCtx.getImageData(
            0,
            0,
            processCanvas.width,
            processCanvas.height,
          ),
        );
        if (epoch !== cameraEpoch || !scanning) return;
        if (decoded && decoded.found && accept(new Uint8Array(decoded.bytes))) {
          misses = 0;
          if (
            Number.isInteger(decoded.version) &&
            decoded.version >= 1 &&
            decoded.version <= 40
          )
            knownVersion = decoded.version;
          const loc = decoded.location;
          if (loc) {
            roi = around(
              [
                loc.topLeftCorner,
                loc.topRightCorner,
                loc.bottomLeftCorner,
                loc.bottomRightCorner,
              ].map((p) => ({
                x: crop.x + (p.x / processCanvas.width) * crop.w,
                y: crop.y + (p.y / processCanvas.height) * crop.h,
              })),
            );
          } else roi = crop;
        } else {
          misses++;
          if (misses % 3 === 0) roi = null;
        }
      }
    } catch (error) {
      if (epoch === cameraEpoch) {
        roi = null;
        misses++;
        status("画面暂不可读取，请保持页面在前台或重新扫描");
      }
    }
  }
  function scheduleScan(epoch) {
    if (epoch !== cameraEpoch || !scanning) return;
    if (typeof video.requestVideoFrameCallback === "function") {
      videoCallback = video.requestVideoFrameCallback(() => {
        if (epoch !== cameraEpoch || !scanning) return;
        videoCallback = null;
        scheduleScan(epoch);
        // One decode in flight: process the newest camera frame, never build a queue.
        if (!scanBusy) {
          scanBusy = true;
          scan(epoch).finally(() => {
            if (epoch === cameraEpoch) scanBusy = false;
          });
        }
      });
    } else {
      scanTimer = setTimeout(
        async () => {
          if (epoch !== cameraEpoch || !scanning) return;
          const stamp = video.currentTime;
          if (stamp !== lastVideoTime) {
            lastVideoTime = stamp;
            await scan(epoch);
          }
          scheduleScan(epoch);
        },
        collector.meta ? 4 : 40,
      );
    }
  }
  function cameraError(error) {
    const names = {
      NotAllowedError: "摄像头权限被拒绝。请在浏览器站点设置中允许后重试。",
      NotFoundError: "未找到摄像头，请连接或启用摄像头后重试。",
      NotReadableError: "摄像头被其他程序占用或不可读取，请释放后重试。",
    };
    status(names[error.name] || "摄像头无法启动：" + error.message);
  }
  async function startCamera() {
    if (starting || assembling) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status(
        !window.isSecureContext
          ? "当前地址无法使用摄像头。请通过 HTTPS 或设备本机 localhost 打开接收页。"
          : "当前浏览器不支持摄像头，请更换支持的浏览器。",
      );
      return;
    }
    stopCamera();
    document.querySelector(".camera-wrap").hidden = false;
    const epoch = cameraEpoch;
    starting = true;
    controls();
    status("正在请求摄像头权限…");
    const desired = devices[deviceIndex],
      constraints = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
        ...(desired
          ? { deviceId: { exact: desired.deviceId } }
          : { facingMode: { ideal: "environment" } }),
      };
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: constraints,
          audio: false,
        });
      } catch (error) {
        if (epoch !== cameraEpoch) return;
        if (
          error.name !== "OverconstrainedError" &&
          error.name !== "NotFoundError"
        )
          throw error;
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }
      if (epoch !== cameraEpoch) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      track = stream.getVideoTracks()[0];
      await video.play();
      if (epoch !== cameraEpoch) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      $("btnTorch").hidden = !caps.torch;
      if (caps.focusMode && caps.focusMode.includes("continuous"))
        track
          .applyConstraints({ advanced: [{ focusMode: "continuous" }] })
          .catch(() => {});
      if (navigator.mediaDevices.enumerateDevices)
        try {
          const list = await navigator.mediaDevices.enumerateDevices();
          if (epoch !== cameraEpoch) return;
          devices = list.filter((d) => d.kind === "videoinput");
          const actual = track.getSettings().deviceId;
          deviceIndex = devices.findIndex((d) => d.deviceId === actual);
        } catch (error) {}
      const settings = track.getSettings ? track.getSettings() : {};
      $("cameraInfo").textContent =
        (settings.width || video.videoWidth) +
        " × " +
        (settings.height || video.videoHeight) +
        (settings.frameRate
          ? " · 相机 " + Math.round(settings.frameRate) + " FPS"
          : "");
      scanSize = { width: 0, height: 0 };
      processCanvas = document.createElement("canvas");
      processCtx = processCanvas.getContext("2d", { willReadFrequently: true });
      makeWorker();
      if ("BarcodeDetector" in window)
        try {
          detector = new BarcodeDetector({ formats: ["qr_code"] });
        } catch (error) {
          detector = null;
        }
      track.onended = () => {
        if (epoch === cameraEpoch) {
          stopCamera();
          status("摄像头已断开，已保留接收进度");
        }
      };
      scanning = true;
      starting = false;
      controls();
      status("扫描中，请对准二维码");
      scheduleScan(epoch);
    } catch (error) {
      if (epoch === cameraEpoch) {
        stopCamera();
        cameraError(error);
      }
    }
  }
  function reset() {
    stopCamera();
    assembling = false;
    collector.reset();
    gridKey = "";
    $("chunkGrid").replaceChildren();
    hideResults();
    $("btnCamera").hidden = false;
    progress(true);
    startCamera();
  }
  function save(bytes, name) {
    const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/octet-stream" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") || "received.bin";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function copy() {
    if (!result || result.isFile) return;
    try {
      await navigator.clipboard.writeText(result.text);
      toast("已复制全文");
    } catch (error) {
      $("resultText").select();
      toast("复制未获授权，请长按选中文本复制");
    }
  }
  document.addEventListener("DOMContentLoaded", () => {
    video = $("video");
    $("btnCamera").onclick = () => {
      if (scanning) {
        stopCamera();
        status("已暂停，接收进度保留");
      } else startCamera();
    };
    $("btnRetry").onclick = reset;
    $("btnReset").onclick = reset;
    $("btnReset2").onclick = reset;
    $("btnCopy").onclick = copy;
    $("btnSaveText").onclick = () => {
      if (result && !result.isFile) save(result.bytes, "接收文本.txt");
    };
    $("btnDownload").onclick = () => {
      if (result && result.isFile) save(result.bytes, result.name);
    };
    $("btnSound").onclick = async () => {
      sound = !sound;
      $("btnSound").textContent = sound ? "提示音：开" : "提示音：关";
      $("btnSound").setAttribute("aria-pressed", sound);
      if (sound)
        try {
          if (!audio)
            audio = new (window.AudioContext || window.webkitAudioContext)();
          await audio.resume();
          beep();
        } catch (error) {
          sound = false;
          $("btnSound").textContent = "提示音不可用";
        }
    };
    $("btnTorch").onclick = async () => {
      if (!track || busyTorch) return;
      busyTorch = true;
      const epoch = cameraEpoch;
      try {
        await track.applyConstraints({ advanced: [{ torch: !torch }] });
        if (epoch === cameraEpoch) {
          torch = !torch;
          $("btnTorch").textContent = torch ? "关闭手电筒" : "手电筒";
        }
      } catch (error) {
        toast("当前镜头无法切换手电筒");
      } finally {
        busyTorch = false;
      }
    };
    $("btnSwitchCam").onclick = () => {
      if (devices.length > 1) {
        deviceIndex = (deviceIndex + 1) % devices.length;
        startCamera();
      }
    };
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && (scanning || starting)) {
        stopCamera();
        status("页面进入后台，摄像头已关闭；可继续扫描");
      }
    });
    window.addEventListener("pagehide", stopCamera);
    setInterval(() => {
      if (scanning) {
        progress();
        if (collector.updated && Date.now() - collector.updated > 3000)
          status("等待缺帧，可在电脑上使用“只播缺帧”补发");
      }
    }, 1000);
    if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol))
      navigator.serviceWorker
        .register("./sw.js")
        .then(() => {
          $("offlineStatus").textContent = "离线资源准备中…";
          return navigator.serviceWorker.ready;
        })
        .then(() => {
          $("offlineStatus").textContent = "接收页已可离线使用";
        })
        .catch(() => {
          $("offlineStatus").textContent = "离线缓存不可用，请保持资源可访问";
        });
    progress(true);
    controls();
    status("点击开始扫描，允许摄像头后对准电脑屏幕");
  });
})();
