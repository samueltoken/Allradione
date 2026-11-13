#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <shellapi.h>
#include <winver.h>
#include <string>
#include <vector>
#include <cwchar>
#include <cstring>
#include <algorithm>

namespace {
constexpr wchar_t kAppId[] = L"io.github.samueltoken.allradione";
constexpr wchar_t kRegistry[] = L"Software\\Allradione";
constexpr wchar_t kOwnerFile[] = L"allradione-install-owner.txt";
constexpr char kOwnerBytes[] = "io.github.samueltoken.allradione";
constexpr char kLauncherOwner[] = "io.github.samueltoken.allradione.desktop-launcher:v1";
constexpr wchar_t kDescription[] = L"Allradione Desktop Launcher";
constexpr wchar_t kOriginalName[] = L"Allradione.Desktop.exe";
constexpr int kConflict = 2, kNotInstalled = 3, kIoError = 4;
struct Failure { const wchar_t* phase = L"none"; DWORD error = ERROR_SUCCESS; };
Failure failure;
bool retryAllowed = true;
ULONGLONG retryDeadline = 0;
bool Fail(const wchar_t* phase, DWORD error) { failure = { phase, error ? error : ERROR_INVALID_DATA }; return false; }
bool Retryable(DWORD error) { return error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION || error == ERROR_ACCESS_DENIED; }
DWORD ComError(HRESULT error) { const DWORD code = static_cast<DWORD>(HRESULT_CODE(error)); return Retryable(code) ? code : ERROR_INVALID_DATA; }
bool WaitForRetry() {
  if (!retryAllowed || !Retryable(failure.error) || GetTickCount64() >= retryDeadline) return false;
  Sleep(100);
  return true;
}

struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE handle = INVALID_HANDLE_VALUE) : value(handle) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  explicit operator bool() const { return value != INVALID_HANDLE_VALUE && value != nullptr; }
};

struct ManagementLock {
  Handle handle;
  bool acquired = false;
  explicit ManagementLock(const std::wstring& desktop) : handle(CreateMutexW(nullptr, FALSE, MutexName(desktop).c_str())) {
    if (handle) {
      const DWORD result = WaitForSingleObject(handle.value, 5000);
      acquired = result == WAIT_OBJECT_0 || result == WAIT_ABANDONED;
    }
  }
  ~ManagementLock() { if (acquired) ReleaseMutex(handle.value); }
  static std::wstring MutexName(const std::wstring& desktop) {
    unsigned long long hash = 14695981039346656037ULL;
    for (wchar_t value : desktop) { hash ^= static_cast<unsigned short>(value); hash *= 1099511628211ULL; }
    return L"Local\\Allradione.Desktop.Management." + std::to_wstring(hash);
  }
};

bool EqualPath(const std::wstring& a, const std::wstring& b) {
  return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_EQUAL;
}

std::wstring Join(const std::wstring& root, const wchar_t* leaf) {
  return root + (root.empty() || root.back() == L'\\' ? L"" : L"\\") + leaf;
}

std::wstring RegistryString(const wchar_t* name, DWORD view) {
  DWORD size = 0;
  const DWORD flags = RRF_RT_REG_SZ | view;
  LSTATUS status = RegGetValueW(HKEY_CURRENT_USER, kRegistry, name, flags, nullptr, nullptr, &size);
  if (status != ERROR_SUCCESS) { Fail(L"registry-query", static_cast<DWORD>(status)); return {}; }
  if (size < sizeof(wchar_t) || size > 65536) { Fail(L"registry-size", ERROR_INVALID_DATA); return {}; }
  std::vector<wchar_t> value(size / sizeof(wchar_t) + 1, 0);
  status = RegGetValueW(HKEY_CURRENT_USER, kRegistry, name, flags, nullptr, value.data(), &size);
  if (status != ERROR_SUCCESS) { Fail(L"registry-read", static_cast<DWORD>(status)); return {}; }
  // A registry path is one string, never a list or a command line.
  const size_t length = std::wcslen(value.data());
  if ((length + 1) * sizeof(wchar_t) != size) { Fail(L"registry-string", ERROR_INVALID_DATA); return {}; }
  return std::wstring(value.data(), length);
}

