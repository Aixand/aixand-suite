//! Node-API entry point for the read-only Windows authentication ACL check.
use std::ffi::c_void;

#[cfg(windows)]
unsafe extern "C" {
    fn aixand_auth_init(env: *mut c_void, exports: *mut c_void) -> *mut c_void;
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_register_module_v1(
    env: *mut c_void,
    exports: *mut c_void,
) -> *mut c_void {
    #[cfg(windows)]
    unsafe {
        aixand_auth_init(env, exports)
    }
    #[cfg(not(windows))]
    {
        let _ = (env, exports);
        std::ptr::null_mut()
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn node_api_module_get_api_version_v1() -> i32 {
    8
}
