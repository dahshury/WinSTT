import type { CSSProperties, ReactNode } from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import {
  AppWindow,
  AuraMeter,
  Bars,
  C,
  Card,
  Dot,
  GridMeter,
  Keycap,
  Label,
  MiniFooter,
  MODE,
  Pill,
  ProgressSteps,
  RadialMeter,
  Stage,
  TypeText,
  WaveMeter,
  hold,
  mapRange,
  ramp,
  springIn
} from "./theme";

type Mode = keyof typeof MODE;
type VisualKind = "bar" | "grid" | "radial" | "wave" | "aura";

const smallButtonBase: CSSProperties = {
  height: 34,
  padding: "0 13px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 7,
  fontFamily: C.mono,
  fontSize: 12,
  fontWeight: 650
};

const transcriptLineBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 46,
  padding: "0 18px",
  borderRadius: 8,
  background: C.surface2,
  color: C.fg,
  fontSize: 20
};

const modelRowBase: CSSProperties = {
  position: "relative",
  display: "grid",
  gridTemplateColumns: "1fr 88px 94px 116px",
  alignItems: "center",
  height: 58,
  padding: "0 14px",
  borderRadius: 8,
  overflow: "hidden"
};

const wLogoBox: CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: 8,
  display: "grid",
  placeItems: "center",
  background: C.surface3,
  border: `1px solid ${C.borderSoft}`,
  color: C.accent,
  fontFamily: C.mono,
  fontWeight: 900
};

const overlayPreviewBase: CSSProperties = {
  width: 520,
  minHeight: 122,
  padding: 20,
  borderRadius: 12,
  background: "rgba(8,9,13,0.86)"
};

const aiProcessingCard: CSSProperties = {
  width: 142,
  height: 142,
  borderRadius: 8,
  background: C.surface2,
  border: `1px solid ${C.borderSoft}`,
  display: "grid",
  placeItems: "center",
  position: "relative",
  overflow: "hidden"
};

const autoSubmitBubbleBase: CSSProperties = {
  maxWidth: 330,
  padding: "14px 18px",
  borderRadius: "14px 14px 4px 14px",
  background: C.accent,
  color: C.black,
  fontSize: 20,
  fontWeight: 720
};

const dropZoneBase: CSSProperties = {
  marginTop: 42,
  height: 260,
  borderRadius: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 24,
  position: "relative",
  overflow: "hidden"
};

const dropProgressTrackBase: CSSProperties = {
  position: "absolute",
  left: 190,
  right: 190,
  bottom: 42,
  height: 8,
  borderRadius: 999,
  background: C.surface4,
  overflow: "hidden"
};

const fileCardBadge: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 8,
  display: "grid",
  placeItems: "center",
  color: C.black,
  fontFamily: C.mono,
  fontWeight: 900,
  fontSize: 13
};

const overlayStageBox: CSSProperties = {
  width: 1180,
  height: 260,
  position: "relative",
  borderRadius: 12,
  background: C.surface0,
  border: `1px solid ${C.borderSoft}`,
  boxShadow: "0 20px 70px rgba(0,0,0,0.4)",
  overflow: "hidden"
};

const overlayBgCardBase: CSSProperties = {
  position: "absolute",
  top: 34,
  width: 58,
  height: 44,
  borderRadius: 8,
  border: `1px solid ${C.borderSoft}`
};

const overlayIslandBase: CSSProperties = {
  position: "absolute",
  left: "50%",
  top: 22,
  width: 560,
  minHeight: 92,
  padding: "12px 18px",
  borderRadius: "0 0 28px 28px",
  background: "rgba(4,5,8,0.94)",
  borderTop: "none"
};

const flowPacketBase: CSSProperties = {
  position: "absolute",
  width: 13,
  height: 13,
  borderRadius: 999,
  transform: "translate(-50%, -50%)"
};

const nodeBoxBase: CSSProperties = {
  position: "absolute",
  width: 174,
  height: 82,
  padding: 13,
  borderRadius: 8
};

const aiProcessingDotBase: CSSProperties = {
  position: "absolute",
  width: 5,
  height: 5,
  borderRadius: 999,
  background: C.accent
};

function PanelTitle({
  eyebrow,
  title,
  children
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
      <div>
        <Label>{eyebrow}</Label>
        <div style={{ marginTop: 8, color: C.fg, fontSize: 28, fontWeight: 760, lineHeight: 1 }}>
          {title}
        </div>
      </div>
      {children}
    </div>
  );
}

function SmallButton({
  children,
  active = false,
  accent = C.accent,
  style
}: {
  children: ReactNode;
  active?: boolean;
  accent?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        ...smallButtonBase,
        background: active ? `${accent}28` : C.surface2,
        border: `1px solid ${active ? `${accent}88` : C.borderSoft}`,
        color: active ? C.fg : C.fg2,
        ...style
      }}
    >
      {children}
    </div>
  );
}

