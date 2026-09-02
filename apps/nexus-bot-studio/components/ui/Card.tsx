"use client";

import { CSSProperties, PointerEvent, ReactNode, TouchEvent, useRef } from "react";

type Props = { children: ReactNode; className?: string; style?: CSSProperties };

export function Card({ children, className = "", style }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const setPoint = (clientX: number, clientY: number) => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.setProperty("--mx", `${clientX - rect.left}px`);
    node.style.setProperty("--my", `${clientY - rect.top}px`);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => setPoint(event.clientX, event.clientY);
  const onTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (touch) setPoint(touch.clientX, touch.clientY);
  };
  const on = () => ref.current?.classList.add("is-lit");
  const off = () => ref.current?.classList.remove("is-lit");

  return (
    <div
      ref={ref}
      className={`card ${className}`.trim()}
      style={{ "--core-focus-token": "var(--focus-ring)", ...style } as CSSProperties}
      onPointerEnter={(event) => { on(); onPointerMove(event); }}
      onPointerMove={onPointerMove}
      onPointerLeave={off}
      onTouchStart={(event) => { on(); onTouchMove(event); }}
      onTouchMove={onTouchMove}
      onTouchEnd={off}
      onTouchCancel={off}
    >
      {children}
    </div>
  );
}
