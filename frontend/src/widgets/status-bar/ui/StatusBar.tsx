"use client";

import { Separator } from "@base-ui/react/separator";
import { AiAudioIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ConnectionIndicator } from "@/features/connect-server";
import { HotkeyDisplay } from "@/features/push-to-talk";
import { useSettingsStore } from "@/features/update-settings";

export function StatusBar() {
	const currentModel = useSettingsStore((s) => s.settings.model?.model);

	return (
		<div className="flex shrink-0 items-center justify-between overflow-hidden whitespace-nowrap border-border border-t bg-surface-primary px-2 py-1 font-mono">
			<ConnectionIndicator />
			<div className="flex items-center gap-1.5">
				<HotkeyDisplay />
				{currentModel && (
					<>
						<Separator className="h-3 w-px bg-border" orientation="vertical" />
						<span className="flex items-center gap-1 text-[10px] text-foreground-dim">
							<HugeiconsIcon color="var(--color-foreground-dim)" icon={AiAudioIcon} size={11} />
							<span className="truncate">{currentModel}</span>
						</span>
					</>
				)}
			</div>
		</div>
	);
}