function TranscriptLine({
  text,
  from = 30,
  duration = 44,
  accent = C.accent,
  style
}: {
  text: string;
  from?: number;
  duration?: number;
  accent?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        ...transcriptLineBase,
        border: `1px solid ${accent}44`,
        boxShadow: `0 0 28px ${accent}18`,
        ...style
      }}
    >
      <TypeText text={text} from={from} duration={duration} />
      <span
        style={{
          display: "inline-block",
          width: 9,
          height: 24,
          marginLeft: 5,
          background: accent,
          opacity: 0.85
        }}
      />
    </div>
  );
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <Card
      style={{
        width: 142,
        height: 82,
        padding: 14,
        background: C.surface2,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)"
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 780, color: C.fg }}>{value}</div>
      <div style={{ marginTop: 5, color: C.muted, fontSize: 12 }}>{label}</div>
    </Card>
  );
}

function ModelRows({ active = 1, progress = 0 }: { active?: number; progress?: number }) {
  const rows = [
    ["tiny", "39 MB", "Fast", "Ready"],
    ["base", "142 MB", "Balanced", progress > 0.98 ? "Ready" : "Downloading"],
    ["small", "466 MB", "Accurate", "Get"]
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map((row, i) => (
        <div
          key={row[0]}
          style={{
            ...modelRowBase,
            background: i === active ? C.accentDim : C.surface2,
            border: `1px solid ${i === active ? "rgba(74,131,255,0.36)" : C.borderSoft}`
          }}
        >
          {i === 1 && progress > 0 && progress < 1 ? (
            <div
              style={{
                position: "absolute",
                left: 0,
                bottom: 0,
                height: 3,
                width: `${progress * 100}%`,
                background: C.accent,
                boxShadow: `0 0 18px ${C.accent}`
              }}
            />
          ) : null}
          <div>
            <div style={{ color: C.fg, fontWeight: 720 }}>{row[0]}</div>
            <div style={{ color: C.muted, fontSize: 12 }}>Whisper ONNX</div>
          </div>
          <div style={{ color: C.fg2, fontFamily: C.mono, fontSize: 12 }}>{row[1]}</div>
          <div style={{ color: C.fg2, fontSize: 12 }}>{row[2]}</div>
          <SmallButton active={i === active || row[3] === "Ready"}>{row[3]}</SmallButton>
        </div>
      ))}
    </div>
  );
}

