(() => {
  "use strict";

  const showPage = () => {
    document.documentElement.classList.remove("auth-pending");
  };

  const redirectToLogin = () => {
    window.location.replace("/login");
    return new Promise(() => {});
  };

  window.__lexiCloudTasksPromise = fetch("/api/tasks", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  })
    .then(async (response) => {
      if (response.status === 401) return redirectToLogin();
      if (!response.ok) throw new Error(`Cloud check failed (${response.status})`);
      const data = await response.json();
      showPage();
      return data;
    })
    .catch((error) => {
      // 只有明确的 401 才代表会话失效。网络或服务故障时显示页面，
      // 让主程序继续使用本机缓存，并由同步逻辑提示用户。
      showPage();
      throw error;
    });
})();
