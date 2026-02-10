/**
 * Animated visual mock of the WinSTT desktop app.
 * Non-functional — purely decorative for docs/landing page.
 * Waveform animations use CSS keyframes defined in global.css.
 */
export function AppMock() {
	return (
		<div
			className="relative w-full max-w-[680px] mx-auto rounded-xl overflow-hidden select-none"
			style={{
				background: "#09090b",
				border: "1px solid hsla(240, 3.8%, 20%, 0.5)",
				boxShadow:
					"0 0 0 1px hsla(0,0%,0%,0.8), 0 25px 70px -12px hsla(0,0%,0%,0.7), 0 0 60px hsla(43,96%,56%,0.03)",
				fontFamily: '"Geist", system-ui, -apple-system, sans-serif',
			}}
		>
			{/* ── Titlebar ── */}
			<div
				className="flex items-center justify-between px-3"
				style={{
					height: "32px",
					background: "#0c0c0f",
					borderBottom: "1px solid hsla(240, 3.8%, 20%, 0.35)",
				}}
			>
				<div className="flex items-center gap-1.5">
					<svg
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						style={{ color: "hsl(43, 96%, 56%)", opacity: 0.7 }}
					>
						<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
						<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
						<line x1="12" x2="12" y1="19" y2="22" />
					</svg>
					<span
						style={{
							fontSize: "10px",
							fontFamily: '"Geist Mono", monospace',
							color: "hsla(0,0%,100%,0.35)",
							textTransform: "uppercase",
							letterSpacing: "0.5px",
							fontWeight: 500,
						}}
					>
						WinSTT
					</span>
				</div>
				<div className="flex items-center gap-0.5">
					<div
						className="flex items-center justify-center rounded"
						style={{ width: "28px", height: "22px" }}
					>
						<svg width="10" height="10" viewBox="0 0 10 10">
							<line x1="2" y1="5" x2="8" y2="5" stroke="hsla(0,0%,100%,0.35)" strokeWidth="1.2" />
						</svg>
					</div>
					<div
						className="flex items-center justify-center rounded"
						style={{ width: "28px", height: "22px" }}
					>
						<svg width="10" height="10" viewBox="0 0 10 10">
							<line x1="2" y1="2" x2="8" y2="8" stroke="hsla(0,0%,100%,0.35)" strokeWidth="1.2" />
							<line x1="8" y1="2" x2="2" y2="8" stroke="hsla(0,0%,100%,0.35)" strokeWidth="1.2" />
						</svg>
					</div>
				</div>
			</div>

			{/* ── Main canvas area ── */}
			<div
				className="relative"
				style={{
					height: "280px",
					background: "linear-gradient(180deg, #09090b 0%, #0c0c0f 100%)",
					overflow: "hidden",
				}}
			>
				{/* Ambient glow behind waves */}
				<div
					className="absolute mock-glow-pulse"
					style={{
						top: "50%",
						left: "50%",
						transform: "translate(-50%, -50%)",
						width: "400px",
						height: "120px",
						borderRadius: "50%",
						background: "radial-gradient(ellipse, hsla(43, 96%, 56%, 0.1) 0%, transparent 70%)",
						filter: "blur(20px)",
					}}
				/>

				{/* Animated waveform SVG */}
				<svg
					className="absolute inset-0 w-full h-full"
					viewBox="0 0 680 280"
					preserveAspectRatio="none"
					style={{ opacity: 0.85 }}
				>
					<defs>
						<linearGradient id="waveFill" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="hsl(43, 96%, 56%)" stopOpacity="0.06" />
							<stop offset="50%" stopColor="transparent" stopOpacity="0" />
							<stop offset="100%" stopColor="hsl(43, 96%, 56%)" stopOpacity="0.06" />
						</linearGradient>
						<filter id="glow">
							<feGaussianBlur stdDeviation="3" result="blur" />
							<feMerge>
								<feMergeNode in="blur" />
								<feMergeNode in="SourceGraphic" />
							</feMerge>
						</filter>
						{/* Clip to prevent overflow during animation drift */}
						<clipPath id="waveClip">
							<rect x="-40" y="0" width="760" height="280" />
						</clipPath>
					</defs>

					<g clipPath="url(#waveClip)">
						{/* Fill between waves — slow drift */}
						<path
							className="mock-wave-fill"
							d="M-40,115 C0,100 40,85 80,95 C120,105 160,75 200,80 C240,85 280,65 320,70 C360,75 400,90 440,85 C480,80 520,95 560,90 C600,85 640,100 680,100 C720,100 720,180 680,180 C640,195 600,190 560,185 C520,180 480,195 440,190 C400,185 360,205 320,210 C280,215 240,195 200,200 C160,205 120,185 80,195 C40,180 0,165 -40,165 Z"
							fill="url(#waveFill)"
						/>

						{/* Primary top wave */}
						<path
							className="mock-wave-primary"
							d="M-40,140 C-12,128 16,108 45,112 C74,116 102,95 130,100 C159,105 187,88 215,92 C244,96 272,78 300,82 C329,86 357,72 385,78 C414,84 442,98 470,92 C499,86 527,102 556,96 C584,90 612,108 640,104 C668,100 696,112 720,116"
							fill="none"
							stroke="hsl(43, 96%, 56%)"
							strokeWidth="1.5"
							filter="url(#glow)"
							opacity="0.9"
						/>

						{/* Center baseline */}
						<line x1="0" y1="140" x2="680" y2="140" stroke="hsla(0,0%,100%,0.04)" strokeWidth="1" />

						{/* Primary bottom wave (mirror) */}
						<path
							className="mock-wave-primary"
							d="M-40,140 C-12,152 16,172 45,168 C74,164 102,185 130,180 C159,175 187,192 215,188 C244,184 272,202 300,198 C329,194 357,208 385,202 C414,196 442,182 470,188 C499,194 527,178 556,184 C584,190 612,172 640,176 C668,180 696,168 720,164"
							fill="none"
							stroke="hsl(43, 96%, 56%)"
							strokeWidth="1.5"
							filter="url(#glow)"
							opacity="0.9"
						/>

						{/* Secondary waves — opposite drift for parallax */}
						<path
							className="mock-wave-secondary"
							d="M-40,140 C-5,130 30,118 65,122 C100,126 135,110 170,115 C205,120 240,105 275,108 C310,111 345,96 380,102 C415,108 450,120 485,114 C520,108 555,122 590,118 C625,114 660,124 695,120 C720,118 720,118 720,118"
							fill="none"
							stroke="hsla(43, 96%, 56%, 0.3)"
							strokeWidth="0.8"
						/>
						<path
							className="mock-wave-secondary"
							d="M-40,140 C-5,150 30,162 65,158 C100,154 135,170 170,165 C205,160 240,175 275,172 C310,169 345,184 380,178 C415,172 450,160 485,166 C520,172 555,158 590,162 C625,166 660,156 695,160 C720,158 720,158 720,158"
							fill="none"
							stroke="hsla(43, 96%, 56%, 0.3)"
							strokeWidth="0.8"
						/>

						{/* Tertiary faint waves — slowest drift */}
						<path
							className="mock-wave-tertiary"
							d="M-40,140 C10,134 60,124 110,128 C160,132 210,118 260,122 C310,126 360,114 410,118 C460,122 510,132 560,126 C610,120 660,130 710,126 C720,125 720,125 720,125"
							fill="none"
							stroke="hsla(43, 96%, 56%, 0.12)"
							strokeWidth="0.6"
						/>
						<path
							className="mock-wave-tertiary"
							d="M-40,140 C10,146 60,156 110,152 C160,148 210,162 260,158 C310,154 360,166 410,162 C460,158 510,148 560,154 C610,160 660,150 710,154 C720,155 720,155 720,155"
							fill="none"
							stroke="hsla(43, 96%, 56%, 0.12)"
							strokeWidth="0.6"
						/>
					</g>
				</svg>

				{/* Transcription text overlay at bottom */}
				<div
					className="absolute bottom-0 left-0 right-0 px-5 pb-4 pt-16"
					style={{
						background: "linear-gradient(180deg, transparent 0%, rgba(9,9,11,0.85) 40%, rgba(9,9,11,0.98) 100%)",
					}}
				>
					<p style={{ fontSize: "12.5px", lineHeight: "1.7", color: "hsla(0,0%,100%,0.25)", margin: 0 }}>
						The quick brown fox jumps over the lazy dog near the riverbank
					</p>
					<p style={{ fontSize: "12.5px", lineHeight: "1.7", color: "hsla(0,0%,100%,0.5)", margin: 0 }}>
						while the sun sets behind the distant mountains casting long shadows
					</p>
					<p style={{ fontSize: "12.5px", lineHeight: "1.7", color: "hsla(0,0%,100%,0.7)", margin: 0 }}>
						across the golden fields of wheat swaying gently in the breeze
						<span className="mock-cursor-blink" style={{ color: "hsl(43, 96%, 56%)", fontWeight: 300 }}>&thinsp;|</span>
					</p>
				</div>
			</div>

			{/* ── Status bar ── */}
			<div
				className="flex items-center justify-between px-3"
				style={{
					height: "28px",
					background: "#0a0a0c",
					borderTop: "1px solid hsla(240, 3.8%, 20%, 0.3)",
					fontFamily: '"Geist Mono", monospace',
					fontSize: "10px",
				}}
			>
				{/* Left — device info */}
				<div className="flex items-center gap-1.5">
					<svg
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						style={{ color: "#22c55e" }}
					>
						<rect x="4" y="4" width="16" height="16" rx="2" />
						<rect x="9" y="9" width="6" height="6" />
						<path d="M15 2v2" />
						<path d="M15 20v2" />
						<path d="M2 15h2" />
						<path d="M2 9h2" />
						<path d="M20 15h2" />
						<path d="M20 9h2" />
						<path d="M9 2v2" />
						<path d="M9 20v2" />
					</svg>
					<span style={{ color: "hsla(0,0%,100%,0.4)" }}>CUDA — RTX 4090</span>
				</div>

				{/* Center — hotkey indicator */}
				<div
					className="flex items-center gap-1.5 px-2 rounded"
					style={{
						height: "18px",
						background: "hsla(43, 96%, 56%, 0.08)",
						border: "1px solid hsla(43, 96%, 56%, 0.15)",
					}}
				>
					<div
						className="rounded-full mock-status-pulse"
						style={{
							width: "4px",
							height: "4px",
							background: "hsl(43, 96%, 56%)",
							boxShadow: "0 0 6px hsl(43, 96%, 56%)",
						}}
					/>
					<span style={{ color: "hsla(43, 96%, 70%, 0.8)", fontSize: "9.5px", fontWeight: 500 }}>
						Space
					</span>
				</div>

				{/* Right — model info */}
				<div className="flex items-center gap-1.5">
					<svg
						width="10"
						height="10"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						style={{ color: "hsla(43, 96%, 56%, 0.6)" }}
					>
						<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
					</svg>
					<span style={{ color: "hsla(0,0%,100%,0.4)" }}>large-v2</span>
				</div>
			</div>
		</div>
	);
}
