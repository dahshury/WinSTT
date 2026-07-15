/**
 * Single source of truth for the STT picker's outer width. Both the inline
 * picker hosted in the detached BrowserWindow (`ModelPickerWindow`) and the
 * floating popup attached to the trigger in the Settings → Model tab read
 * from these constants, so the two surfaces always render at the same
 * pixel width — there is no "main is wider than settings" drift.
 *
 * Tailwind v4's JIT can't read constants inside template literals, so we
 * ship the class string as a static literal and keep it co-located here.
 * If you bump the px number, bump the class string in lockstep.
 */
export const STT_PICKER_WIDTH_PX = 600;
export const STT_PICKER_WIDTH_CLASS = "w-[600px]";
