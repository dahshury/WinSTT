# WinSTT CPAL patch

This directory vendors CPAL 0.17.1.

WinSTT's Windows capture path sets `AudioCategory_Communications` through
`IAudioClient2::SetClientProperties` immediately after activating the client,
before mix-format discovery, format negotiation, or WASAPI initialization. The
recording chime already uses the same category. Matching the two clients
prevents Windows from seeing them as unrelated audio scenarios when a
Bluetooth LE microphone and renderer are active together.

The patch is limited to WASAPI input clients. CPAL output behavior and all
non-Windows backends are unchanged.