function SettingsPanel({
  title,
  children,
  width = 520,
  style
}: {
  title: string;
  children: ReactNode;
  width?: number;
  style?: CSSProperties;
}) {
  return (
    <Card
      style={{
        width,
        padding: 22,
        background: C.surface1,
        ...style
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div style={{ color: C.fg, fontSize: 22, fontWeight: 760 }}>{title}</div>
        <Dot color={C.success} />
      </div>
      {children}
    </Card>
  );
}

function SettingRowMini({
  label,
  value,
  active = false,
  accent = C.accent,
  progress
}: {
  label: string;
  value: string;
  active?: boolean;
  accent?: string;
  progress?: number;
}) {
  return (
    <div
      style={{
        position: "relative",
        minHeight: 54,
        padding: "11px 13px",
        borderRadius: 8,
        background: active ? `${accent}18` : C.surface2,
        border: `1px solid ${active ? `${accent}66` : C.borderSoft}`,
        overflow: "hidden"
      }}
    >
      {progress != null ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            height: 3,
            width: `${progress * 100}%`,
            background: accent
          }}
        />
      ) : null}
      <div style={{ color: C.fg, fontWeight: 650, fontSize: 14 }}>{label}</div>
      <div style={{ color: C.muted, fontSize: 12, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function FlowPacket({
  path,
  start = 0,
  duration = 80,
  color = C.accent
}: {
  path: [number, number][];
  start?: number;
  duration?: number;
  color?: string;
}) {
  const frame = useCurrentFrame();
  const p = ramp(frame, start, start + duration, Easing.bezier(0.45, 0, 0.55, 1));
  const segments = path.length - 1;
  const raw = p * segments;
  const index = Math.min(Math.floor(raw), segments - 1);
  const local = raw - index;
  const a = path[index];
  const b = path[index + 1];
  const x = interpolate(local, [0, 1], [a[0], b[0]]);
  const y = interpolate(local, [0, 1], [a[1], b[1]]);
  const op = hold(frame, start, start + 8, start + duration - 8, start + duration);
  return (
    <div
      style={{
        ...flowPacketBase,
        left: x,
        top: y,
        background: color,
        opacity: op,
        boxShadow: `0 0 22px ${color}`
      }}
    />
  );
}

function NodeBox({
  x,
  y,
  title,
  sub,
  active = false,
  color = C.accent
}: {
  x: number;
  y: number;
  title: string;
  sub: string;
  active?: boolean;
  color?: string;
}) {
  return (
    <div
      style={{
        ...nodeBoxBase,
        left: x,
        top: y,
        background: active ? `${color}18` : C.surface2,
        border: `1px solid ${active ? `${color}75` : C.borderSoft}`,
        boxShadow: active ? `0 0 34px ${color}22` : "none"
      }}
    >
      <div style={{ color: C.fg, fontWeight: 760, fontSize: 15 }}>{title}</div>
      <div style={{ color: C.muted, marginTop: 5, fontSize: 12, lineHeight: 1.25 }}>{sub}</div>
    </div>
  );
}

export function MainDemo() {
  const frame = useCurrentFrame();
  const textOp = hold(frame, 28, 44, 132, 154);
  return (
    <Stage label="Main window">
      <AppWindow title="WinSTT - local dictation">
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 30
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={wLogoBox}>
                W
              </div>
              <div>
                <div style={{ color: C.fg, fontSize: 31, fontWeight: 820, lineHeight: 1 }}>WinSTT</div>
                <div style={{ color: C.muted, fontSize: 13, marginTop: 3 }}>Offline speech to text</div>
              </div>
            </div>
            <Bars count={9} height={142} width={16} seed={0.4} />
            <div style={{ height: 54, opacity: textOp }}>
              <TranscriptLine text="Draft the reply and keep the tone concise." from={34} duration={52} />
            </div>
          </div>
          <MiniFooter hotkey="LCtrl+LMeta" mic="Microphone Array" model="tiny / DirectML" />
        </div>
      </AppWindow>
    </Stage>
  );
}

export function RecordingModeDemo({ mode }: { mode: Mode }) {
  const frame = useCurrentFrame();
  const accent = MODE[mode];
  const modeTitle = {
    ptt: "Push-to-Talk",
    toggle: "Toggle",
    listen: "Listen",
    wakeword: "Wake Word"
  }[mode];
  const captions = {
    ptt: ["Hold", "Speak", "Release"],
    toggle: ["Tap start", "Keep talking", "Tap stop"],
    listen: ["Capture output", "Live subtitles", "Speaker split"],
    wakeword: ["Say keyword", "Armed", "Paste"]
  }[mode];
  const pressed = mode === "ptt" ? frame < 80 : frame < 12 || (mode === "toggle" && frame > 132 && frame < 146);
  const overlayOp = mode === "ptt" ? hold(frame, 10, 22, 92, 112) : hold(frame, 18, 30, 142, 164);
  const outputOp = hold(frame, 112, 126, 999, 999);
  return (
    <Stage label={modeTitle}>
      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 42, alignItems: "center" }}>
        <Card style={{ padding: 28, minHeight: 392, background: C.surface1 }} glow>
          <PanelTitle eyebrow="Recording mode" title={modeTitle}>
            <Dot color={accent} />
          </PanelTitle>
          <div style={{ marginTop: 34, display: "flex", flexDirection: "column", gap: 18 }}>
            {mode === "listen" ? (
              <Pill accent={accent}>
                <span style={{ fontFamily: C.mono, color: accent }}>WASAPI</span>
                <Bars count={5} accent={accent} height={30} width={6} />
              </Pill>
            ) : mode === "wakeword" ? (
              <Pill accent={accent}>
                <span style={{ fontFamily: C.mono, color: accent }}>alexa</span>
                <Dot color={accent} />
              </Pill>
            ) : (
              <div style={{ display: "flex", gap: 9 }}>
                <Keycap pressed={pressed} accent={accent}>Ctrl</Keycap>
                <Keycap pressed={pressed} accent={accent}>{mode === "toggle" ? "Tap" : "Win"}</Keycap>
              </div>
            )}
            <ProgressSteps steps={captions} activeColor={accent} style={{ transform: "scale(0.84)", transformOrigin: "left top" }} />
          </div>
        </Card>
        <AppWindow title="Overlay preview" style={{ width: 690, height: 410 }}>
          <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 26 }}>
            <div
              style={{
                ...overlayPreviewBase,
                opacity: overlayOp,
                transform: `translateY(${mapRange(frame, [18, 34], [18, 0])}px)`,
                border: `1px solid ${accent}55`,
                boxShadow: `0 22px 70px rgba(0,0,0,0.4), 0 0 38px ${accent}22`
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ color: C.fg, fontWeight: 740 }}>{modeTitle}</div>
                <div style={{ color: C.muted, fontFamily: C.mono, fontSize: 12 }}>00:04</div>
              </div>
              <div style={{ marginTop: 17, display: "flex", alignItems: "center", gap: 22 }}>
                <Bars count={7} accent={accent} height={58} width={9} />
                <div style={{ color: C.fg2, fontSize: 19, minWidth: 260 }}>
                  {mode === "listen" ? (
                    <TypeText text="Speaker 1: let's ship it." from={44} duration={32} />
                  ) : mode === "wakeword" ? (
                    <TypeText text="Set a timer for ten minutes." from={56} duration={36} />
                  ) : (
                    <TypeText text="Meeting at three today." from={36} duration={34} />
                  )}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 22, height: 52, opacity: outputOp }}>
              <TranscriptLine
                text={mode === "listen" ? "Speaker 2: agreed, Friday." : "Meeting at 3 today."}
                from={118}
                duration={34}
                accent={accent}
              />
            </div>
          </div>
        </AppWindow>
      </div>
    </Stage>
  );
}