std::wstring FinalPath(HANDLE handle) {
  DWORD required = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!required) { Fail(L"canonical-path", GetLastError()); return {}; }
  if (required > 32767) { Fail(L"canonical-path-size", ERROR_INVALID_DATA); return {}; }
  std::vector<wchar_t> path(required + 1);
  DWORD length = GetFinalPathNameByHandleW(handle, path.data(), static_cast<DWORD>(path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!length) { Fail(L"canonical-path-read", GetLastError()); return {}; }
  if (length >= path.size()) { Fail(L"canonical-path-size", ERROR_INVALID_DATA); return {}; }
  std::wstring result(path.data(), length);
  if (result.rfind(L"\\\\?\\UNC\\", 0) == 0) return {}; // Installed launcher is local, not a network executable.
  if (result.rfind(L"\\\\?\\", 0) == 0) result.erase(0, 4);
  return result;
}

bool FileInfo(HANDLE handle, bool directory, bool allowEmpty = true) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle, &info)) return Fail(L"file-information", GetLastError());
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return Fail(L"file-reparse-point", ERROR_INVALID_DATA);
  if (((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory) return Fail(L"file-type", ERROR_INVALID_DATA);
  return allowEmpty || info.nFileSizeHigh != 0 || info.nFileSizeLow != 0 || Fail(L"empty-file", ERROR_INVALID_DATA);
}

Handle OpenFile(const std::wstring& file, const wchar_t* phase = L"open-file") {
  const HANDLE result = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (result == INVALID_HANDLE_VALUE) Fail(phase, GetLastError());
  return Handle(result);
}

std::wstring CanonicalFile(const std::wstring& file) {
  if (file.size() <= 3 || file[1] != L':' || file[2] != L'\\') { Fail(L"target-path", ERROR_INVALID_DATA); return {}; }
  Handle handle = OpenFile(file, L"target-open");
  return handle && FileInfo(handle.value, false) ? FinalPath(handle.value) : std::wstring();
}

bool VersionString(const std::wstring& file, const wchar_t* name, const wchar_t* expected) {
  DWORD unused = 0;
  DWORD size = GetFileVersionInfoSizeW(file.c_str(), &unused);
  if (!size) return Fail(L"version-size", GetLastError());
  if (size > 1024 * 1024) return Fail(L"version-size-limit", ERROR_INVALID_DATA);
  std::vector<BYTE> data(size);
  if (!GetFileVersionInfoW(file.c_str(), 0, size, data.data())) return Fail(L"version-read", GetLastError());
  VS_FIXEDFILEINFO* fixed = nullptr;
  UINT fixedSize = 0;
  if (!VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&fixed), &fixedSize) || fixedSize < sizeof(*fixed) || fixed->dwSignature != 0xFEEF04BD || fixed->dwFileType != VFT_APP) return Fail(L"version-identity", ERROR_INVALID_DATA);
  struct Translation { WORD language, codepage; };
  Translation* translations = nullptr;
  UINT bytes = 0;
  if (!VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&translations), &bytes) || bytes < sizeof(Translation) || bytes > 256) return Fail(L"version-translation", ERROR_INVALID_DATA);
  for (UINT index = 0; index < bytes / sizeof(Translation); ++index) {
    wchar_t query[128];
    if (swprintf_s(query, L"\\StringFileInfo\\%04x%04x\\%s", translations[index].language, translations[index].codepage, name) < 0) return false;
    wchar_t* value = nullptr;
    UINT length = 0;
    if (VerQueryValueW(data.data(), query, reinterpret_cast<void**>(&value), &length) && length > 0 && length <= 1024 && std::wstring(value, length - 1) == expected) return true;
  }
  return Fail(L"version-string-identity", ERROR_INVALID_DATA);
}

bool IsOwnedLauncher(const std::wstring& file) {
  Handle handle = OpenFile(file);
  if (!handle || !FileInfo(handle.value, false, false)) return false;
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(handle.value, &size)) return Fail(L"launcher-size", GetLastError());
  if (size.QuadPart > 8 * 1024 * 1024) return Fail(L"launcher-size-limit", ERROR_INVALID_DATA);
  HMODULE module = LoadLibraryExW(file.c_str(), nullptr, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
  if (!module) return Fail(L"launcher-resource-open", GetLastError());
  HRSRC resource = FindResourceW(module, MAKEINTRESOURCEW(201), RT_RCDATA);
  HGLOBAL loaded = resource ? LoadResource(module, resource) : nullptr;
  const void* bytes = loaded ? LockResource(loaded) : nullptr;
  const bool ownerMatches = resource && bytes && SizeofResource(module, resource) == sizeof(kLauncherOwner) - 1 && memcmp(bytes, kLauncherOwner, sizeof(kLauncherOwner) - 1) == 0;
  FreeLibrary(module);
  return (ownerMatches || Fail(L"launcher-resource-identity", ERROR_INVALID_DATA)) && VersionString(file, L"CompanyName", kAppId) && VersionString(file, L"FileDescription", kDescription) && VersionString(file, L"OriginalFilename", kOriginalName);
}

