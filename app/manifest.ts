import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lexi's workday · 排期台",
    short_name: "Lexi Workday",
    description: "每日待办排期、月度视图与自动周报。",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f8fa",
    theme_color: "#007aff",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
