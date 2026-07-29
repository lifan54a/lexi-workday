"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PixelBlast from "./PixelBlast";

type BackgroundHost = {
  hero: HTMLElement;
  root: HTMLDivElement;
};

function normalizeLegacyMarkup(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script").forEach((script) => script.remove());
  parsed.querySelectorAll<HTMLElement>("[src]").forEach((element) => {
    const source = element.getAttribute("src");
    if (!source) return;
    element.setAttribute("src", new URL(source, `${window.location.origin}/legacy/index.html`).pathname);
  });
  return parsed.body.innerHTML;
}

export default function LegacyHome() {
  const shellRef = useRef<HTMLDivElement>(null);
  const scriptLoadedRef = useRef(false);
  const [markup, setMarkup] = useState("");
  const [loadError, setLoadError] = useState("");
  const [backgroundHost, setBackgroundHost] = useState<BackgroundHost | null>(null);
  const legacyHtml = useMemo(() => ({ __html: markup }), [markup]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/legacy/index.html", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((html) => setMarkup(normalizeLegacyMarkup(html)))
      .catch((error: Error) => {
        if (error.name !== "AbortError") setLoadError("页面内容加载失败，请刷新后重试。");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!markup || scriptLoadedRef.current) return;
    scriptLoadedRef.current = true;
    const script = document.createElement("script");
    script.src = "/legacy/app.js";
    script.async = false;
    script.dataset.legacyApp = "true";
    document.body.appendChild(script);
  }, [markup]);

  useEffect(() => {
    if (!markup) return;
    const hero = shellRef.current?.querySelector<HTMLElement>(".hero-editorial");
    if (!hero) return;

    const root = document.createElement("div");
    root.id = "pixelblast-background";
    root.setAttribute("aria-hidden", "true");
    Object.assign(root.style, {
      position: "absolute",
      inset: "0",
      zIndex: "0",
      overflow: "hidden",
    });
    hero.prepend(root);
    setBackgroundHost({ hero, root });
    return () => {
      root.remove();
    };
  }, [markup]);

  if (loadError) return <p className="legacy-load-error">{loadError}</p>;

  return (
    <>
      <div ref={shellRef} className="legacy-shell" dangerouslySetInnerHTML={legacyHtml} />
      {backgroundHost &&
        createPortal(
          <PixelBlast
            variant="circle"
            pixelSize={5}
            color="#558CFF"
            patternScale={2.5}
            patternDensity={1.25}
            pixelSizeJitter={0.5}
            enableRipples
            rippleSpeed={0.4}
            rippleThickness={0.12}
            rippleIntensityScale={1.5}
            liquid={false}
            liquidStrength={0.12}
            liquidRadius={1.2}
            liquidWobbleSpeed={5}
            speed={0.6}
            edgeFade={0.28}
            transparent
            interactionTarget={backgroundHost.hero}
            style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}
          />,
          backgroundHost.root,
        )}
    </>
  );
}
