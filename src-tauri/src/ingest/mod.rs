//! Ingesters normalize agent-specific records into the unified model as early as
//! possible. Each adapter owns its own source discovery + live tail; the store
//! and UI never see agent-specific shapes.

pub mod claude_code;
pub mod opencode;
pub mod opencode_cold;
