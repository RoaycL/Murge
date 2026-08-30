// Read-only Wintun 0.14.1 ABI audit. This program never calls a Wintun API.
#include <wintun.h>

#include <array>
#include <cstddef>
#include <iostream>
#include <string>
#include <type_traits>

static_assert(sizeof(NET_LUID) == 8);
static_assert(sizeof(GUID) == 16);
static_assert(offsetof(GUID, Data4) == 8);
static_assert(sizeof(WINTUN_ADAPTER_HANDLE) == sizeof(void *));
static_assert(sizeof(WINTUN_SESSION_HANDLE) == sizeof(void *));
static_assert(std::is_pointer_v<WINTUN_ADAPTER_HANDLE>);
static_assert(std::is_pointer_v<WINTUN_SESSION_HANDLE>);

// These assignments make the compiler check the official header's function
// types and WINAPI calling convention. No hand-written ABI declarations exist.
static WINTUN_CREATE_ADAPTER_FUNC *create_adapter = nullptr;
static WINTUN_OPEN_ADAPTER_FUNC *open_adapter = nullptr;
static WINTUN_CLOSE_ADAPTER_FUNC *close_adapter = nullptr;
static WINTUN_DELETE_DRIVER_FUNC *delete_driver_for_export_audit_only = nullptr;
static WINTUN_GET_ADAPTER_LUID_FUNC *get_adapter_luid = nullptr;
static WINTUN_GET_RUNNING_DRIVER_VERSION_FUNC *get_driver_version = nullptr;
static WINTUN_SET_LOGGER_FUNC *set_logger = nullptr;
static WINTUN_START_SESSION_FUNC *start_session = nullptr;
static WINTUN_END_SESSION_FUNC *end_session = nullptr;
static WINTUN_GET_READ_WAIT_EVENT_FUNC *get_read_wait_event = nullptr;
static WINTUN_RECEIVE_PACKET_FUNC *receive_packet = nullptr;
static WINTUN_RELEASE_RECEIVE_PACKET_FUNC *release_receive_packet = nullptr;
static WINTUN_ALLOCATE_SEND_PACKET_FUNC *allocate_send_packet = nullptr;
static WINTUN_SEND_PACKET_FUNC *send_packet = nullptr;

static constexpr std::array<const char *, 14> kExpectedExports = {
    "WintunCreateAdapter",          "WintunOpenAdapter",
    "WintunCloseAdapter",           "WintunDeleteDriver",
    "WintunGetAdapterLUID",         "WintunGetRunningDriverVersion",
    "WintunSetLogger",              "WintunStartSession",
    "WintunEndSession",             "WintunGetReadWaitEvent",
    "WintunReceivePacket",          "WintunReleaseReceivePacket",
    "WintunAllocateSendPacket",     "WintunSendPacket"};

int wmain(int argc, wchar_t **argv) {
  // Keep the typed variables referenced under /W4 /WX.
  (void)create_adapter; (void)open_adapter; (void)close_adapter;
  (void)delete_driver_for_export_audit_only; (void)get_adapter_luid;
  (void)get_driver_version; (void)set_logger; (void)start_session;
  (void)end_session; (void)get_read_wait_event; (void)receive_packet;
  (void)release_receive_packet; (void)allocate_send_packet; (void)send_packet;

  if (argc != 2) {
    std::wcerr << L"usage: wintun-abi-audit.exe <absolute-wintun.dll>\n";
    return 2;
  }
  const std::wstring dll_path(argv[1]);
  if (dll_path.empty() || dll_path.find(L':') == std::wstring::npos) {
    std::wcerr << L"DLL path must be absolute\n";
    return 2;
  }

  HMODULE module = LoadLibraryExW(
      dll_path.c_str(), nullptr,
      LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (module == nullptr) {
    std::wcerr << L"LoadLibraryExW failed: " << GetLastError() << L"\n";
    return 3;
  }

  bool ok = true;
  for (const char *name : kExpectedExports) {
    if (GetProcAddress(module, name) == nullptr) {
      std::cerr << "missing export: " << name << "\n";
      ok = false;
    }
  }
  FreeLibrary(module);
  if (!ok) return 4;
  std::cout << "WINTUN_ABI_AUDIT=passed\n";
  std::cout << "WINTUN_API_INVOKED=false\n";
  return 0;
}
