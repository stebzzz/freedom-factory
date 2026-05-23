import type { SceneStatus } from "@/lib/projects/types";

const LABELS: Record<SceneStatus, string> = {
  "not-started": "À faire",
  "image-pending": "Image…",
  "image-stuck": "Image stuck",
  "image-failed": "Image fail",
  "image-only": "Image OK",
  "video-pending": "Génération…",
  "video-stuck": "Stuck",
  "video-failed": "Failed",
  "done": "OK",
};

const CLASSES: Record<SceneStatus, string> = {
  "not-started": "badge-gray",
  "image-pending": "badge-blue",
  "image-stuck": "badge-orange",
  "image-failed": "badge-red",
  "image-only": "badge-blue",
  "video-pending": "badge-blue",
  "video-stuck": "badge-orange",
  "video-failed": "badge-red",
  "done": "badge-green",
};

export function StatusBadge({ status }: { status: SceneStatus }) {
  return <span className={`badge ${CLASSES[status]}`}>{LABELS[status]}</span>;
}

export function statusDot(status: SceneStatus): string {
  switch (status) {
    case "done": return "var(--green)";
    case "video-pending":
    case "image-pending": return "var(--blue)";
    case "video-stuck":
    case "image-stuck": return "var(--orange)";
    case "video-failed":
    case "image-failed": return "var(--red)";
    case "image-only": return "var(--blue)";
    default: return "var(--text-tertiary)";
  }
}
