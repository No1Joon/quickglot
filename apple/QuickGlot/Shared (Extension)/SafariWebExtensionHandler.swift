//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//

import NaturalLanguage
import SafariServices
import Translation
import os.log

private let log = Logger(subsystem: "com.quickglot.app", category: "extension")

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
    case success(text: String, source: String, target: String, pinned: String?)
    case languages([[String: String]])
    case settings(target: String?, languages: [[String: String]])
    case failure(Failure, String)

    /// Log-safe description: never includes the selected text or its translation.
    var summary: String {
        switch self {
        case let .success(_, source, target, _): return "ok \(source)->\(target)"
        case let .languages(list): return "languages \(list.count)"
        case let .settings(target, list): return "settings target=\(target ?? "auto") langs=\(list.count)"
        case let .failure(error, _): return "fail \(error.rawValue)"
        }
    }

    var dictionary: [String: Any] {
        switch self {
        case let .success(text, source, target, pinned):
            return ["ok": true, "text": text, "source": source, "target": target,
                    "pinned": pinned ?? ""]
        case let .languages(list):
            return ["ok": true, "languages": list]
        case let .settings(target, list):
            return ["ok": true, "target": target ?? "", "languages": list]
        case let .failure(error, message):
            return ["ok": false, "error": error.rawValue, "message": message]
        }
    }
}

// MARK: - Shared settings

/// The target language lives in the app group so the app and the extension read
/// one value instead of each keeping its own. Both write it: the popup pins or
/// clears it, and the app's "To" row pins it. The group identifier is mirrored
/// into Info.plist by the build, where the team prefix is expanded — hardcoding
/// it here would put the team id in a public repository.
enum SharedSettings {
    static let targetKey = "targetLanguage"

    static var defaults: UserDefaults? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "AppGroupIdentifier") as? String,
              !group.isEmpty
        else { return nil }
        return UserDefaults(suiteName: group)
    }

    /// nil means automatic — pick from the user's preferred languages.
    static var target: String? {
        get {
            guard let value = defaults?.string(forKey: targetKey), !value.isEmpty else { return nil }
            return value
        }
        set {
            guard let defaults else { return }
            if let newValue, !newValue.isEmpty {
                defaults.set(newValue, forKey: targetKey)
            } else {
                defaults.removeObject(forKey: targetKey)
            }
        }
    }
}

// MARK: - Translation

/// Sessions kept for as long as this process lives. Creating one loads the
/// model for the pair, which is most of what a request costs; the system's
/// own Translate keeps its session warm, and this is the closest an extension
/// gets. iOS retires the handler process freely, so nothing here is relied on
/// — it only saves the load when the process happens to survive.
private actor SessionCache {
    static let shared = SessionCache()
    private var sessions: [String: TranslationSession] = [:]

    private static func key(_ source: Locale.Language, _ target: Locale.Language) -> String {
        "\(source.minimalIdentifier)->\(target.minimalIdentifier)"
    }

    func session(from source: Locale.Language, to target: Locale.Language) -> TranslationSession? {
        sessions[Self.key(source, target)]
    }

    func store(_ session: TranslationSession, from source: Locale.Language, to target: Locale.Language) {
        sessions[Self.key(source, target)] = session
    }

    func drop(from source: Locale.Language, to target: Locale.Language) {
        sessions[Self.key(source, target)] = nil
    }
}

/// Milliseconds since `start`, for the timing lines in the log. The numbers are
/// the only way to tell which step is slow on a device, so they stay in.
private func elapsed(since start: ContinuousClock.Instant) -> Int {
    Int((ContinuousClock.now - start) / .milliseconds(1))
}

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
        let started = ContinuousClock.now
        guard let source = detect(text) else {
            return .failure(.undetectable, "Could not identify the language of the selection")
        }
        log.info("detect \(elapsed(since: started), privacy: .public)ms")

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
            // Check each candidate in preference order. A cache miss says
            // nothing about installation, so resolve it before trying the next.
            if let session = await SessionCache.shared.session(from: source, to: candidate) {
                log.info("session reused \(elapsed(since: started), privacy: .public)ms")
                return await run(session, text: text, from: source, to: candidate,
                                 pinned: requestedTarget, started: started)
            }
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

        log.info("availability \(elapsed(since: started), privacy: .public)ms")

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

        let session: TranslationSession
        do {
            session = try TranslationSession(installedSource: source, target: target)
        } catch {
            return failure(error)
        }
        await SessionCache.shared.store(session, from: source, to: target)
        log.info("session created \(elapsed(since: started), privacy: .public)ms")
        return await run(session, text: text, from: source, to: target,
                         pinned: requestedTarget, started: started)
    }

    private static func run(
        _ session: TranslationSession, text: String,
        from source: Locale.Language, to target: Locale.Language,
        pinned: String?, started: ContinuousClock.Instant
    ) async -> Payload {
        do {
            let response = try await session.translate(text)
            log.info("translate \(elapsed(since: started), privacy: .public)ms")
            return .success(
                text: response.targetText,
                source: label(response.sourceLanguage),
                target: label(response.targetLanguage),
                pinned: pinned
            )
        } catch {
            // Whatever went wrong, a session that failed once is not worth a
            // second try — the next request builds a fresh one.
            await SessionCache.shared.drop(from: source, to: target)
            return failure(error)
        }
    }

    private static func failure(_ error: Error) -> Payload {
        if let error = error as? TranslationError {
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
        }
        log.error("translation failed: \(error.localizedDescription, privacy: .public)")
        return .failure(.unknown, error.localizedDescription)
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
        case "settings":
            Task {
                let payload = Payload.settings(
                    target: SharedSettings.target,
                    languages: await Translator.supportedTargets()
                )
                log.debug("result: \(payload.summary, privacy: .public)")
                Self.complete(context, with: payload)
            }

        case "target":
            // The background asks before every translation, so this answers
            // from the defaults alone — `settings` also enumerates languages.
            Self.complete(context, with: .settings(
                target: SharedSettings.target, languages: []
            ))

        case "setTarget":
            SharedSettings.target = body["target"] as? String
            log.debug("setTarget: \(SharedSettings.target ?? "auto", privacy: .public)")
            Self.complete(context, with: .settings(
                target: SharedSettings.target, languages: []
            ))

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
            // The extension may pin a target per request; otherwise the shared
            // setting decides, and only then does the preference list.
            let requestedTarget = (body["target"] as? String) ?? SharedSettings.target
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
