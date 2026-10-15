# 动态流式二维码接收端 · 2.7.1 页面快照

通过手机摄像头接收屏幕上轮播的二维码，收集数据帧后显示文本或下载文件。A browser-based receiver for animated QR data transfer.

**当前仓库是接收端快照，部署文件尚不完整。** 页面标题标记为 2.7.1，当前不包含完整发送端。

## 入口与状态

- [GitHub Pages 页面](https://gura8390.github.io/TEST.GITHUB.IO/)：当前配置的网页入口，不代表端到端传输已经验证。
- `index.html` 是接收页面，`app.js` 是页面逻辑，`decoder.worker.js` 是解码工作线程。
- 页面引用 `../shared/protocol.js`、`../shared/capacity.js`、`../shared/transfer.js`，并链接 `../send/index.html`，但这些文件不在本仓库中。独立部署前需要恢复对应版本的共享模块和发送页面。
- 扫码需要摄像头权限，通常需要 HTTPS 或 localhost；发送端必须与接收端的协议匹配。

## 本地查看

```bash
git clone https://github.com/gura8390/TEST.GITHUB.IO.git
cd TEST.GITHUB.IO
python -m http.server 8000
```

访问 `http://localhost:8000/`。上述缺失资源仍需补齐，这条命令不能使不完整的快照自动恢复正常。

## 与其他二维码项目的关系

[JPUZ.GITHUB.IO](https://github.com/gura8390/JPUZ.GITHUB.IO) 是另一个二维码传输项目快照，当前页面标题为 v2.1。两个仓库的协议兼容性尚待核验，不应仅凭名称或版本号替换文件。

## 文件与依赖

`jsQR.js`、`pako.min.js`、`reed-solomon.js` 是随仓库保存的解码、压缩与纠错相关脚本；`manifest.json`、`sw.js` 用于网页应用配置与缓存。上游依赖的署名和许可应随相应文件保留。当前仓库没有独立的项目许可证文件。
