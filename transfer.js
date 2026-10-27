// Local payload, planning and collection logic. No DOM, network or storage access.
(function (root, factory) {
  if (typeof module === "object" && module.exports)
    module.exports = factory(
      require("./protocol"),
      require("./capacity"),
      require("./pako.min"),
    );
  else root.QRTransfer = factory(root.QRProtocol, root.QRCapacity, root.pako);
})(typeof self !== "undefined" ? self : this, function (P, capacities, pako) {
  "use strict";
  const MAX_INPUT = 16 * 1024 * 1024,
    MAX_DATA_FRAMES = 200;
  const encoder = new TextEncoder();
  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }
  function formatSize(n) {
    return n < 1024
      ? n + " B"
      : n < 1048576
        ? (n / 1024).toFixed(1) + " KB"
        : (n / 1048576).toFixed(2) + " MB";
  }
  function encodeText(text) {
    assert(text.length > 0, "请先输入文本或选择文件");
    // No regexp lookbehind: older iPhone browsers must be able to parse this file.
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++i);
        assert(
          next >= 0xdc00 && next <= 0xdfff,
          "文本含有不完整的 Unicode 字符，请修正后发送",
        );
      } else {
        assert(
          code < 0xdc00 || code > 0xdfff,
          "文本含有不完整的 Unicode 字符，请修正后发送",
        );
      }
    }
    const bytes = encoder.encode(text);
    assert(bytes.length <= MAX_INPUT, "原始内容不能超过 16 MB");
    return { bytes, isFile: false, legacyLength: text.length };
  }
  function encodeFile(name, content) {
    const filename = encoder.encode(name);
    assert(
      filename.length > 0 && filename.length <= 255,
      "文件名不能超过 255 个 UTF-8 字节，请缩短名称后重试",
    );
    assert(content.length <= MAX_INPUT, "文件不能超过 16 MB");
    const bytes = new Uint8Array(1 + filename.length + content.length);
    bytes[0] = filename.length;
    bytes.set(filename, 1);
    bytes.set(content, 1 + filename.length);
    return { bytes, isFile: true, legacyLength: content.length };
  }
  function prepare(raw) {
    return {
      compressed: pako.gzip(raw.bytes),
      dataLen: raw.bytes.length,
      isFile: raw.isFile,
      legacyLength: raw.legacyLength,
    };
  }
  function plan(payloadLength, options) {
    assert(
      Number.isInteger(payloadLength) && payloadLength > 32,
      "无效的传输数据长度",
    );
    assert(
      options.version === "auto" ||
        (Number.isInteger(Number(options.version)) &&
          !!capacities[Number(options.version)]),
      "无效的二维码版本",
    );
    let version = options.version === "auto" ? 0 : Number(options.version);
    const automatic = !version;
    const ecc = options.ecc,
      protocol = options.protocol;
    assert(
      ["L", "M"].includes(ecc) && ["v3", "v4"].includes(protocol),
      "无效的纠错或协议设置",
    );
    assert(!version || capacities[version], "无效的二维码版本");
    const header = protocol === "v4" ? P.HEADER_V4 : P.HEADER_V3;
    if (automatic) {
      // Balance optical density and airtime: use V20 capacity, grow only to
      // respect the frame limit; shrink to the smallest QR fitting equal chunks.
      version = 20;
      while (
        version < 40 &&
        Math.ceil(payloadLength / (capacities[version][ecc] - header)) >
          MAX_DATA_FRAMES
      )
        version++;
    }
    for (let v = version || 10; v <= (version || 40); v++) {
      const k = Math.ceil(payloadLength / (capacities[v][ecc] - header));
      if (k < 1 || k > MAX_DATA_FRAMES) continue;
      const p =
        protocol === "v4" && options.parity && k >= 8 ? Math.ceil(k / 8) : 0;
      const chunkSize = Math.ceil(payloadLength / k);
      let selected = v;
      if (automatic)
        for (let smaller = 10; smaller < v; smaller++) {
          if (capacities[smaller][ecc] - header >= chunkSize) {
            selected = smaller;
            break;
          }
        }
      return {
        version: selected,
        ecc,
        protocol,
        k,
        p,
        chunkSize,
        total: k + p,
      };
    }
    throw new Error(
      !automatic
        ? "当前版本超过 200 个数据帧，请选择自动或更大版本"
        : "压缩后仍超过传输容量，请拆分文件或减少文本",
    );
  }
  function playOrder(k, p) {
    const order = [];
    let parity = 0;
    for (let data = 0; data < k; data++) {
      order.push(data);
      while (parity < p && data + 1 >= Math.ceil(((parity + 1) * k) / p))
        order.push(k + parity++);
    }
    return order;
  }
  async function digest(bytes) {
    assert(
      globalThis.crypto && globalThis.crypto.subtle,
      "SHA-256 不可用，请使用 HTTPS、localhost 或支持的本地浏览器",
    );
    return new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", bytes),
    );
  }
  async function build(prepared, options, sessionId) {
    const spec = plan(32 + prepared.compressed.length, options);
    const packed = new Uint8Array(spec.k * spec.chunkSize);
    packed.set(prepared.compressed, 32);
    packed.set(await digest(packed.subarray(32)), 0);
    const chunks = Array.from({ length: spec.k }, (_, i) =>
      packed.slice(i * spec.chunkSize, (i + 1) * spec.chunkSize),
    );
    if (sessionId === undefined) {
      const random = new Uint8Array(1);
      crypto.getRandomValues(random);
      sessionId = 1 + (random[0] % 255);
    }
    const length =
      options.protocol === "v4" ? prepared.dataLen : prepared.legacyLength;
    const frames = chunks.map((body, i) =>
      options.protocol === "v4"
        ? P.buildV4Frame(
            i + 1,
            spec.total,
            length,
            spec.k,
            spec.p,
            prepared.isFile,
            sessionId,
            P.FRAME_DATA,
            body,
          )
        : P.buildV3Frame(
            i + 1,
            spec.total,
            length,
            spec.k,
            prepared.isFile,
            sessionId,
            body,
          ),
    );
    for (let j = 0; j < spec.p; j++) {
      const group = chunks.filter((_, i) => i % spec.p === j);
      frames.push(
        P.buildV4Frame(
          spec.k + j + 1,
          spec.total,
          length,
          spec.k,
          spec.p,
          prepared.isFile,
          sessionId,
          P.FRAME_PARITY,
          P.makeParity(group),
        ),
      );
    }
    return { spec, frames, order: playOrder(spec.k, spec.p), sessionId };
  }
  function fingerprint(f) {
    return [
      f.version,
      f.sessionId,
      f.k,
      f.p,
      f.totalParts,
      f.chunkBytes,
      f.version === 4 ? f.dataLen : f.totalChars,
      f.flags & 7,
    ].join("/");
  }
  class Collector {
    constructor() {
      this.reset();
    }
    reset() {
      this.meta = null;
      this.key = "";
      this.data = new Map();
      this.parity = new Map();
      this.recovered = new Set();
      this.bad = 0;
      this.started = 0;
      this.updated = 0;
    }
    accept(bytes) {
      const f = P.parseFrame(bytes);
      if (!f || (f.version === 4 && !P.crcMatch(f))) {
        this.bad++;
        return { accepted: false };
      }
      const key = fingerprint(f);
      const changed = !!this.key && this.key !== key;
      if (changed) this.reset();
      if (!this.meta) {
        this.meta = f;
        this.key = key;
        this.started = Date.now();
      }
      const map = f.partNum <= f.k ? this.data : this.parity;
      if (map.has(f.partNum)) {
        // A one-byte legacy session ID can collide. A differing duplicate is a new transfer.
        const old = map.get(f.partNum);
        if (!old.every((b, i) => b === f.body[i])) {
          this.reset();
          const result = this.accept(bytes);
          result.changed = true;
          return result;
        }
        return { accepted: true, duplicate: true, changed };
      }
      map.set(f.partNum, f.body);
      this.updated = Date.now();
      // Only the newly affected disjoint XOR group can become recoverable.
      if (f.p) {
        const j =
          f.partNum <= f.k ? (f.partNum - 1) % f.p : f.partNum - f.k - 1;
        const parity = this.parity.get(f.k + j + 1);
        if (parity) {
          const missing = [],
            others = [];
          for (let i = j + 1; i <= f.k; i += f.p)
            this.data.has(i) ? others.push(this.data.get(i)) : missing.push(i);
          if (missing.length === 1) {
            this.data.set(missing[0], P.recoverBody(parity, others));
            this.recovered.add(missing[0]);
          }
        }
      }
      return { accepted: true, changed, complete: this.data.size === f.k };
    }
    missing() {
      return this.meta
        ? Array.from({ length: this.meta.k }, (_, i) => i + 1).filter(
            (i) => !this.data.has(i),
          )
        : [];
    }
    async finish() {
      const f = this.meta;
      assert(f && this.data.size === f.k, "数据帧尚未收齐");
      const joined = new Uint8Array(f.k * f.chunkBytes);
      for (let i = 1; i <= f.k; i++)
        joined.set(this.data.get(i), (i - 1) * f.chunkBytes);
      assert(joined.length > 32, "数据长度不足");
      const hash = await digest(joined.subarray(32));
      assert(
        hash.every((b, i) => b === joined[i]),
        "SHA-256 校验失败，请重新扫描",
      );
      const limit = f.version === 4 ? f.dataLen : MAX_INPUT + 256;
      const bytes = inflateBounded(joined.subarray(32), limit);
      if (f.version === 4)
        assert(bytes.length === f.dataLen, "解压后长度不匹配，请重新扫描");
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      });
      let file = f.isFile;
      if (!f.typeKnown) {
        // Only for old v3 frames that predate the explicit type flag.
        const name = bytes[0];
        file =
          name > 0 &&
          bytes.length >= 1 + name &&
          /^[\x20-\x7e一-鿿]+$/.test(
            new TextDecoder().decode(bytes.slice(1, 1 + name)),
          );
      }
      if (file) {
        const length = bytes[0];
        assert(
          length > 0 && bytes.length >= length + 1,
          "文件头无效，请重新扫描",
        );
        const name = decoder.decode(bytes.subarray(1, 1 + length));
        const content = bytes.slice(1 + length);
        if (f.version === 3)
          assert(content.length === f.totalChars, "文件大小不匹配，请重新扫描");
        return { isFile: true, name, bytes: content };
      }
      const text = decoder.decode(bytes);
      if (f.version === 3)
        assert(text.length === f.totalChars, "文本长度不匹配，请重新扫描");
      return { isFile: false, text, bytes };
    }
  }
  function inflateBounded(compressed, limit) {
    assert(
      Number.isInteger(limit) && limit >= 0 && limit <= MAX_INPUT + 256,
      "数据超过 16 MB 接收上限",
    );
    const inflate = new pako.Inflate({ chunkSize: 65536 });
    let total = 0;
    const chunks = [];
    inflate.onData = function (chunk) {
      total += chunk.length;
      assert(total <= limit, "解压数据超过声明长度或 16 MB 上限");
      chunks.push(chunk);
    };
    inflate.push(compressed, true);
    assert(!inflate.err && inflate.ended, "解压失败或 gzip 数据不完整");
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  return {
    MAX_INPUT,
    MAX_DATA_FRAMES,
    encodeText,
    encodeFile,
    prepare,
    plan,
    playOrder,
    build,
    Collector,
    inflateBounded,
    formatSize,
  };
});