export function LlmDictationDemo() {
  const frame = useCurrentFrame();
  const rawOp = hold(frame, 5, 18, 58, 74);
  const aiOp = hold(frame, 62, 76, 112, 128);
  const cleanOp = hold(frame, 118, 132, 999, 999);
  return (
    <Stage label="LLM cleanup">
      <Card style={{ width: 860, padding: 34, background: C.surface1 }} glow>
        <PanelTitle eyebrow="Dictation cleanup" title="Raw words become paste-ready text" />
        <div style={{ marginTop: 42, display: "grid", gridTemplateColumns: "1fr 180px 1fr", gap: 20, alignItems: "center" }}>
          <div style={{ opacity: rawOp }}>
            <Label>Raw transcript</Label>
            <Pill style={{ marginTop: 14, width: "100%", justifyContent: "flex-start" }}>
              <TypeText text="um so the the meeting is at 3 pm i think" from={12} duration={38} />
            </Pill>
          </div>
          <div style={{ opacity: aiOp, display: "grid", placeItems: "center" }}>
            <AiProcessingCard />
          </div>
          <div style={{ opacity: cleanOp }}>
            <Label>Clean paste</Label>
            <TranscriptLine text="The meeting is at 3 PM." from={126} duration={26} style={{ marginTop: 14, width: "100%" }} />
          </div>
        </div>
      </Card>
    </Stage>
  );
}

function AiProcessingCard() {
  const frame = useCurrentFrame();
  return (
    <div style={aiProcessingCard}>
      {Array.from({ length: 25 }, (_, i) => {
        const x = (i % 5) * 24 + 22;
        const y = Math.floor(i / 5) * 24 + 22;
        const op = 0.16 + Math.max(0, Math.sin(frame * 0.18 + i * 0.6)) * 0.68;
        return (
          <span
            key={i}
            style={{
              ...aiProcessingDotBase,
              left: x,
              top: y,
              opacity: op
            }}
          />
        );
      })}
      <Pill style={{ padding: "8px 12px", fontSize: 13, fontFamily: C.mono }}>cleaning</Pill>
    </div>
  );
}

export function LlmTransformDemo() {
  const frame = useCurrentFrame();
  const select = hold(frame, 8, 18, 72, 86);
  const hotkey = hold(frame, 62, 72, 102, 116);
  const out = hold(frame, 116, 130, 999, 999);
  return (
    <Stage label="LLM transform">
      <AppWindow title="Any focused text box" style={{ width: 920, height: 500 }}>
        <div style={{ height: "100%", padding: 34, display: "flex", flexDirection: "column", justifyContent: "center", gap: 30 }}>
          <Card style={{ padding: 24, background: C.surface2, minHeight: 120 }}>
            <Label>Selected text</Label>
            <div style={{ marginTop: 16, color: C.fg2, fontSize: 24, lineHeight: 1.5 }}>
              hey can u send the file{" "}
              <span
                style={{
                  background: `rgba(74,131,255,${0.16 + select * 0.32})`,
                  borderRadius: 5,
                  color: C.fg,
                  padding: "1px 5px"
                }}
              >
                when ur free
              </span>
            </div>
          </Card>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, opacity: hotkey }}>
            <Keycap pressed={frame > 72 && frame < 94}>Ctrl</Keycap>
            <Keycap pressed={frame > 72 && frame < 94}>Shift</Keycap>
            <Keycap pressed={frame > 72 && frame < 94}>T</Keycap>
            <AiProcessingCard />
          </div>
          <div style={{ opacity: out, display: "flex", justifyContent: "center" }}>
            <TranscriptLine text="Could you send the file when you have a moment?" from={124} duration={42} />
          </div>
        </div>
      </AppWindow>
    </Stage>
  );
}

export function AutoSubmitDemo() {
  const frame = useCurrentFrame();
  const typed = frame < 88 ? 1 : 0.22;
  const send = hold(frame, 92, 106, 999, 999);
  const pressed = frame > 72 && frame < 86;
  return (
    <Stage label="Auto-submit">
      <Card style={{ width: 680, height: 470, padding: 26, background: C.surface1 }} glow>
        <PanelTitle eyebrow="Paste behavior" title="Dictate, paste, submit" />
        <div style={{ marginTop: 34, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ height: 150, display: "flex", justifyContent: "flex-end", alignItems: "flex-end" }}>
            <div
              style={{
                ...autoSubmitBubbleBase,
                opacity: send,
                transform: `translateY(${mapRange(frame, [92, 108], [24, 0])}px)`,
                boxShadow: `0 18px 44px ${C.accent}33`
              }}
            >
              See you in five.
            </div>
          </div>
          <Card style={{ padding: 14, background: C.surface2, opacity: typed }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ flex: 1, color: C.fg, fontSize: 20 }}>
                <TypeText text="See you in five." from={12} duration={24} />
              </div>
              <Keycap pressed={pressed}>Enter</Keycap>
            </div>
          </Card>
          <ProgressSteps steps={["Dictation lands", "Enter fires", "Message sent"]} />
        </div>
      </Card>
    </Stage>
  );
}

