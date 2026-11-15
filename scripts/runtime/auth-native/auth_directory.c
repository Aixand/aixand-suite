/* Read-only NTFS validation. No permission results are cached.
 * Node-API v8: https://nodejs.org/api/n-api.html
 * Resolve the small stable ABI from the running Node executable, avoiding a
 * Node-version-specific import library or third-party runtime dependency.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <stdlib.h>
#include <wchar.h>

typedef void *napi_env;
typedef void *napi_value;
typedef void *napi_callback_info;
typedef napi_value (__cdecl *napi_callback)(napi_env, napi_callback_info);
typedef int (__cdecl *get_cb_info_fn)(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
typedef int (__cdecl *get_string_fn)(napi_env, napi_value, wchar_t *, size_t, size_t *);
typedef int (__cdecl *throw_error_fn)(napi_env, const char *, const char *);
typedef int (__cdecl *get_undefined_fn)(napi_env, napi_value *);
typedef int (__cdecl *create_function_fn)(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
typedef int (__cdecl *set_property_fn)(napi_env, napi_value, const char *, napi_value);

static get_cb_info_fn get_cb_info;
static get_string_fn get_string;
static throw_error_fn throw_error;
static get_undefined_fn get_undefined;
static create_function_fn create_function;
static set_property_fn set_property;
static INIT_ONCE api_once = INIT_ONCE_STATIC_INIT;

static BOOL CALLBACK load_api(PINIT_ONCE once, PVOID parameter, PVOID *context) {
    HMODULE node = GetModuleHandleW(NULL);
    (void)once; (void)parameter; (void)context;
    get_cb_info = (get_cb_info_fn)GetProcAddress(node, "napi_get_cb_info");
    get_string = (get_string_fn)GetProcAddress(node, "napi_get_value_string_utf16");
    throw_error = (throw_error_fn)GetProcAddress(node, "napi_throw_error");
    get_undefined = (get_undefined_fn)GetProcAddress(node, "napi_get_undefined");
    create_function = (create_function_fn)GetProcAddress(node, "napi_create_function");
    set_property = (set_property_fn)GetProcAddress(node, "napi_set_named_property");
    return get_cb_info && get_string && throw_error && get_undefined && create_function && set_property;
}

static int drive(wchar_t value) {
    return (value >= L'A' && value <= L'Z') || (value >= L'a' && value <= L'z');
}

static size_t root_length(const wchar_t *path, size_t length) {
    size_t start = 0, index;
    if (length >= 3 && drive(path[0]) && path[1] == L':' && path[2] == L'\\') return 3;
    if (length >= 7 && wcsncmp(path, L"\\\\?\\", 4) == 0 && drive(path[4]) && path[5] == L':' && path[6] == L'\\') return 7;
    if (length >= 8 && _wcsnicmp(path, L"\\\\?\\UNC\\", 8) == 0) start = 8;
    else if (length >= 2 && path[0] == L'\\' && path[1] == L'\\' && path[2] != L'?' && path[2] != L'.') start = 2;
    if (!start) return 0;
    index = start;
    while (index < length && path[index] != L'\\') index++;
    if (index == start || index == length) return 0;
    start = ++index;
    while (index < length && path[index] != L'\\') index++;
    return index > start ? index : 0;
}

static int open_directory(wchar_t *path, size_t end, HANDLE *handles, size_t *count) {
    wchar_t saved = path[end];
    BY_HANDLE_FILE_INFORMATION info;
    HANDLE handle;
    path[end] = 0;
    /* Ancestors stay pinned against rename/replacement until ACL validation
     * completes. OPEN_REPARSE_POINT inspects each component before traversal. */
    handle = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    path[end] = saved;
    if (handle == INVALID_HANDLE_VALUE) return 0;
    handles[(*count)++] = handle;
    if (!GetFileInformationByHandle(handle, &info)) return 0;
    return (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT);
}

