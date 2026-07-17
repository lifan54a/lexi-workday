import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Lexi's workday · 排期台",
  description: "每日待办排期、月度视图与自动周报，数据安全保存在云端。",
};

export default function Home() {
  return (
    <iframe
      src="/legacy/index.html"
      title="Lexi's workday"
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", border: 0 }}
    />
  );
}
