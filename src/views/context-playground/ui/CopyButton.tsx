import { Button as BaseButton } from "@base-ui/react/button";
import { useState } from "react";
import type { ContextDebugReport } from "@/shared/api/context-debug-types";
import { cn } from "@/shared/lib/cn";

type CopyStatus = "copied" | "error" | "idle";

export function CopyButton({ report }: { report: ContextDebugReport }) {
  const [status, setStatus] = useState<CopyStatus>("idle");

  const onCopy = async () => {
    const ok = await copyTextRobust(JSON.stringify(report, null, 2));
    setStatus(ok ? "copied" : "error");
    setTimeout(() => setStatus("idle"), 1500);
  };

  return (
    <BaseButton
      className={cn("rounded px-2 py-1 transition-colors", copyClass(status))}
      onClick={onCopy}
      type="button"
    >
      {copyLabel(status)}
    </BaseButton>
  );
}

function copyLabel(status: CopyStatus): string {
  switch (status) {
    case "copied":
      return "✓ Copied!";
    case "error":
      return "Copy failed — use Raw JSON below";
    default:
      return "Copy JSON";
  }
}

function copyClass(status: CopyStatus): string {
  switch (status) {
    case "copied":
      return "bg-success-dim text-success";
    case "error":
      return "bg-error-dim text-error";
    default:
      return "bg-surface-tertiary text-foreground hover:bg-surface-hover";
  }
}

/**
 * Copy text robustly from the reference renderer. The async Clipboard API works
 * when the document is focused (it is — the user just clicked our button); the
 * legacy textarea + execCommand path covers file:// where the async API can be
 * blocked. Returns whether either path succeeded.
 *
 * NOTE: the earlier `clipboardWriteText` route went through secure-IPC, whose
 * `invokeSecureOrDefault` swallows errors and returns a fake-success fallback —
 * that's why copy silently stopped working. Always copy directly in-renderer.
 */
async function copyTextRobust(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
