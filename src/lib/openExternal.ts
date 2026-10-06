/** Open a URL in the system browser (Tauri opener), falling back to
 * `window.open` in browser dev mode. The plugin is imported dynamically so it
 * stays out of the dev bundle. */
export async function openExternal(url: string): Promise<void> {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
