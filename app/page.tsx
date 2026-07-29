import type { Metadata } from "next";
import LegacyHome from "./components/LegacyHome";

export const metadata: Metadata = {
  title: "Lexi's workday · 排期台",
  description: "每日待办排期、月度视图与自动周报，数据安全保存在云端。",
};

export default function Home() {
  return <LegacyHome />;
}
