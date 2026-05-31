// winstt-ocr.exe — last-resort context fallback.
//
// When the UIA reader (winstt-context.exe) exposes no readable text — e.g.
// canvas-rendered apps, some games, RDP, or other windows with no
// accessibility tree — this captures the foreground window and runs the
// on-device Windows.Media.Ocr engine over it, printing the recognized text
// (UTF-8) to stdout. Purely local; no network, no cloud. The JS caller only
// invokes this when the accessibility capture came back empty, and bounds it
// with its own timeout.
//
// Build: MSVC + Windows SDK cppwinrt (see scripts/native/build-winstt-ocr.cjs).
// Exit codes: 0 ok (text on stdout, may be empty), 1 no/zero-size window,
// 2 OCR engine unavailable for the user's languages, 3 capture/convert error.

#include <windows.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Media.Ocr.h>
#include <winrt/Windows.Storage.Streams.h>

#include <cstdio>
#include <string>

using namespace winrt;
using namespace winrt::Windows::Graphics::Imaging;
using namespace winrt::Windows::Media::Ocr;
using namespace winrt::Windows::Storage::Streams;

// Cap the captured dimension so a maximized 4K window doesn't make OCR crawl.
// OCR accuracy doesn't need native resolution; the JS timeout is the backstop.
static const int MAX_DIM = 2600;

static void print_utf8(winrt::hstring const& text) {
    std::wstring ws{ text.c_str() };
    if (ws.empty()) return;
    int n = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), nullptr, 0, nullptr, nullptr);
    if (n <= 0) return;
    std::string out((size_t)n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), out.data(), n, nullptr, nullptr);
    fwrite(out.data(), 1, out.size(), stdout);
}

int main() {
    HWND hwnd = GetForegroundWindow();
    if (!hwnd) return 1;
    RECT r;
    if (!GetWindowRect(hwnd, &r)) return 1;
    int w = r.right - r.left;
    int h = r.bottom - r.top;
    if (w <= 0 || h <= 0) return 1;
    if (w > MAX_DIM) w = MAX_DIM;
    if (h > MAX_DIM) h = MAX_DIM;

    // Capture the window into a top-down 32-bit BGRA DIB via PrintWindow
    // (PW_RENDERFULLCONTENT=2 grabs GPU-composited content GDI BitBlt misses).
    HDC screen = GetDC(nullptr);
    HDC mem = CreateCompatibleDC(screen);
    BITMAPINFO bi{};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;  // negative = top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HBITMAP dib = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
    int rc = 3;
    if (dib && bits) {
        HGDIOBJ old = SelectObject(mem, dib);
        PrintWindow(hwnd, mem, 2 /* PW_RENDERFULLCONTENT */);
        SelectObject(mem, old);

        // GDI leaves the alpha channel zeroed; force opaque so the OCR
        // engine doesn't treat the whole frame as transparent.
        const uint32_t byteCount = (uint32_t)w * (uint32_t)h * 4u;
        auto* p = static_cast<uint8_t*>(bits);
        for (uint32_t i = 3; i < byteCount; i += 4) {
            p[i] = 0xFF;
        }

        try {
            init_apartment(apartment_type::multi_threaded);
            Buffer buffer(byteCount);
            buffer.Length(byteCount);
            memcpy(buffer.data(), bits, byteCount);
            SoftwareBitmap sb = SoftwareBitmap::CreateCopyFromBuffer(
                buffer, BitmapPixelFormat::Bgra8, w, h);

            OcrEngine engine = OcrEngine::TryCreateFromUserProfileLanguages();
            if (engine) {
                OcrResult result = engine.RecognizeAsync(sb).get();
                print_utf8(result.Text());
                rc = 0;
            } else {
                rc = 2;
            }
        } catch (...) {
            rc = 3;
        }
    }

    if (dib) DeleteObject(dib);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
    return rc;
}
