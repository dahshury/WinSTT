use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};

// Define the response structure from Swift
#[repr(C)]
pub struct AppleLLMResponse {
    pub response: *mut c_char,
    pub success: c_int,
    pub error_message: *mut c_char,
}

// Link to the Swift functions.
unsafe extern "C" {
    pub fn is_apple_intelligence_available() -> c_int;
    pub fn free_apple_llm_response(response: *mut AppleLLMResponse);
}

// Safe wrapper functions
pub fn check_apple_intelligence_availability() -> bool {
    // SAFETY: the Swift bridge exposes a nullary availability probe with no
    // ownership transfer or pointer arguments.
    unsafe { is_apple_intelligence_available() == 1 }
}

// Link to the Swift function for system prompt support.
unsafe extern "C" {
    pub fn process_text_with_system_prompt_apple(
        system_prompt: *const c_char,
        user_content: *const c_char,
        max_tokens: i32,
    ) -> *mut AppleLLMResponse;
}

/// Process text with Apple Intelligence using separate system prompt and user content
pub fn process_text_with_system_prompt(
    system_prompt: &str,
    user_content: &str,
    max_tokens: i32,
) -> Result<String, String> {
    let system_cstr = CString::new(system_prompt).map_err(|e| e.to_string())?;
    let user_cstr = CString::new(user_content).map_err(|e| e.to_string())?;

    // SAFETY: `system_cstr` and `user_cstr` are valid NUL-terminated strings
    // that outlive the call. The returned pointer is checked for null and
    // released exactly once with `free_apple_llm_response` below.
    let response_ptr = unsafe {
        process_text_with_system_prompt_apple(system_cstr.as_ptr(), user_cstr.as_ptr(), max_tokens)
    };

    if response_ptr.is_null() {
        return Err("Null response from Apple LLM".to_string());
    }

    // SAFETY: `response_ptr` was checked for null and is owned by the Swift
    // bridge until we free it at the end of this function.
    let response = unsafe { &*response_ptr };

    let result = if response.success == 1 {
        if response.response.is_null() {
            Ok(String::new())
        } else {
            // SAFETY: on success the Swift bridge returns a valid
            // NUL-terminated response string or null, handled above.
            let c_str = unsafe { CStr::from_ptr(response.response) };
            let rust_str = c_str.to_string_lossy().into_owned();
            Ok(rust_str)
        }
    } else {
        let error_msg = if !response.error_message.is_null() {
            // SAFETY: on failure the Swift bridge returns a valid
            // NUL-terminated error string or null, handled by the fallback.
            let error_c_str = unsafe { CStr::from_ptr(response.error_message) };
            error_c_str.to_string_lossy().into_owned()
        } else {
            "Unknown error".to_string()
        };
        Err(error_msg)
    };

    // SAFETY: `response_ptr` came from the Swift bridge and has not been freed.
    unsafe { free_apple_llm_response(response_ptr) };

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_availability() {
        let available = check_apple_intelligence_availability();
        println!("Apple Intelligence available: {}", available);
    }
}