static int private_acl(HANDLE directory) {
    HANDLE token = NULL;
    TOKEN_USER *user = NULL;
    DWORD size = 0, index;
    PSID owner = NULL;
    PACL acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    int valid = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto cleanup;
    GetTokenInformation(token, TokenUser, NULL, 0, &size);
    if (!size || !(user = (TOKEN_USER *)malloc(size))) goto cleanup;
    if (!GetTokenInformation(token, TokenUser, user, size, &size)) goto cleanup;
    if (GetSecurityInfo(directory, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &owner, NULL, &acl, NULL, &descriptor) != ERROR_SUCCESS) goto cleanup;
    if (!owner || !acl || !EqualSid(owner, user->User.Sid)) goto cleanup;
    for (index = 0; index < acl->AceCount; index++) {
        ACE_HEADER *ace = NULL;
        if (!GetAce(acl, index, (void **)&ace)) goto cleanup;
        if (ace->AceType == ACCESS_ALLOWED_ACE_TYPE) {
            ACCESS_ALLOWED_ACE *allow = (ACCESS_ALLOWED_ACE *)ace;
            if (!EqualSid((PSID)&allow->SidStart, user->User.Sid)) goto cleanup;
        } else if (ace->AceType != ACCESS_DENIED_ACE_TYPE) goto cleanup;
    }
    valid = 1;
cleanup:
    if (descriptor) LocalFree(descriptor);
    if (token) CloseHandle(token);
    free(user);
    return valid;
}

static int check_directory(wchar_t *path, size_t length) {
    size_t root = root_length(path, length), index, start, count = 0;
    HANDLE *handles;
    int valid = 0;
    if (!root) return 0;
    handles = (HANDLE *)malloc((length + 1) * sizeof(HANDLE));
    if (!handles) return 0;
    if (!open_directory(path, root, handles, &count)) goto cleanup;
    index = root;
    while (index < length) {
        if (path[index] == L'\\') { index++; continue; }
        start = index;
        while (index < length && path[index] != L'\\') {
            if (path[index] == L':') goto cleanup;
            index++;
        }
        if (path[index - 1] == L'.' || path[index - 1] == L' ') goto cleanup;
        if (index == start || !open_directory(path, index, handles, &count)) goto cleanup;
    }
    valid = private_acl(handles[count - 1]);
cleanup:
    while (count) CloseHandle(handles[--count]);
    free(handles);
    return valid;
}

static napi_value __cdecl check(napi_env env, napi_callback_info info) {
    size_t argc = 1, length = 0, copied = 0, index;
    napi_value argument, result;
    wchar_t *path;
    int valid;
    if (get_cb_info(env, info, &argc, &argument, NULL, NULL) || argc != 1 ||
            get_string(env, argument, NULL, 0, &length) || !length || length > 32767) {
        throw_error(env, NULL, "An absolute authentication directory is required");
        return NULL;
    }
    path = (wchar_t *)calloc(length + 1, sizeof(wchar_t));
    if (!path) {
        throw_error(env, NULL, "Cannot allocate authentication path");
        return NULL;
    }
    if (get_string(env, argument, path, length + 1, &copied) || copied != length || wcslen(path) != length) {
        free(path);
        throw_error(env, NULL, "Invalid authentication directory");
        return NULL;
    }
    for (index = 0; index < length; index++) if (path[index] == L'/') path[index] = L'\\';
    valid = check_directory(path, length);
    free(path);
    if (!valid) {
        throw_error(env, NULL, "Authentication directory is linked, shared, missing, or owned by another account");
        return NULL;
    }
    if (get_undefined(env, &result)) return NULL;
    return result;
}

void *aixand_auth_init(napi_env env, napi_value exports) {
    napi_value function;
    if (!InitOnceExecuteOnce(&api_once, load_api, NULL, NULL)) return NULL;
    if (create_function(env, "check", 5, check, NULL, &function) || set_property(env, exports, "check", function)) return NULL;
    return exports;
}
