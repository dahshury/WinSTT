import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { App } from "./ui/App";

const el = document.getElementById("root");
if (!el) throw new Error("[benchmark] #root missing");
createRoot(el).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
