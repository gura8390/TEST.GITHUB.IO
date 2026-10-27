// 动态流式二维码 v2.5 — 共享协议模块（发送端/接收端/Node 测试三方复用）
// v3 头（13 字节，兼容 2.3/2.4）：
//   0-1 魔数 "v3" | 2 flags | 3-4 帧号 | 5-6 总帧数 | 7-10 totalChars | 11 会话ID | 12 k
// v4 头（16 字节，v2.5 新增）：
//   0-1 魔数 "v4" | 2 flags | 3-4 帧号 | 5-6 总帧数(k+p) | 7-10 解压后数据长度
//   11 会话ID | 12 数据帧数 k | 13 校验帧数 p | 14-15 body CRC16-CCITT
// flags：bit0=已压缩，bit1=类型(0文本/1文件)，bit2=类型位有效，bit6-7=帧类型(01=数据,10=校验)
// 校验帧 body = 同组数据帧 body 的逐字节 XOR（所有数据帧 body 等长，分组：(帧号-1) % p == 校验帧序号-1）
(function (root, factory) {
  var mod = factory();
  if (typeof module === "object" && typeof module.exports === "object")
    module.exports = mod;
  else root.QRProtocol = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var HEADER_V3 = 13,
    HEADER_V4 = 16;
  var FRAME_DATA = 1,
    FRAME_PARITY = 2;

  // ---- CRC16-CCITT-FALSE（poly 0x1021, init 0xFFFF）----
  var CRC_TABLE = (function () {
    var t = new Uint16Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n << 8;
      for (var i = 0; i < 8; i++)
        c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
      t[n] = c;
    }
    return t;
  })();
  function crc16(bytes) {
    var crc = 0xffff;
    for (var i = 0; i < bytes.length; i++)
      crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 0xff];
    return crc;
  }

  // ---- 构建 ----
  function buildV3Frame(
    partNum,
    totalParts,
    totalChars,
    k,
    isFile,
    sessionId,
    body,
  ) {
    var out = new Uint8Array(HEADER_V3 + body.length);
    out[0] = 0x76;
    out[1] = 0x33;
    out[2] = 0x01 | 0x04 | (FRAME_DATA << 6) | (isFile ? 0x02 : 0);
    out[3] = partNum & 0xff;
    out[4] = (partNum >> 8) & 0xff;
    out[5] = totalParts & 0xff;
    out[6] = (totalParts >> 8) & 0xff;
    out[7] = totalChars & 0xff;
    out[8] = (totalChars >> 8) & 0xff;
    out[9] = (totalChars >> 16) & 0xff;
    out[10] = (totalChars >> 24) & 0xff;
    out[11] = sessionId & 0xff;
    out[12] = k & 0xff;
    out.set(body, HEADER_V3);
    return out;
  }

  function buildV4Frame(
    partNum,
    totalParts,
    dataLen,
    k,
    p,
    isFile,
    sessionId,
    frameType,
    body,
  ) {
    var out = new Uint8Array(HEADER_V4 + body.length);
    out[0] = 0x76;
    out[1] = 0x34;
    out[2] = 0x01 | 0x04 | ((frameType & 0x03) << 6) | (isFile ? 0x02 : 0);
    out[3] = partNum & 0xff;
    out[4] = (partNum >> 8) & 0xff;
    out[5] = totalParts & 0xff;
    out[6] = (totalParts >> 8) & 0xff;
    out[7] = dataLen & 0xff;
    out[8] = (dataLen >> 8) & 0xff;
    out[9] = (dataLen >> 16) & 0xff;
    out[10] = (dataLen >> 24) & 0xff;
    out[11] = sessionId & 0xff;
    out[12] = k & 0xff;
    out[13] = p & 0xff;
    var crc = crc16(body);
    out[14] = crc & 0xff;
    out[15] = (crc >> 8) & 0xff;
    out.set(body, HEADER_V4);
    return out;
  }

  // ---- 解析（按魔数分派 v3/v4）----
  // 返回字段：version, flags, compressed, isFile, typeKnown, partNum, totalParts,
  //          sessionId, k, p, frameType, chunkBytes, body(Uint8Array),
  //          v3: totalChars / v4: dataLen, crc16
  function parseFrame(bytes) {
    if (!bytes || bytes.length < HEADER_V3 || bytes[0] !== 0x76) return null;
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    var flags, o;
    if (bytes[1] === 0x34 && bytes.length >= HEADER_V4) {
      flags = bytes[2];
      o = {
        version: 4,
        flags: flags,
        partNum: bytes[3] | (bytes[4] << 8),
        totalParts: bytes[5] | (bytes[6] << 8),
        dataLen:
          (bytes[7] |
            (bytes[8] << 8) |
            (bytes[9] << 16) |
            (bytes[10] << 24)) >>>
          0,
        sessionId: bytes[11],
        k: bytes[12],
        p: bytes[13],
        crc16: bytes[14] | (bytes[15] << 8),
        body: bytes.slice(HEADER_V4),
      };
    } else if (bytes[1] === 0x33) {
      flags = bytes[2];
      o = {
        version: 3,
        flags: flags,
        partNum: bytes[3] | (bytes[4] << 8),
        totalParts: bytes[5] | (bytes[6] << 8),
        totalChars:
          (bytes[7] |
            (bytes[8] << 8) |
            (bytes[9] << 16) |
            (bytes[10] << 24)) >>>
          0,
        sessionId: bytes[11],
        k: bytes[12],
        p: 0,
        frameType: FRAME_DATA,
        crc16: null,
        body: bytes.slice(HEADER_V3),
      };
    } else return null;
    o.compressed = (flags & 0x01) === 0x01;
    o.isFile = (flags & 0x02) === 0x02;
    o.typeKnown = (flags & 0x04) === 0x04;
    if (o.version === 4) o.frameType = (flags >> 6) & 0x03;
    o.chunkBytes = o.body.length;
    // Validate before the receiver allocates state or accepts a session.
    if (!o.k && o.version === 3) o.k = o.totalParts;
    if (
      o.k < 1 ||
      o.k > 255 ||
      o.p > Math.ceil(o.k / 8) ||
      o.totalParts !== o.k + o.p ||
      o.partNum < 1 ||
      o.partNum > o.totalParts ||
      o.chunkBytes < 1 ||
      o.chunkBytes > 2940 ||
      !o.compressed ||
      flags & 0x38
    )
      return null;
    if (
      o.version === 4 &&
      (!o.typeKnown ||
        o.dataLen > 16 * 1024 * 1024 + 256 ||
        o.frameType !== (o.partNum <= o.k ? FRAME_DATA : FRAME_PARITY))
    )
      return null;
    if (o.version === 3 && flags >> 6 !== FRAME_DATA) return null;
    return o;
  }

  // 校验帧 body 的 CRC 是否匹配
  function crcMatch(parsed) {
    return parsed.version === 4 && crc16(parsed.body) === parsed.crc16;
  }

  // ---- XOR 校验帧 ----
  function xorInto(acc, bytes) {
    if (acc.length !== bytes.length)
      throw new Error("XOR bodies must be equal length");
    for (var i = 0; i < acc.length; i++) acc[i] ^= bytes[i];
    return acc;
  }
  // 由一组等长 body 生成校验 body
  function makeParity(bodies) {
    if (!bodies.length) throw new Error("parity group must not be empty");
    var acc = new Uint8Array(bodies[0].length);
    for (var i = 0; i < bodies.length; i++) {
      if (bodies[i].length !== acc.length)
        throw new Error("parity bodies must be equal length");
      xorInto(acc, bodies[i]);
    }
    return acc;
  }
  // 校验帧分组：数据帧号 i（1-based）属于组 ((i-1) % p) + 1
  function parityGroupOf(partNum, p) {
    return ((partNum - 1) % p) + 1;
  }
  // 用校验 body + 组内其余数据 body 恢复缺失 body
  function recoverBody(parityBody, otherBodies) {
    var acc = new Uint8Array(parityBody);
    for (var i = 0; i < otherBodies.length; i++) xorInto(acc, otherBodies[i]);
    return acc;
  }

  return {
    HEADER_V3: HEADER_V3,
    HEADER_V4: HEADER_V4,
    FRAME_DATA: FRAME_DATA,
    FRAME_PARITY: FRAME_PARITY,
    crc16: crc16,
    buildV3Frame: buildV3Frame,
    buildV4Frame: buildV4Frame,
    parseFrame: parseFrame,
    crcMatch: crcMatch,
    makeParity: makeParity,
    parityGroupOf: parityGroupOf,
    recoverBody: recoverBody,
  };
});
