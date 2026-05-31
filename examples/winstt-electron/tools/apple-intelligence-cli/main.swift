// SPDX-License-Identifier: MIT
//
// winstt-apple-llm — tiny one-shot Apple Intelligence bridge.
//
// CONTRACT
//   stdin : a single JSON object { "system": String, "user": String, "tokenLimit": Int }
//           - "system"    : system prompt (instructions). Required (may be "").
//           - "user"      : user content. Required (may be "").
//           - "tokenLimit": word-count cap on the returned text. 0 disables.
//   stdout: a single JSON object — either
//             { "ok": true,  "text":  "<model output>" }
//           or
//             { "ok": false, "error": "<reason>" }
//           Exit code is always 0 — the JSON envelope is the contract; non-zero
//           exits are reserved for fatal Swift/runtime errors before we can
//           emit JSON (decode failure, OOM, etc.).
//
// PLATFORM GATE
//   - Compiles only on arm64. The build script in build.sh refuses to run
//     on non-Darwin and emits arm64-apple-macos15 binaries.
//   - The FoundationModels framework is only available on macOS 15+ (the
//     "Sequoia"/"26.0" SDK). Older runtimes are detected via #available and
//     return a structured JSON error instead of crashing.
//
// WHY A CLI INSTEAD OF FFI?
//   The Electron main process already speaks `child_process.spawn`. A tiny
//   stdin/stdout JSON bridge keeps Apple Intelligence behind the same I/O
//   contract as our other LLM providers — no Swift symbols leaking into
//   the Node addon surface, no codesign-the-dylib dance.

#if os(macOS) && arch(arm64)

import Dispatch
import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

// MARK: - JSON envelope

private struct CLIRequest: Decodable {
	let system: String?
	let user: String?
	let tokenLimit: Int?
}

private struct CLIResponse: Encodable {
	let ok: Bool
	let text: String?
	let error: String?

	static func success(_ text: String) -> CLIResponse {
		CLIResponse(ok: true, text: text, error: nil)
	}

	static func failure(_ message: String) -> CLIResponse {
		CLIResponse(ok: false, text: nil, error: message)
	}
}

// MARK: - I/O helpers

private func emit(_ response: CLIResponse) -> Never {
	let encoder = JSONEncoder()
	encoder.outputFormatting = []
	if let data = try? encoder.encode(response) {
		FileHandle.standardOutput.write(data)
		FileHandle.standardOutput.write(Data([0x0A])) // trailing \n
	}
	exit(0)
}

private func readStdinJSON() -> CLIRequest? {
	let data = FileHandle.standardInput.readDataToEndOfFile()
	return try? JSONDecoder().decode(CLIRequest.self, from: data)
}

private func truncateToWordLimit(_ text: String, limit: Int) -> String {
	guard limit > 0 else { return text }
	let words = text.split(maxSplits: .max, omittingEmptySubsequences: true, whereSeparator: { $0.isWhitespace || $0.isNewline })
	if words.count <= limit { return text }
	return words.prefix(limit).joined(separator: " ")
}

// MARK: - Apple Intelligence call

private func runAppleIntelligence(systemPrompt: String, userContent: String, tokenLimit: Int) {
#if canImport(FoundationModels)
	guard #available(macOS 15.0, *) else {
		emit(.failure("Apple Intelligence requires macOS 15 or newer."))
	}

	let model = SystemLanguageModel.default
	guard model.availability == .available else {
		emit(.failure("Apple Intelligence is not currently available on this device."))
	}

	let semaphore = DispatchSemaphore(value: 0)
	final class Result: @unchecked Sendable {
		var text: String?
		var error: String?
	}
	let box = Result()

	Task.detached(priority: .userInitiated) {
		defer { semaphore.signal() }
		do {
			let session = LanguageModelSession(model: model, instructions: systemPrompt)
			let response = try await session.respond(to: userContent)
			box.text = truncateToWordLimit(response.content, limit: tokenLimit)
		} catch {
			box.error = error.localizedDescription
		}
	}
	semaphore.wait()

	if let text = box.text {
		emit(.success(text))
	}
	emit(.failure(box.error ?? "Unknown Apple Intelligence error"))
#else
	emit(.failure("Built without FoundationModels — rebuild on macOS 15+ SDK."))
#endif
}

// MARK: - Entrypoint

guard let req = readStdinJSON() else {
	emit(.failure("Failed to decode stdin JSON request"))
}
runAppleIntelligence(
	systemPrompt: req.system ?? "",
	userContent: req.user ?? "",
	tokenLimit: req.tokenLimit ?? 0
)

#else
// Non-Darwin / non-arm64 stub. The build script gates compilation to
// Darwin arm64; if anyone ever wires this file into a cross-platform
// build by accident, fail cleanly instead of compiling a broken binary.
import Foundation
FileHandle.standardError.write(Data("winstt-apple-llm: unsupported platform (requires macOS arm64)\n".utf8))
exit(2)
#endif
