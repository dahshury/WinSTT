# Epicenter Documentation Analysis: Patterns for WinSTT Docs Overhaul

## Information Architecture & Page Structure

### Root README Organization
- Hero: logo + 1-line pitch + description + badges (stars, version, license, Discord, OS platforms)
- Inline TOC nav: Apps, Architecture, Packages, For Developers, Quick Start, Contributing, Discord
- Progressive disclosure: concept → architecture → products → developer → getting started
- Tech stack badges section (8 colored: Svelte, Tauri, TypeScript, Rust, Yjs, Cloudflare, Tailwind)
- Design decision specs table with RFC timestamps
- License explaining split licensing (MIT clients, AGPL server)

### Section Sequencing (Key Learning)
1. Hero (logo, name, 1-line pitch, description, badges)
2. What is this? (philosophy: open, local-first, modifiable)
3. Architecture (diagram + linked reference docs)
4. Products/Apps (2x3 table: name, description, action links)
5. Packages (table: name, description, license)
6. For Developers (concept + code example)
7. Where Headed (vision paragraph, not detailed roadmap)
8. Quick Start (installation, build, troubleshooting)
9. Contributing (link to guide)
10. Tech Stack (badge gallery)
11. Design Decisions (RFC-style specs table)
12. Footer (contact, Discord, Twitter)

---

## Hero & Opening Pitch Technique

### Root Repository Hero
[Logo] → [h1] Name → [p] Category/One-liner → [p] Elevator pitch (3 lines: ownership, format, capability)

### App-Level Hero (Whispering)
[Logo] → [h1] Full Name → [p] Action + outcome + emotion ("Press shortcut → speak → get text. Free and open source ❤")

### Value Prop Structure
- Personal motivation story ("I built this because...")
- Honest context ("Companies pivot. Open source is forever.")
- Concrete cost table (per-hour → monthly → vs incumbents)
- Transparent limitations ("Designed for quick transcriptions, not long recordings")

---

## Visual Patterns

### Badges (flat-square, color-coded)
- Platform: macOS=black, Windows=blue, Linux=yellow
- Status: stars, version (brightgreen), license, Discord (5865F2)
- Tech: Svelte=orange, TypeScript=blue, Rust=orange, Yjs=green, Cloudflare=F38020, Tailwind=38B2AC
- Layout: centered, multi-row, clickable

### Tables
1. Apps grid (2x3): [h3] App Name | description (2-3 sentences) | [Strong] Source . Install . Try
2. Packages: name | description | license
3. Design specs: spec (with RFC timestamp) | impact/purpose
4. Cost comparison: service | per-hour | light/moderate/heavy use | vs incumbents

### Diagrams (ASCII preferred over SVG)
- Dependency flow (Apps → Middleware → Core, vertical)
- Architecture boxes (┌─┐ boxes, vertical flow)
- Write/Read flow (Y.Doc → multiple outputs)
- Key hierarchy (ENCRYPTION_SECRETS → user key → workspace key)

### Code Examples
- Inline blocks for quick reference
- Multi-step progression (define → create → extend → sync)
- Annotated comments

---

## Tone & Voice

### Characteristics
1. Transparent + Personal: "I built this because...", ❤, honest limitations
2. Technical but Approachable: Uses precise terms, explains why
3. Anti-jargon: "dumb server, smart client" not "resilient architecture"
4. Concrete > Abstract: Code before explanation
5. Inclusive: "New to open source? Here's a video."
6. Honest + Enthusiastic: "We're hoping..." + upfront limitations

### Callout Boxes
- > [!TIP] for usage guidance
- > [!NOTE] for clarifications

### Writing Rules
- Explain what before how
- Footnote-style context: "local-first (data on your device)"
- Link context: "[`@epicenter/workspace`](packages/workspace)"
- Let data speak; avoid superlatives

---

## Standout Patterns Worth Stealing

### 1. Define-Create-Extend-Sync Lifecycle
Decompose architecture by semantic intent. Each stage: explanation + code example.
Stealable: Break features into stages (recognize → load → extend → stream).

### 2. Cost Comparison Table
Per-hour pricing → monthly costs at usage tiers → vs competitors.
Stealable: Concretize savings with similar table format.

### 3. Architecture as Dependency Diagram
Root README: 10-second visual overview. Detailed docs: 10-minute walkthrough. No gap.
Stealable: Show architecture diagram in README, link to detailed docs.

### 4. App Showcase Grid (Not Prose Lists)
Visual table: Name | description (2-3 sentences) | action links.
Stealable: Format features/modules as visual grid, not bullets.

### 5. Tech Stack as Badge Gallery (Not Text List)
Colored badges (scannable, linkable) not bulleted text.
Stealable: Use similar badge styling for your tech stack.

### 6. RFC-Style Design Decision Specs
Timestamp | Spec name | why this approach | alternatives considered.
Stealable: Document architectural choices RFC-style explaining reasoning.

### 7. Prefix Vocabulary Table
Document naming patterns (define* = pure, attach* = mutate, create* = construct).
Stealable: Document API naming conventions in vocab table.

### 8. Progressive Disclosure with Arrows
Every concept links deeper: "Full documentation →"
Stealable: Use consistent "→" to signal deeper docs.

### 9. Inline Navigation Bar (TOC)
Centered link bar after hero: [Apps] . [Architecture] . [Packages] ...
Stealable: Add similar TOC nav bar after hero section.

### 10. Roadmap as Narrative Paragraph
3-sentence explanation of direction + philosophy. Skip detailed tables.
Stealable: Use narrative paragraph before detailed roadmap.

---

## Patterns to AVOID

1. Hyperbole without data (avoid "fastest"; show benchmarks)
2. Overwhelming feature lists (hero use case → 2-3 features → stop)
3. Jargon-heavy explanations (explain benefit first, then tech)
4. Disconnected README + docs (link coherently, use consistent terminology)
5. Weak value props (lead with why, not feature count)

---

## Key Takeaways for WinSTT

1. Progressive disclosure structure (hero → concept → architecture → products → developer → getting started)
2. Visual hierarchy (badges for metadata, tables for catalogs, ASCII diagrams, code for examples)
3. Decomposable architecture (clear stages with examples)
4. Link everything with "→ Read more" progression
5. Be honest about limitations (builds credibility)
6. Show tradeoffs concretely (tables beat prose)
7. Explain why before how (philosophy → architecture → code)
8. Consistent navigation (inline TOC + header anchors)
9. Document naming conventions (API prefix vocabulary)
10. Narrative framing beats abstract philosophy (tell the story)

