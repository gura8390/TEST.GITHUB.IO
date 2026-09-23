// 动态流式二维码 v2.5 — jsQR 解码 Worker
// 主线程传入裁剪后的 ImageData 像素（Transferable），返回解码字节与定位点
importScripts("jsQR.js");

self.onmessage = function (e) {
  var m = e.data;
  try {
    var result = jsQR(new Uint8ClampedArray(m.pixels), m.width, m.height, {
      inversionAttempts: m.invMode,
    });
    if (result && result.binaryData && result.binaryData.length > 0) {
      var bytes = new Uint8Array(result.binaryData);
      self.postMessage(
        {
          id: m.id,
          found: true,
          bytes: bytes,
          version: result.version,
          location: result.location || null,
        },
        [bytes.buffer],
      );
    } else {
      self.postMessage({ id: m.id, found: false });
    }
  } catch (err) {
    self.postMessage({ id: m.id, found: false });
  }
};
