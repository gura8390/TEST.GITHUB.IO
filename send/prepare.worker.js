importScripts(
  "pako.min.js",
  "./protocol.js",
  "./capacity.js",
  "./transfer.js",
);
self.onmessage = async function (event) {
  try {
    const { file, text } = event.data;
    const raw = file
      ? QRTransfer.encodeFile(
          file.name,
          new Uint8Array(await file.arrayBuffer()),
        )
      : QRTransfer.encodeText(text);
    const result = QRTransfer.prepare(raw);
    self.postMessage({ result }, [result.compressed.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
