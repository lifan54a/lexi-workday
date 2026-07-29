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
    .catch(() => redirectToLogin());
})();
