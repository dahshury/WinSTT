import { withBasePath } from "@/lib/site";

export function HomeScreenshot() {
  return (
    <section className="relative flex w-full flex-col items-center px-6 pt-4 pb-20">
      <div
        className="pointer-events-none absolute top-1/2 left-1/2 h-[400px] w-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse, oklch(62% 0.19 260 /0.04) 0%, transparent 70%)",
        }}
      />
      <img
        src={withBasePath("/screenshots/main.png")}
        alt="The WinSTT main window - the title bar shows the active hotkey, a 9-band audio visualizer fills the center, and the footer shows GPU, input device, and model."
        width={840}
        height={300}
        decoding="async"
        className="relative mx-auto block select-none overflow-hidden rounded-lg"
        style={{
          width: "min(100%, 460px)",
          aspectRatio: "14 / 5",
          objectFit: "cover",
          border: "1px solid var(--border)",
          boxShadow:
            "0 0 0 1px hsla(0,0%,0%,0.6), 0 25px 70px -12px hsla(0,0%,0%,0.7), 0 0 60px oklch(62% 0.19 260 / 0.05)",
        }}
      />
      <p
        className="mt-4 text-center"
        style={{
          fontSize: "12px",
          color: "oklch(94% 0.015 265 /0.25)",
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.3px",
        }}
      >
        The main window - 9-band audio visualizer with live hotkey, mic and
        model chips
      </p>
    </section>
  );
}
