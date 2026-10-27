// Keep this small startup diagnostic compatible even when another script cannot parse.
(function () {
  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(function () {
      if (window.__receiverReady) return;
      document.getElementById("statusText").textContent =
        "接收程序未能加载。请完整上传 recv 文件夹，再刷新页面；若仍失败，请使用系统浏览器打开。";
      document.getElementById("btnCamera").disabled = true;
      var retry = document.getElementById("btnRetry");
      retry.disabled = false;
      retry.textContent = "重新加载";
      retry.onclick = function () {
        location.reload();
      };
    }, 0);
  });
})();
