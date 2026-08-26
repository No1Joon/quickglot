//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//

import NaturalLanguage
import SafariServices
import Translation
import os.log

private let log = Logger(subsystem: "com.no1joon.quickglot", category: "extension")

// MARK: - Wire protocol
//
// Mirrors extension/src/shared/messages.ts. Keep the two in sync by hand;
// there is no codegen and the boundary is untyped JSON either way.

private enum Failure: String {
    case notInstalled
    case unsupported
    case undetectable
    case sameLanguage
    case unknown
}

private enum Payload {
    case success(text: String, source: String, target: String)
    case languages([[String: String]])
    case failure(Failure, String)

    /// Log-safe description: never includes the selected text or its translation.
    var summary: String {
        switch self {
        case let .success(_, source, target): return "ok \(source)->\(target)"
        case let .languages(list): return "languages \(list.count)"
        case let .failure(error, _): return "fail \(error.rawValue)"
        }
    }

    var dictionary: [String: Any] {
        switch self {
        case let .success(text, source, target):
            return ["ok": true, "text": text, "source": source, "target": target]
        case let .languages(list):
            return ["ok": true, "languages": list]
        case let .failure(error, message):
            return ["ok": false, "error": error.rawValue, "message": message]
        }
    }
}

// MARK: - Translation

private enum Translator {
    /// Selections shorter than this are too ambiguous for reliable language ID
    /// ("die" is German and English), so we lean on the hypothesis score instead.
    static let shortTextThreshold = 12
    static let minimumConfidence = 0.55

    static func detect(_ text: String) -> Locale.Language? {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        guard let dominant = recognizer.dominantLanguage else { return nil }

        if text.count < shortTextThreshold {
            let hypotheses = recognizer.languageHypotheses(withMaximum: 1)
            guard let score = hypotheses[dominant], score >= minimumConfidence else { return nil }
        }
        return Locale.Language(identifier: dominant.rawValue)
    }

    /// `Locale.current.language` is a single value and gets this wrong: a Mac set
    /// to ["en-KR", "ko-KR"] resolves to English, so English text would translate
    /// to English. The whole preference list is the honest answer — the first
    /// entry that differs from the source wins, which sends English to Korean
    /// while still sending Japanese to English.
    ///
    /// TargetPicker in ViewController.swift applies the same rule so the app
    /// offers exactly the pairs the extension will ask for. Keep them in sync.
    static func preferredTargets() -> [Locale.Language] {
        let preferred = Locale.preferredLanguages.map(Locale.Language.init(identifier:))
        return preferred.isEmpty ? [Locale.current.language] : preferred
    }

    static func label(_ language: Locale.Language) -> String {
        language.languageCode?.identifier ?? language.minimalIdentifier
    }

    /// Every language the on-device models can translate *into*, deduplicated to
    /// one entry per language code and sorted for display.
    static func supportedTargets() async -> [[String: String]] {
        var seen = Set<String>()
        var result: [[String: String]] = []

        for language in await LanguageAvailability().supportedLanguages {
            let code = label(language)
            guard seen.insert(code).inserted else { continue }
            let name = Locale.current.localizedString(forLanguageCode: code) ?? code
            result.append(["code": code, "name": name])
        }
        return result.sorted { ($0["name"] ?? "") < ($1["name"] ?? "") }
    }

    static func translate(text: String, requestedTarget: String?) async -> Payload {
        guard let source = detect(text) else {
            return .failure(.undetectable, "Could not identify the language of the selection")
        }

        let candidates = requestedTarget
            .map { [Locale.Language(identifier: $0)] } ?? preferredTargets()
        let usable = candidates.filter { label($0) != label(source) }

        guard !usable.isEmpty else {
            return .failure(.sameLanguage, "Already in your language")
        }

        // Prefer a pair that is ready to go; remember the best downloadable
        // alternative so the user can be told what to fetch.
        let availability = LanguageAvailability()
        var installed: Locale.Language?
        var downloadable: Locale.Language?

        for candidate in usable {
            switch await availability.status(from: source, to: candidate) {
            case .installed:
                installed = candidate
            case .supported:
                if downloadable == nil { downloadable = candidate }
            case .unsupported:
                break
            @unknown default:
                break
            }
            if installed != nil { break }
        }

        guard let target = installed else {
            if let pending = downloadable {
                return .failure(
                    .notInstalled,
                    "\(label(source)) to \(label(pending)) is supported but not downloaded"
                )
            }
            return .failure(
                .unsupported,
                "\(label(source)) is not supported on device"
            )
        }

        do {
            let session = try TranslationSession(installedSource: source, target: target)
            let response = try await session.translate(text)
            return .success(
                text: response.targetText,
                source: label(response.sourceLanguage),
                target: label(response.targetLanguage)
            )
        } catch let error as TranslationError {
            switch error {
            case .notInstalled:
                return .failure(.notInstalled, "Language pair is not downloaded")
            case .unsupportedLanguagePairing, .unsupportedSourceLanguage, .unsupportedTargetLanguage:
                return .failure(.unsupported, "Unsupported language pair")
            case .unableToIdentifyLanguage:
                return .failure(.undetectable, "Could not identify the language")
            default:
                log.error("translation failed: \(error.localizedDescription, privacy: .public)")
                return .failure(.unknown, error.localizedDescription)
            }
        } catch {
            log.error("translation failed: \(error.localizedDescription, privacy: .public)")
            return .failure(.unknown, error.localizedDescription)
        }
    }
}

// MARK: - Handler

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]

        guard let body = message as? [String: Any] else {
            Self.complete(context, with: .failure(.unknown, "Malformed request"))
            return
        }

        switch body["type"] as? String {
        case "languages":
            Task {
                let payload = Payload.languages(await Translator.supportedTargets())
                log.debug("result: \(payload.summary, privacy: .public)")
                Self.complete(context, with: payload)
            }

        case "translate":
            let text = (body["text"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !text.isEmpty else {
                Self.complete(context, with: .failure(.unknown, "Empty selection"))
                return
            }
            let requestedTarget = body["target"] as? String
            log.debug("request: \(text.count, privacy: .public) chars")

            Task {
                let payload = await Translator.translate(
                    text: text,
                    requestedTarget: requestedTarget
                )
                log.debug("result: \(payload.summary, privacy: .public)")
                Self.complete(context, with: payload)
            }

        default:
            Self.complete(context, with: .failure(.unknown, "Unknown request type"))
        }
    }

    private static func complete(_ context: NSExtensionContext, with payload: Payload) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload.dictionary]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