export function ReplaceDemo({ kind }: { kind: "dictionary" | "snippets" }) {
  const frame = useCurrentFrame();
  const accent = kind === "dictionary" ? C.success : C.accent;
  const swap = ramp(frame, 68, 98, Easing.bezier(0.45, 0, 0.55, 1));
  const before = kind === "dictionary" ? "a dash of wuster-sher sauce" : "send it to my address";
  const after = kind === "dictionary" ? "a dash of Worcestershire sauce" : "send it to 742 Evergreen Terrace";
  return (
    <Stage label={kind === "dictionary" ? "Dictionary" : "Snippets"}>
      <Card style={{ width: 900, padding: 34, background: C.surface1 }} glow>
        <PanelTitle
          eyebrow={kind === "dictionary" ? "Deterministic correction" : "Phrase expansion"}
          title={kind === "dictionary" ? "Misheard words are corrected" : "Short triggers expand inline"}
        />
        <div style={{ marginTop: 46, display: "grid", gridTemplateColumns: "1fr 86px 1fr", gap: 24, alignItems: "center" }}>
          <div style={{ opacity: 1 - swap * 0.35 }}>
            <Label>{kind === "dictionary" ? "Heard" : "You say"}</Label>
            <Card style={{ marginTop: 14, padding: 20, background: C.surface2 }}>
              <span style={{ color: C.fg, fontSize: 22 }}>
                {before.split(kind === "dictionary" ? "wuster-sher" : "my address")[0]}
                <span
                  style={{
                    color: kind === "dictionary" ? C.error : C.accent2,
                    textDecoration: kind === "dictionary" ? "line-through" : "none",
                    background: kind === "dictionary" ? "transparent" : C.accentSoft,
                    borderRadius: 5,
                    padding: kind === "dictionary" ? 0 : "1px 5px"
                  }}
                >
                  {kind === "dictionary" ? "wuster-sher" : "my address"}
                </span>
                {kind === "dictionary" ? " sauce" : ""}
              </span>
            </Card>
          </div>
          <div style={{ color: accent, fontFamily: C.mono, fontSize: 34, opacity: 0.35 + swap * 0.65, textAlign: "center" }}>
            -&gt;
          </div>
          <div style={{ opacity: 0.18 + swap * 0.82, transform: `scale(${0.96 + swap * 0.04})` }}>
            <Label>Pasted</Label>
            <Card style={{ marginTop: 14, padding: 20, background: `${accent}12`, borderColor: `${accent}66` }}>
              <span style={{ color: C.fg, fontSize: 22, fontWeight: 680 }}>{after}</span>
            </Card>
          </div>
        </div>
      </Card>
    </Stage>
  );
}

export function TranscribeFileDemo() {
  const frame = useCurrentFrame();
  const drop = ramp(frame, 8, 32);
  const progress = ramp(frame, 62, 122, Easing.bezier(0.45, 0, 0.55, 1));
  const output = ramp(frame, 124, 146);
  return (
    <Stage label="File transcription">
      <Card style={{ width: 840, padding: 34, background: C.surface1 }} glow>
        <PanelTitle eyebrow="Batch workflow" title="Drop audio, get a transcript beside it" />
        <div
          style={{
            ...dropZoneBase,
            border: `2px dashed ${drop < 1 ? C.accent : C.border}`,
            background: drop < 1 ? C.accentDim : C.surface2
          }}
        >
          <FileCard
            label="interview.mp3"
            sub="12:04 / 11 MB"
            badge="MP3"
            color={C.accent}
            style={{
              transform: `translateY(${interpolate(drop, [0, 1], [-72, 0])}px)`,
              opacity: drop
            }}
          />
          <div style={{ color: C.accent, fontFamily: C.mono, fontSize: 28, opacity: output }}>-&gt;</div>
          <FileCard
            label="interview.srt"
            sub="timestamped"
            badge="SRT"
            color={C.success}
            style={{
              opacity: output,
              transform: `scale(${0.88 + springIn(frame, 124, 180) * 0.12})`
            }}
          />
          <div
            style={{
              ...dropProgressTrackBase,
              opacity: frame > 54 && frame < 142 ? 1 : 0.24
            }}
          >
            <div style={{ width: `${progress * 100}%`, height: "100%", background: C.accent }} />
          </div>
        </div>
      </Card>
    </Stage>
  );
}

