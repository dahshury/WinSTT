import { withBasePath } from "@/lib/site";

export function DemoVideo({ src }: { src: string }) {
  return (
    <video
      aria-label={src}
      autoPlay
      className="demo-video"
      loop
      muted
      playsInline
      preload="metadata"
      src={withBasePath(`/demos/${src}.webm`)}
      tabIndex={-1}
    />
  );
}
