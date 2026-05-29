# OpenWhispr Documentation Analysis

## Repository Context
- **Project**: OpenWhispr (Electron Whisper app for cross-platform voice-to-text)
- **Source**: https://github.com/OpenWhispr/openwhispr
- **Doc Format**: README-first pattern with external hosted docs site (docs.openwhispr.com)
- **In-Repo Docs**: Minimal (only `docs/network-allowlist.md` for enterprise/firewall config)

---

## 1. Information Architecture & Section Order

### README Structure (Primary Asset)
1. Logo + Centered Hero (visual branding)
2. Title + Tagline (h1 centered with description)
3. Status Badges (license, platforms, latest release, downloads, stars)
4. Quick Links Bar (Website | Docs | Download | API | Changelog)
5. Opening Pitch (2 sentences on value prop)
6. Download Table (platform-specific links, clear visual format)
7. Features List (unordered list, bullet points with bold feature names)
8. Quick Start (bash code block)
9. Documentation Portal Links
10. Tech Stack (single-line list)
11. Star History (embedded chart image)
12. Sponsors (logo + description)
13. Contributing
14. License
15. Acknowledgments (extensive list with descriptions)

---

## 2. Hero & Opening Pitch Technique

**Pattern: Comparison-Based Value Prop**
- Line 1: "The open-source and free alternative to WisprFlow and Granola."
- Line 2: "Privacy-first voice-to-text dictation with AI agents, meeting transcription, and notes. Cross-platform for macOS, Windows, and Linux."

**Key Techniques**:
- Opens with direct competitor comparison
- Emphasizes privacy-first as core differentiator
- Lists top 3-4 use cases in one sentence
- Mentions cross-platform support
- Uses "open-source and free" as anchor

---

## 3. Visual Patterns & Presentation Techniques

### Badge Usage
- License, Platform, Release, Downloads, Stars
- All centered, shields.io style, grouped and clickable

### Tables
- Download Table: 2-column (Platform | Download)
- Network Allowlist: 4-column (Host | Protocol | Port | Purpose)

### Visual Assets
- Logo: SVG, centered (120px)
- Star History: Embedded chart
- Sponsor Logo: Dark/light variants (250px)

### Code Examples
- Quick Start bash block
- Network testing curl commands

### No Screenshots/GIFs in Main README
- Relies on external docs site for visual walkthroughs

---

## 4. Tone & Voice

| Aspect | Pattern |
|--------|----------|
| Register | Technical + accessible |
| Audience | Developers and power users |
| Emphasis | Outcomes over implementation |
| Authenticity | Direct, matter-of-fact |
| Social Proof | Implicit (badges, counts) |
| Privacy | Consistently threaded |

**Example Phrasing**:
- "Press a hotkey, speak, and your words appear at your cursor"
- "your audio never leaves your device"
- "No data collection, no telemetry, fully open source"

---

## 5. Most Stealable Patterns

1. **Competitor comparison as hero** - Position against known alternatives in opening
2. **Bold feature names + benefit** - Each bullet leads with action word then plain-English benefit
3. **"Your choice" positioning** - "local or cloud — your choice" removes false binary
4. **Platform-specific download table** - Show exact formats (.dmg, .exe, .deb, etc.)
5. **Tech stack one-liner** - Credibility signal without bloat
6. **Extensive acknowledgments with links** - Shows respect for ecosystem
7. **Shields.io badges** - Clickable social proof
8. **External docs reference** - Keep README lean, detailed docs on separate site

---

## 6. Patterns to AVOID

- Over-explanation / architecture diagrams in README
- Marketing buzzwords ("revolutionary," "cutting-edge")
- Dense feature lists without context
- Full API docs embedded in README
- Outdated screenshots/GIFs (they date quickly)
- Unclear CTAs (each section needs an action)

---

## 7. Key Takeaways for WinSTT

1. **Hero Pattern**: Open with competitor comparison or market position
2. **Feature Bullets**: Bold action words + benefit description
3. **Flexibility Positioning**: "your choice" for local vs. cloud parity
4. **Tech Stack Signal**: One-line list for credibility
5. **Table Over Prose**: Use tables for downloads/requirements
6. **Keep README Focused**: Detailed docs → external site
7. **Social Proof**: Badges, counts, logos (implicit credibility)
8. **Acknowledgments**: Link to dependencies (respect + ecosystem goodwill)
9. **Platform Details**: Show exact download format
10. **Privacy Reassurance**: Thread through opening pitch, features, AND external docs

---

## Additional Notes

- Minimalist repo docs (only network-allowlist.md)
- Single GitHub README (no variants)
- External docs hosted separately
- Sponsor integration subtle, not intrusive
- i18n in code, not docs (English-only README)