function FileCard({
  label,
  sub,
  badge,
  color,
  style
}: {
  label: string;
  sub: string;
  badge: string;
  color: string;
  style?: CSSProperties;
}) {
  return (
    <Card style={{ width: 250, padding: 16, background: C.surface1, ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
        <div style={{ ...fileCardBadge, background: color }}>
          {badge}
        </div>
        <div>
          <div style={{ color: C.fg, fontWeight: 720 }}>{label}</div>
          <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>{sub}</div>
        </div>
      </div>
    </Card>
  );
}

export function VisualizerDemo({ kind }: { kind: VisualKind }) {
  const title = {
    bar: "Bar visualizer",
    grid: "Grid visualizer",
    radial: "Radial visualizer",
    wave: "Wave visualizer",
    aura: "Aura visualizer"
  }[kind];
  return (
    <Stage label={title}>
      <Card style={{ width: 820, height: 458, padding: 30, background: C.surface1 }} glow>
        <PanelTitle eyebrow="Display" title={title}>
          <SmallButton active>{kind}</SmallButton>
        </PanelTitle>
        <div style={{ height: 300, display: "grid", placeItems: "center" }}>
          {kind === "bar" ? <Bars count={17} height={190} width={14} /> : null}
          {kind === "grid" ? <GridMeter /> : null}
          {kind === "radial" ? <RadialMeter /> : null}
          {kind === "wave" ? <WaveMeter /> : null}
          {kind === "aura" ? <AuraMeter /> : null}
        </div>
      </Card>
    </Stage>
  );
}

export function OverlayDemo({ kind }: { kind: "floating" | "island" }) {
  const frame = useCurrentFrame();
  const accent = C.accent;
  const text = kind === "floating" ? "Live preview follows your dictation." : "Thinking... finalizing text.";
  const open = hold(frame, 8, 24, 150, 174);
  return (
    <Stage label={kind === "floating" ? "Floating bottom overlay" : "Dynamic island overlay"} compact>
      <div style={overlayStageBox}>
        <div style={{ position: "absolute", inset: 0, opacity: 0.5 }}>
          {Array.from({ length: 12 }, (_, i) => (
            <div
              key={i}
              style={{
                ...overlayBgCardBase,
                left: 72 + i * 90,
                background: i % 3 === 0 ? C.surface3 : C.surface2
              }}
            />
          ))}
        </div>
        {kind === "floating" ? (
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: 32,
              display: "flex",
              gap: 12,
              opacity: open,
              transform: `translateX(-50%) translateY(${mapRange(frame, [8, 24], [26, 0])}px)`
            }}
          >
            <Pill accent={accent}>
              <Bars count={6} height={34} width={6} />
              <span style={{ fontFamily: C.mono, color: C.fg2 }}>00:04</span>
            </Pill>
            <Pill accent={accent} style={{ minWidth: 390 }}>
              <TypeText text={text} from={34} duration={52} />
            </Pill>
          </div>
        ) : (
          <div
            style={{
              ...overlayIslandBase,
              border: `1px solid ${accent}4d`,
              boxShadow: `0 22px 60px rgba(0,0,0,0.38), 0 0 38px ${accent}22`,
              opacity: open,
              transform: `translateX(-50%) translateY(${mapRange(frame, [8, 24], [-34, 0])}px)`
            }}
          >
            <div style={{ color: C.fg, textAlign: "center", fontSize: 18 }}>
              <TypeText text={text} from={34} duration={46} />
            </div>
            <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
              <Bars count={9} height={28} width={5} />
            </div>
          </div>
        )}
      </div>
    </Stage>
  );
}

export function DictationLoop() {
  const frame = useCurrentFrame();
  const nodes = [
    [40, 102, "Hotkey", "global trigger"],
    [300, 102, "Preview", "fast realtime model"],
    [560, 102, "Final pass", "accurate STT"],
    [820, 102, "Paste", "cursor delivery"]
  ] as const;
  return (
    <Stage label="Dictation loop">
      <Card style={{ width: 1040, height: 430, padding: 34, background: C.surface1, position: "relative" }} glow>
        <PanelTitle eyebrow="Core workflow" title="Record -> preview -> final text -> paste" />
        <div style={{ position: "relative", height: 240, marginTop: 34 }}>
          <svg width="100%" height="220" style={{ position: "absolute", left: 0, top: 20 }}>
            <path d="M127 124 C224 54 374 54 471 124 S721 194 818 124" fill="none" stroke={C.border} strokeWidth="4" strokeLinecap="round" />
            <path d="M127 124 C224 54 374 54 471 124 S721 194 818 124" fill="none" stroke={C.accent} strokeWidth="4" strokeLinecap="round" strokeDasharray="940" strokeDashoffset={940 - mapRange(frame, [18, 150], [0, 940])} />
          </svg>
          <FlowPacket path={[[127, 144], [471, 144], [818, 144]]} start={28} duration={116} />
          {nodes.map((node, i) => (
            <NodeBox key={node[2]} x={node[0]} y={node[1]} title={node[2]} sub={node[3]} active={frame > 18 + i * 34} />
          ))}
        </div>
      </Card>
    </Stage>
  );
}

