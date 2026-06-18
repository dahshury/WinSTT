#![expect(
    clippy::derivable_impls,
    reason = "explicit Default impls document the settings-schema defaults"
)]

mod defaults;
mod store;
mod types;

// Preserve the existing flat public surface (`crate::settings::X`) after splitting
// the module into types / defaults / store submodules. The `default_*` free
// functions in `defaults` stay private to this module (they are only referenced
// by serde attributes in `types` and by `store::get_default_settings`).
pub use store::*;
pub use types::*;
