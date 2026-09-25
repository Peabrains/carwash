export function dismissTransientOverlays(root = document) {
  root.querySelectorAll('[data-transient-overlay]').forEach(overlay => overlay.remove());
}