struct Installation { std::wstring root, executable, helper; };

bool ResolveInstallation(Installation& install) {
  Failure transient;
  for (DWORD view : { RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY }) {
    if (Retryable(failure.error)) transient = failure;
    if (RegistryString(L"AppId", view) != kAppId) continue;
    const std::wstring candidate = RegistryString(L"InstallLocation", view);
    if (candidate.size() <= 3 || candidate.size() > 32000 || candidate[1] != L':' || candidate[2] != L'\\' || candidate.find_first_of(L"\r\n\"*?") != std::wstring::npos) continue;
    Handle directory(CreateFileW(candidate.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!directory) { Fail(L"installation-directory-open", GetLastError()); continue; }
    if (!FileInfo(directory.value, true)) continue;
    const std::wstring root = FinalPath(directory.value);
    if (root.size() <= 3) continue;
    Handle owner = OpenFile(Join(root, kOwnerFile));
    if (!owner || !FileInfo(owner.value, false)) continue;
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(owner.value, &size)) { Fail(L"installation-marker-size", GetLastError()); continue; }
    if (size.QuadPart != static_cast<LONGLONG>(sizeof(kOwnerBytes) - 1)) { Fail(L"installation-marker-identity", ERROR_INVALID_DATA); continue; }
    char marker[sizeof(kOwnerBytes)]{};
    DWORD read = 0;
    if (!ReadFile(owner.value, marker, sizeof(marker), &read, nullptr)) { Fail(L"installation-marker-read", GetLastError()); continue; }
    if (read != sizeof(kOwnerBytes) - 1 || memcmp(marker, kOwnerBytes, sizeof(kOwnerBytes) - 1) != 0) { Fail(L"installation-marker-identity", ERROR_INVALID_DATA); continue; }
    const std::wstring executable = Join(root, L"Allradione.exe");
    const std::wstring helper = Join(root, L"resources\\desktop-launcher.exe");
    // Retain only this marker-validated root for safe diagnostics if app files are busy.
    install = { root, executable, helper };
    Handle application = OpenFile(executable);
    const std::wstring asarPath = Join(root, L"resources\\app.asar");
    Handle asar = OpenFile(asarPath);
    if (!application || !FileInfo(application.value, false, false) || !EqualPath(FinalPath(application.value), executable) || !asar || !FileInfo(asar.value, false, false) || !EqualPath(FinalPath(asar.value), asarPath) || !VersionString(executable, L"ProductName", L"Allradione")) continue;
    return true;
  }
  if (!Retryable(failure.error) && Retryable(transient.error)) failure = transient;
  return false;
}

std::wstring SelfPath() {
  std::vector<wchar_t> path(32768);
  DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  return size && size < path.size() ? CanonicalFile(std::wstring(path.data(), size)) : std::wstring();
}

bool Exists(const std::wstring& file) {
  if (GetFileAttributesW(file.c_str()) != INVALID_FILE_ATTRIBUTES) return true;
  const DWORD error = GetLastError();
  if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return false;
  Fail(L"file-existence", error);
  return true; // An unreadable entry must be validated, never mistaken for absence.
}

bool OwnedShortcut(const std::wstring& shortcut, const std::wstring& executable) {
  Handle file = OpenFile(shortcut, L"shortcut-open");
  if (!file || !FileInfo(file.value, false)) return false;
  IShellLinkW* link = nullptr;
  HRESULT status = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link));
  if (FAILED(status)) return Fail(L"shortcut-com-create", ComError(status));
  IPersistFile* persisted = nullptr;
  bool owned = false;
  status = link->QueryInterface(IID_PPV_ARGS(&persisted));
  if (SUCCEEDED(status)) {
    // A separate pinned read handle already denies writes/deletes. COM's second
    // read must explicitly allow that handle instead of relying on default sharing.
    status = persisted->Load(shortcut.c_str(), STGM_READ | STGM_SHARE_DENY_NONE);
    if (SUCCEEDED(status)) {
      std::vector<wchar_t> target(32768);
      WIN32_FIND_DATAW unused{};
      status = link->GetPath(target.data(), static_cast<int>(target.size()), &unused, SLGP_RAWPATH);
      if (SUCCEEDED(status)) {
        const std::wstring canonical = CanonicalFile(target.data());
        owned = !canonical.empty() && EqualPath(canonical, executable);
        if (!canonical.empty() && !owned) Fail(L"shortcut-target-identity", ERROR_INVALID_DATA);
      } else Fail(L"shortcut-target-read", ComError(status));
    } else Fail(L"shortcut-load", ComError(status));
    persisted->Release();
  } else Fail(L"shortcut-interface", ComError(status));
  link->Release();
  return owned;
}