export function ModelPickerFlow() {
  const frame = useCurrentFrame();
  const progress = ramp(frame, 62, 150, Easing.bezier(0.45, 0, 0.55, 1));
  return (
    <Stage label="Model picker">
      <AppWindow title="Settings - Model" style={{ width: 960, height: 560 }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", height: "100%" }}>
          <div style={{ borderRight: `1px solid ${C.divider}`, padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
            {["Whisper", "Moonshine", "Canary", "Cloud"].map((item, i) => (
              <SmallButton key={item} active={i === 0} style={{ justifyContent: "flex-start" }}>{item}</SmallButton>
            ))}
          </div>
          <div style={{ padding: 28 }}>
            <PanelTitle eyebrow="Main model" title="Pick speed, accuracy, and quantization" />
            <div style={{ marginTop: 26 }}>
              <ModelRows active={1} progress={progress} />
            </div>
            <div style={{ marginTop: 24, display: "flex", gap: 10 }}>
              {["Auto", "fp16", "int8", "q4"].map((q, i) => (
                <SmallButton key={q} active={i === (frame > 134 ? 1 : 0)}>{q}</SmallButton>
              ))}
            </div>
          </div>
        </div>
      </AppWindow>
    </Stage>
  );
}

export function AudioVadFlow() {
  const frame = useCurrentFrame();
  return (
    <Stage label="Audio and VAD">
      <Card style={{ width: 980, padding: 32, background: C.surface1 }} glow>
        <PanelTitle eyebrow="Audio pipeline" title="Device selection feeds dual voice detection" />
        <div style={{ marginTop: 36, display: "grid", gridTemplateColumns: "310px 1fr", gap: 34 }}>
          <SettingsPanel title="Audio" width={310} style={{ padding: 18 }}>
            <SettingRowMini label="Input device" value="Microphone Array" active />
            <SettingRowMini label="Silero sensitivity" value="0.70" active={frame > 44} progress={0.7} />
            <SettingRowMini label="WebRTC sensitivity" value="3 / strict gate" active={frame > 82} progress={0.82} />
          </SettingsPanel>
          <div style={{ position: "relative", height: 300 }}>
            <NodeBox x={0} y={104} title="Audio frames" sub="16 kHz mono buffer" active color={C.teal} />
            <NodeBox x={250} y={38} title="WebRTC VAD" sub="fast silence gate" active={frame > 40} color={C.accent} />
            <NodeBox x={250} y={172} title="Silero VAD" sub="neural voice check" active={frame > 76} color={C.success} />
            <NodeBox x={512} y={104} title="Endpoint" sub="speech only when both agree" active={frame > 112} color={C.success} />
            <FlowPacket path={[[174, 145], [250, 79], [512, 145]]} start={20} duration={100} color={C.accent} />
            <FlowPacket path={[[174, 145], [250, 213], [512, 145]]} start={46} duration={100} color={C.success} />
          </div>
        </div>
      </Card>
    </Stage>
  );
}

export function QualityPipeline() {
  const frame = useCurrentFrame();
  return (
    <Stage label="Processing">
      <Card style={{ width: 1010, padding: 32, background: C.surface1 }} glow>
        <PanelTitle eyebrow="Processing controls" title="Live preview, endpointing, context, paste" />
        <div style={{ marginTop: 38, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <SettingsPanel title="Realtime preview" width={450}>
            <SettingRowMini label="Update interval" value="0.02 s" active progress={0.72} />
            <SettingRowMini label="Init realtime after" value="0.20 s buffer" active={frame > 36} progress={0.35} />
            <SettingRowMini label="Early transcription on silence" value="0.20 s" active={frame > 72} progress={0.6} />
          </SettingsPanel>
          <SettingsPanel title="Paste pipeline" width={450}>
            <SettingRowMini label="Smart Endpoint" value="sentence classifier" active={frame > 38} />
            <SettingRowMini label="Context awareness" value="focused-window text" active={frame > 76} />
            <SettingRowMini label="Auto-submit" value="optional Enter after paste" active={frame > 116} />
          </SettingsPanel>
        </div>
      </Card>
    </Stage>
  );
}

export function IntegrationsSecrets() {
  const frame = useCurrentFrame();
  return (
    <Stage label="Integrations">
      <Card style={{ width: 1000, height: 500, padding: 32, background: C.surface1, position: "relative" }} glow>
        <PanelTitle eyebrow="Credentials" title="Keys verify in the backend and stay encrypted" />
        <div style={{ marginTop: 30, display: "grid", gridTemplateColumns: "420px 1fr", gap: 36 }}>
          <SettingsPanel title="External integrations" width={420}>
            <SettingRowMini label="Ollama endpoint" value="http://localhost:11434" active />
            <SettingRowMini label="OpenAI API key" value="Verified" active={frame > 44} accent={C.success} />
            <SettingRowMini label="ElevenLabs API key" value="Cloud STT ready" active={frame > 78} accent={C.success} />
            <SettingRowMini label="OpenRouter API key" value="LLM cleanup ready" active={frame > 112} accent={C.success} />
          </SettingsPanel>
          <div style={{ position: "relative", height: 330 }}>
            <NodeBox x={0} y={120} title="Renderer UI" sub="status only" active />
            <NodeBox x={252} y={120} title="Rust backend" sub="verifies keys" active={frame > 48} color={C.success} />
            <NodeBox x={252} y={12} title="Secret store" sub="DPAPI sealed" active={frame > 88} color={C.success} />
            <NodeBox x={504} y={120} title="Provider" sub="HTTPS request" active={frame > 124} color={C.accent} />
            <FlowPacket path={[[174, 161], [252, 161], [426, 161], [504, 161]]} start={42} duration={100} color={C.success} />
            <FlowPacket path={[[339, 120], [339, 54]]} start={82} duration={54} color={C.success} />
          </div>
        </div>
      </Card>
    </Stage>
  );
}

export function TtsVoiceFlow() {
  const frame = useCurrentFrame();
  const wave = hold(frame, 112, 126, 999, 999);
  return (
    <Stage label="Text-to-Speech">
      <Card style={{ width: 980, padding: 32, background: C.surface1 }} glow>
        <PanelTitle eyebrow="On-device Kokoro" title="Selected text becomes local speech" />
        <div style={{ marginTop: 40, display: "grid", gridTemplateColumns: "330px 1fr", gap: 34, alignItems: "center" }}>
          <SettingsPanel title="Voice" width={330}>
            <SettingRowMini label="Text-to-Speech" value="Enabled" active />
            <SettingRowMini label="Voice" value="Heart / en-us" active={frame > 36} />
            <SettingRowMini label="Speed" value="1.0x" active={frame > 72} progress={0.5} />
          </SettingsPanel>
          <div style={{ display: "flex", flexDirection: "column", gap: 24, alignItems: "center" }}>
            <Card style={{ width: 520, padding: 24, background: C.surface2 }}>
              <Label>Selected text</Label>
              <div style={{ marginTop: 14, color: C.fg, fontSize: 24 }}>
                <TypeText text="Read this paragraph aloud." from={16} duration={34} />
              </div>
            </Card>
            <ProgressSteps steps={["Capture", "Synthesize", "Play"]} activeColor={C.success} />
            <div style={{ opacity: wave }}>
              <WaveMeter accent={C.success} />
            </div>
          </div>
        </div>
      </Card>
    </Stage>
  );
}

export function HistoryPlayback() {
  const frame = useCurrentFrame();
  const karaoke = ramp(frame, 104, 168, Easing.linear);
  const words = ["The", "meeting", "is", "at", "3", "PM."];
  const activeWord = Math.floor(karaoke * words.length);
  return (
    <Stage label="Transcription history">
      <AppWindow title="Settings - Transcription History" style={{ width: 980, height: 560 }}>
        <div style={{ padding: 26 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            <StatTile value="1,250" label="Transcriptions" />
            <StatTile value="48.3k" label="Words" />
            <StatTile value="3h 12m" label="Speaking time" />
            <StatTile value="151" label="WPM" />
          </div>
          <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "330px 1fr", gap: 22 }}>
            <Card style={{ padding: 16, background: C.surface2 }}>
              <Label>Activity</Label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(14, 15px)", gap: 5, marginTop: 14 }}>
                {Array.from({ length: 84 }, (_, i) => {
                  const level = (i * 7 + 3) % 5;
                  const lit = frame > 20 + i * 0.7;
                  return (
                    <span
                      key={i}
                      style={{
                        width: 15,
                        height: 15,
                        borderRadius: 4,
                        background: lit ? `rgba(74,131,255,${0.08 + level * 0.13})` : C.surface3,
                        border: `1px solid ${C.borderSoft}`
                      }}
                    />
                  );
                })}
              </div>
            </Card>
            <Card style={{ padding: 18, background: C.surface2 }}>
              <Label>Playback row</Label>
              <div style={{ marginTop: 16, display: "flex", gap: 14, alignItems: "center" }}>
                <SmallButton active>Play</SmallButton>
                <div style={{ color: C.fg, fontSize: 23, lineHeight: 1.5 }}>
                  {words.map((word, i) => (
                    <span
                      key={word}
                      style={{
                        background: i <= activeWord ? C.accentSoft : "transparent",
                        color: i <= activeWord ? C.fg : C.fg2,
                        borderRadius: 5,
                        padding: "1px 4px",
                        marginRight: 3
                      }}
                    >
                      {word}
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 24, height: 6, borderRadius: 999, background: C.surface4, overflow: "hidden" }}>
                <div style={{ width: `${karaoke * 100}%`, height: "100%", background: C.accent }} />
              </div>
            </Card>
          </div>
        </div>
      </AppWindow>
    </Stage>
  );
}

export function ArchitectureFlow() {
  const frame = useCurrentFrame();
  return (
    <Stage label="Architecture">
      <Card style={{ width: 1040, height: 470, padding: 32, background: C.surface1, position: "relative" }} glow>
        <PanelTitle eyebrow="Tauri port" title="React renderer talks to one in-process Rust backend" />
        <div style={{ position: "relative", height: 310, marginTop: 28 }}>
          <NodeBox x={20} y={116} title="React UI" sub="multi-window renderer" active color={C.accent} />
          <NodeBox x={274} y={44} title="Commands" sub="typed request/response" active={frame > 36} color={C.teal} />
          <NodeBox x={274} y={188} title="Events" sub="Rust pushes updates" active={frame > 70} color={C.teal} />
          <NodeBox x={536} y={116} title="Rust managers" sub="audio, STT, TTS, history" active={frame > 92} color={C.success} />
          <NodeBox x={790} y={44} title="ONNX Runtime" sub="local inference" active={frame > 122} color={C.success} />
          <NodeBox x={790} y={188} title="Settings store" sub="local persistence" active={frame > 138} color={C.success} />
          <FlowPacket path={[[194, 157], [274, 85], [536, 157], [790, 85]]} start={24} duration={120} color={C.teal} />
          <FlowPacket path={[[790, 229], [536, 157], [274, 229], [194, 157]]} start={72} duration={104} color={C.success} />
        </div>
      </Card>
    </Stage>
  );
}
