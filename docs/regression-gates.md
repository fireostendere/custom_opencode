# Critical regression gates

The clean regression workflow must keep these user-visible paths covered:

- packaged OpenCode V2 TUI bundle loads without plugin/renderer errors at 80x24, 120x30 and 160x40;
- TUI model selector opens through the native dialog contract and exercises categories, favorites, variants, `switchModel`, reopen and home-session creation;
- TUI add/server/webserver wizards, validation and `/panel` submit routing remain mandatory gates;
- production Chromium smoke covers desktop/mobile composition and modal-history behavior;
- critical web controls create and stay on the requested new session, then switch and persist the requested model;
- full browser fixture covers queue delivery across `running -> idle`, including overlapping status refreshes. Older status snapshots must never overwrite a newer status and strand a queued prompt.

These checks are intentionally split between a real packaged runtime smoke and deterministic behavior fixtures: the GitHub Actions PTY is not a reliable source of OpenTUI selection key events, while the packaged loader is still required to catch runtime renderer failures such as `No renderer found` / `useRenderer`.
