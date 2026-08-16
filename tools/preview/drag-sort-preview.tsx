// Dev-only harness for eyeballing the drag-to-reorder feel of the shared
// `Select` picker (grip, lift, sibling glide, FLIP drop) without booting the
// Tauri IPC the real mic pickers need. Served straight from the vite dev
// server: http://localhost:5180/tools/preview/drag-sort-preview.html
import { Mic01Icon } from "@hugeicons/core-free-icons";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/app/styles/globals.css";
import { SurfaceProvider } from "@/shared/lib/surface";
import { Select, type SelectOption } from "@/shared/ui/select";

const INITIAL: SelectOption[] = [
	{ id: "sys", label: "System default" },
	{ id: "blue", label: "Blue Yeti", icon: Mic01Icon, sortable: true },
	{ id: "rode", label: "RØDE NT-USB", icon: Mic01Icon, sortable: true },
	{ id: "webcam", label: "HD Webcam mic", icon: Mic01Icon, sortable: true },
	{ id: "buds", label: "Galaxy Buds", icon: Mic01Icon, sortable: true },
];

function Harness() {
	const [options, setOptions] = useState(INITIAL);
	const [value, setValue] = useState("blue");
	return (
		<SurfaceProvider value={3}>
			<div className="flex min-h-screen items-start justify-center bg-surface-1 p-16">
				<div className="w-72 rounded-xl bg-surface-3 p-4 shadow-surface-3">
					<Select
						aria-label="Microphone"
						onChange={setValue}
						onReorder={(ids) =>
							setOptions((prev) => {
								const byId = new Map(prev.map((o) => [o.id, o]));
								const moved = ids
									.map((id) => byId.get(id))
									.filter((o): o is SelectOption => Boolean(o));
								const rest = prev.filter((o) => !o.sortable);
								return [...rest, ...moved];
							})
						}
						options={options}
						reorderHandleLabel="Reorder microphone"
						value={value}
					/>
				</div>
			</div>
		</SurfaceProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<Harness />
		</StrictMode>,
	);
}
