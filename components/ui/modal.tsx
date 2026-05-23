"use client";

import { ReactNode, useEffect } from "react";
import { X } from "lucide-react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  subtitle?: string;
  width?: string;
}

export function Modal({ open, onClose, children, title, subtitle, width = "580px" }: ModalProps) {
  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ animation: "fadeIn 0.2s ease-out" }}>
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
        onClick={onClose}
      />
      <div
        className="relative glass-strong overflow-hidden flex flex-col"
        style={{
          width,
          maxWidth: "calc(100vw - 40px)",
          maxHeight: "calc(100vh - 80px)",
          borderRadius: "var(--radius-lg)",
          animation: "fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {(title || subtitle) && (
          <div className="px-6 pt-5 pb-4 flex items-start justify-between" style={{ borderBottom: "1px solid var(--border-glass)" }}>
            <div>
              {title && <h2 className="heading-lg">{title}</h2>}
              {subtitle && <p className="text-[13px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>{subtitle}</p>}
            </div>
            <button
              onClick={onClose}
              className="flex items-center justify-center rounded-lg transition-all hover:opacity-70"
              style={{ width: 30, height: 30, background: "var(--bg-glass-hover)" }}
            >
              <X size={15} style={{ color: "var(--text-secondary)" }} />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
