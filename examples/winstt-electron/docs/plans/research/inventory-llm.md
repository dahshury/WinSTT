# LLM Post-Processing Inventory

## Dictation

### Toggle
- Setting: llm.dictation.enabled
- Default: Off
- Mutual exclusion with Smart Endpoint

### Provider
- Setting: llm.dictation.provider
- Options: Ollama, OpenRouter, Apple Intelligence
- Default: ollama

### Model (Ollama)
- Setting: llm.dictation.model
- Required
- Hardware fit assessment

### Thinking Effort (Ollama)
- Setting: llm.dictation.thinkingEffort
- Options: Off, Low, Medium, High
- Default: Medium
- Conditional: only if model supports thinking

### Model (OpenRouter)
- Setting: llm.dictation.openrouterModel
- Optional fallback: llm.dictation.openrouterFallbackModel

### Reasoning/Verbosity/MaxTokens (OpenRouter)
- reasoningEffort: Low/Medium/High (default Medium)
- verbosity: Low/Medium/High (default Medium)
- maxOutputTokens: null (no limit)

## Dictation Tone & Modifiers

### Tone (mutually exclusive)
- neutral (Polish base only)
- formal
- friendly
- technical
- casual
- Setting: llm.dictation.presets

### Independent Modifiers
- summarize (Light/Medium/High)
- concise (Light/Medium/High)
- reorder (no levels)
- restructure (no levels)
- rewordForClarity (no levels)
- translate (language picker)

### Custom Modifiers
- Setting: llm.dictation.customModifiers
- User-authored with optional levels
- Scroll at 7+ rows

## Dictation Context

### Context Awareness
- Setting: general.contextAwareness
- Hidden when dictation LLM unconfigured

### Deny-List
- Setting: general.contextDenyList
- Entry types: exe names or URL hosts
- Default seed: 6 password managers

## Dictation Warmup Banner
- Ollama only
- Three outcomes: unreachable, model missing, load failed
- Never auto-disables; shows inline action

## Dictation Playground
- Test composed prompt
- No clipboard side effects

## Transforms

Identical to Dictation for provider/model/thinking/tone/modifiers.

### Global Hotkey
- Setting: llm.transforms.hotkey
- Default: empty (no hotkey)

### Custom Transform Prompts
- Setting: llm.transforms.prompts
- Per-transform optional hotkey
- Built-in transforms can reset

### Transform Playground
- Editable prompt textarea
- Per-transform state

## Shared

### Ollama Endpoint
- Setting: llm.endpoint
- Default: http://localhost:11434

### OpenRouter API Key
- Setting: llm.openrouterApiKey
- Encrypted (DPAPI)
- Never sent to renderer

### LLM Timeout
- Setting: llm.timeout
- Range: 1000-30000 ms
- Default: 5000
- NOTE: persisted but NOT enforced

## Preset Composition

- Polish base: universal foundation, included once per prompt
- Tone + modifiers: layered on top
- Translate: always last
- Custom modifier: single prompt + per-level intensity hint
- Schema clamp: appended to every preset prompt

## Gotchas

1. Mutual exclusion with Smart Endpoint
2. Level memory: re-enabling restores last level
3. Context visibility: sections vanish when LLM unconfigured
4. Warmup banner: never disables toggle
5. Custom persistence: disabled modifiers persist until deleted
6. Thinking detection: only shows if model advertises
7. Playground state: transient
8. Fallback: cannot duplicate primary model
9. Provider reset: switching provider resets model
10. Hotkey conflicts: no UI validation for per-transform hotkeys

## Controls Summary

**Dictation:** Toggle, provider, model, thinking/reasoning/verbosity/max-output, tone (1 of 5), 6 built-in modifiers (some with levels), unlimited custom modifiers, context awareness, context deny-list, playground.

**Transforms:** Same as dictation plus global hotkey, unlimited custom transform prompts (each with optional hotkey).

**Shared:** Ollama endpoint, OpenRouter API key, LLM timeout.

**Key Numbers:** 11 built-in presets, 100+ languages for translate, max context 150K chars, deny-list seed 6, scroll threshold 7, timeout 1000-30000 (default 5000).
