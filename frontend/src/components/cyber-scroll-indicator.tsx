"use client";

import { useEffect, useRef, useState } from "react";

const INDICATOR_HEIGHT = 28;
const EDGE_INSET = 7;
const IDLE_DELAY = 700;

interface IndicatorPosition {
  left: number;
  top: number;
}

export function CyberScrollIndicator() {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<IndicatorPosition>({ left: -20, top: -40 });
  const targetRef = useRef<HTMLElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const updatePosition = () => {
      frameRef.current = null;
      const target = targetRef.current;
      if (!target || target.scrollHeight <= target.clientHeight + 2) {
        setVisible(false);
        return;
      }

      const rect = target.getBoundingClientRect();
      const trackTop = Math.max(0, rect.top) + EDGE_INSET;
      const trackBottom = Math.min(window.innerHeight, rect.bottom) - EDGE_INSET;
      const trackHeight = trackBottom - trackTop;
      if (rect.width < 24 || trackHeight <= INDICATOR_HEIGHT + 8) {
        setVisible(false);
        return;
      }

      const maxScroll = Math.max(1, target.scrollHeight - target.clientHeight);
      const progress = Math.min(1, Math.max(0, target.scrollTop / maxScroll));
      const travel = Math.max(0, trackHeight - INDICATOR_HEIGHT);
      setPosition({
        left: Math.min(window.innerWidth - 8, Math.max(2, rect.right - 8)),
        top: trackTop + progress * travel,
      });
    };

    const schedulePosition = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(updatePosition);
    };

    const handleScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("cyber-scrollbar")) return;
      if (target.scrollHeight <= target.clientHeight + 2) return;

      targetRef.current = target;
      schedulePosition();
      setVisible(true);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => setVisible(false), IDLE_DELAY);
    };

    const handleResize = () => {
      if (targetRef.current) schedulePosition();
    };

    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className={`cyber-scroll-indicator pointer-events-none fixed z-[100] h-7 w-[5px] origin-center transition-[opacity,transform,filter] ease-out motion-reduce:transition-none ${visible ? "scale-y-100 opacity-100 duration-100" : "scale-y-50 opacity-0 duration-500"}`}
      style={{ left: position.left, top: position.top }}
    />
  );
}