std::wstring UniqueName(const std::wstring& desktop, const wchar_t* extension, unsigned counter) {
  return Join(desktop, (L".Allradione-desktop-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(counter) + extension).c_str());
}

// MoveFileEx without REPLACE_EXISTING ensures a new user file is never overwritten.
bool MoveAside(const std::wstring& source, const std::wstring& desktop, std::wstring& backup) {
  for (unsigned attempt = 0; attempt < 32; ++attempt) {
    const std::wstring candidate = UniqueName(desktop, L".bak", attempt);
    if (MoveFileExW(source.c_str(), candidate.c_str(), MOVEFILE_WRITE_THROUGH)) { backup = candidate; return true; }
    const DWORD error = GetLastError();
    if (error != ERROR_ALREADY_EXISTS && error != ERROR_FILE_EXISTS) return Fail(L"move-owned-file", error);
  }
  return Fail(L"backup-name-collision", ERROR_ALREADY_EXISTS);
}

bool Restore(const std::wstring& backup, const std::wstring& destination) {
  do {
    if (MoveFileExW(backup.c_str(), destination.c_str(), MOVEFILE_WRITE_THROUGH)) return true;
    Fail(L"restore-owned-backup", GetLastError());
  } while (WaitForRetry());
  retryAllowed = false; // Preserve the backup; never retry across an incomplete rollback.
  return false;
}

bool DeleteOwnedBackup(const std::wstring& backup, bool shortcut, const Installation& install, const wchar_t* phase) {
  // Keep this exact backup in hand during transient locks. Recheck ownership on
  // every attempt; do not begin a fresh publication while a previous backup remains.
  do {
    const bool owned = shortcut ? OwnedShortcut(backup, install.executable) : IsOwnedLauncher(backup);
    if (owned) {
      if (DeleteFileW(backup.c_str())) return true;
      Fail(phase, GetLastError());
    }
  } while (WaitForRetry());
  return false;
}

int RemoveOwned(const std::wstring& target, const std::wstring& desktop, bool shortcut, const Installation& install) {
  if (!Exists(target)) return 0;
  const auto owns = [&](const std::wstring& file) { return shortcut ? OwnedShortcut(file, install.executable) : IsOwnedLauncher(file); };
  if (!owns(target)) return kConflict;
  std::wstring backup;
  if (!MoveAside(target, desktop, backup)) return kIoError;
  if (!owns(backup)) { Restore(backup, target); return kConflict; }
  if (!DeleteOwnedBackup(backup, shortcut, install, L"delete-owned-backup")) { Restore(backup, target); return kIoError; }
  return 0;
}

int ManageDesktop(const Installation& install, const std::wstring& self, bool remove) {
  const std::wstring canonicalHelper = CanonicalFile(install.helper);
  if (self.empty() || canonicalHelper.empty()) return kNotInstalled;
  if (!EqualPath(canonicalHelper, install.helper) || !EqualPath(self, canonicalHelper)) { Fail(L"helper-location-identity", ERROR_INVALID_DATA); return kNotInstalled; }
  if (!IsOwnedLauncher(self)) return kNotInstalled;
  PWSTR desktopPath = nullptr;
  const HRESULT desktopStatus = SHGetKnownFolderPath(FOLDERID_Desktop, KF_FLAG_DEFAULT, nullptr, &desktopPath);
  if (FAILED(desktopStatus)) { Fail(L"desktop-location", ComError(desktopStatus)); return kIoError; }
  const std::wstring desktop(desktopPath);
  CoTaskMemFree(desktopPath);
  ManagementLock lock(desktop);
  if (!lock.acquired) { Fail(L"desktop-management-lock", ERROR_TIMEOUT); return kIoError; }
  const std::wstring destination = Join(desktop, L"Allradione.exe");
  const std::wstring shortcut = Join(desktop, L"Allradione.lnk");
  if (remove) {
    const int exeResult = RemoveOwned(destination, desktop, false, install);
    const Failure exeFailure = failure;
    const bool exeRetryAllowed = retryAllowed;
    const int linkResult = RemoveOwned(shortcut, desktop, true, install);
    if (linkResult && !retryAllowed) return linkResult;
    if (exeResult) { failure = exeFailure; retryAllowed = exeRetryAllowed; }
    return exeResult ? exeResult : linkResult;
  }
  if ((Exists(destination) && !IsOwnedLauncher(destination)) || (Exists(shortcut) && !OwnedShortcut(shortcut, install.executable))) return kConflict;
  std::wstring temporary;
  for (unsigned attempt = 0; attempt < 32; ++attempt) {
    const std::wstring candidate = UniqueName(desktop, L".tmp", attempt);
    if (CopyFileW(self.c_str(), candidate.c_str(), TRUE)) { temporary = candidate; break; }
    const DWORD error = GetLastError();
    if (error != ERROR_ALREADY_EXISTS && error != ERROR_FILE_EXISTS) { Fail(L"copy-launcher", error); return kIoError; }
  }
  if (temporary.empty()) return kIoError;
  if (!IsOwnedLauncher(temporary)) { DeleteFileW(temporary.c_str()); return kIoError; }
  std::wstring backup;
  if (Exists(destination)) {
    if (!MoveAside(destination, desktop, backup)) { DeleteFileW(temporary.c_str()); return kIoError; }
    if (!IsOwnedLauncher(backup)) { Restore(backup, destination); DeleteFileW(temporary.c_str()); return kConflict; }
  }
  if (!MoveFileExW(temporary.c_str(), destination.c_str(), MOVEFILE_WRITE_THROUGH)) {
    const DWORD error = GetLastError();
    Fail(L"publish-launcher", error);
    if (!backup.empty()) Restore(backup, destination);
    DeleteFileW(temporary.c_str());
    return error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS ? kConflict : kIoError;
  }
  if (!backup.empty() && !DeleteOwnedBackup(backup, false, install, L"delete-replaced-launcher")) { retryAllowed = false; return kIoError; }
  // Old .lnk migration happens only after the new executable is safely published.
  return RemoveOwned(shortcut, desktop, true, install);
}

void WriteManagementStatus(const std::wstring& self, bool remove, int result, unsigned attempts, Failure detail) {
  const std::wstring suffix = L"\\resources\\desktop-launcher.exe";
  if (self.size() <= suffix.size() || !EqualPath(self.substr(self.size() - suffix.size()), suffix)) return;
  const std::wstring root = self.substr(0, self.size() - suffix.size());
  Handle directory(CreateFileW(root.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!directory || !FileInfo(directory.value, true) || !EqualPath(FinalPath(directory.value), root)) return;
  // This guard is independent of app.exe availability so a transient validation
  // failure can still be reported, only beside the genuinely installed helper.
  const std::wstring markerPath = Join(root, kOwnerFile);
  Handle marker = OpenFile(markerPath);
  LARGE_INTEGER size{};
  if (!marker || !FileInfo(marker.value, false) || !EqualPath(FinalPath(marker.value), markerPath) || !GetFileSizeEx(marker.value, &size) || size.QuadPart != static_cast<LONGLONG>(sizeof(kOwnerBytes) - 1)) return;
  char bytes[sizeof(kOwnerBytes)]{};
  DWORD read = 0;
  if (!ReadFile(marker.value, bytes, sizeof(bytes), &read, nullptr) || read != sizeof(kOwnerBytes) - 1 || memcmp(bytes, kOwnerBytes, sizeof(kOwnerBytes) - 1) != 0) return;
  if (!EqualPath(CanonicalFile(Join(root, L"resources\\desktop-launcher.exe")), self)) return;
  const std::wstring statusPath = Join(root, L"desktop-launcher-status.txt");
  // OPEN_ALWAYS does not truncate an existing entry before its identity is checked.
  Handle status(CreateFileW(statusPath.c_str(), GENERIC_WRITE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!status || !FileInfo(status.value, false) || !EqualPath(FinalPath(status.value), statusPath)) return;
  std::string phase;
  for (const wchar_t* character = detail.phase; *character; ++character) phase.push_back(static_cast<char>(*character));
  const std::string message = std::string("action=") + (remove ? "remove-desktop" : "install-desktop") + "\r\nresult=" + std::to_string(result) + "\r\nphase=" + phase + "\r\nwin32=" + std::to_string(detail.error) + "\r\nattempts=" + std::to_string(attempts) + "\r\n";
  LARGE_INTEGER beginning{};
  DWORD written = 0;
  if (SetFilePointerEx(status.value, beginning, nullptr, FILE_BEGIN) && SetEndOfFile(status.value)) WriteFile(status.value, message.data(), static_cast<DWORD>(message.size()), &written, nullptr);
}

std::vector<wchar_t> ChildEnvironment() {
  LPWCH environment = GetEnvironmentStringsW();
  if (!environment) return {};
  std::vector<wchar_t> clean;
  for (const wchar_t* entry = environment; *entry; entry += std::wcslen(entry) + 1) {
    const std::wstring value(entry);
    const std::wstring name = value.substr(0, value.find(L'='));
    bool skip = false;
    for (const wchar_t* blocked : { L"ELECTRON_RUN_AS_NODE", L"ELECTRON_NO_ASAR", L"NODE_OPTIONS", L"ALLRADIONE_DEV_URL", L"PORTABLE_EXECUTABLE_FILE", L"PORTABLE_EXECUTABLE_DIR" }) if (EqualPath(name, blocked)) skip = true;
    if (!skip) { clean.insert(clean.end(), value.begin(), value.end()); clean.push_back(0); }
  }
  FreeEnvironmentStringsW(environment);
  clean.push_back(0);
  return clean;
}

int Launch(const Installation& install, const std::wstring& self) {
  if (self.empty() || EqualPath(self, install.executable)) return kNotInstalled;
  std::wstring command = L"\"" + install.executable + L"\"";
  std::vector<wchar_t> environment = ChildEnvironment();
  if (environment.empty()) return kIoError;
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(install.executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_UNICODE_ENVIRONMENT, environment.data(), install.root.c_str(), &startup, &process)) return kIoError;
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return 0;
}
} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
  const HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  int count = 0;
  wchar_t** arguments = CommandLineToArgvW(GetCommandLineW(), &count);
  bool quiet = false, installDesktop = false, removeDesktop = false, invalid = !arguments;
  for (int index = 1; arguments && index < count; ++index) {
    if (std::wcscmp(arguments[index], L"--quiet") == 0) quiet = true;
    else if (std::wcscmp(arguments[index], L"--install-desktop") == 0) installDesktop = true;
    else if (std::wcscmp(arguments[index], L"--remove-desktop") == 0) removeDesktop = true;
    else invalid = true;
  }
  if (arguments) LocalFree(arguments);
  Installation installation;
  int result = kNotInstalled;
  if (invalid || (installDesktop && removeDesktop)) result = kIoError;
  else if (installDesktop || removeDesktop) {
    retryDeadline = GetTickCount64() + 3000;
    unsigned attempts = 0;
    std::wstring diagnosticSelf;
    do {
      ++attempts;
      failure = { L"installation-validation", ERROR_INVALID_DATA };
      retryAllowed = true;
      const std::wstring self = SelfPath();
      if (!self.empty()) diagnosticSelf = self;
      if (FAILED(com)) { Fail(L"com-initialize", ComError(com)); result = kIoError; }
      else if (ResolveInstallation(installation)) result = ManageDesktop(installation, self, removeDesktop);
      else result = kNotInstalled;
      if (!result) { failure = { L"completed", ERROR_SUCCESS }; break; }
      if (!WaitForRetry()) break;
    } while (true);
    WriteManagementStatus(diagnosticSelf, removeDesktop, result, attempts, failure);
  } else if (ResolveInstallation(installation)) {
    const std::wstring self = SelfPath();
    result = Launch(installation, self);
  }
  if (SUCCEEDED(com)) CoUninitialize();
  if (result && !quiet) {
    const wchar_t* message = result == kConflict ? L"바탕화면에 같은 이름의 다른 파일이 있어 변경하지 않았어." : result == kNotInstalled ? L"Allradione 설치 위치를 찾지 못했어. 설치 프로그램을 다시 실행해줘." : L"Allradione를 실행하거나 바탕화면 아이콘을 변경하지 못했어. 잠시 후 다시 시도해줘.";
    MessageBoxW(nullptr, message, L"Allradione", MB_OK | MB_ICONINFORMATION);
  }
  return result;
}
