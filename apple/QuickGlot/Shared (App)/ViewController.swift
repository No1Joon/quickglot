//
//  ViewController.swift
//  Shared (App)
//
//  The container app exists for one job the extension cannot do: Apple's
//  language packs can only be downloaded from a real UI context, so onboarding
//  lives here. Once a pair is installed, the extension translates offline.
//

import SwiftUI
import Translation
import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
typealias PlatformHostingController = UIHostingController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
typealias PlatformHostingController = NSHostingController
#endif

let extensionBundleIdentifier = "com.quickglot.app.Extension"

class ViewController: PlatformViewController {

    /// Main.storyboard still wires this outlet, so the property has to exist for
    /// KVC even though the web view is replaced by SwiftUI at load time.
    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        webView?.removeFromSuperview()

        let host = PlatformHostingController(rootView: OnboardingView())
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)

        // The storyboard window draws its content full-size, under the title bar,
        // which is right for the web view this replaced but clips the heading of
        // a normal layout. The safe area is where the title bar ends.
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: safe.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
        ])
#if os(iOS)
        host.didMove(toParent: self)
#elseif os(macOS)
        // The template window is sized for a small web view; the onboarding
        // needs room for two pickers and the status row without scrolling.
        preferredContentSize = NSSize(width: 520, height: 560)
#endif
    }
}

// MARK: - Onboarding

/// The app's strings, localised in code.
///
/// A string catalogue would be idiomatic, but `scripts/regen-xcode.sh` rebuilds
/// the Xcode project from the converter and would drop a resource file it does
/// not know how to restore. Keeping the text here survives regeneration.
private enum L {
    private static let usesKorean = (Locale.preferredLanguages.first ?? "en").hasPrefix("ko")

    static func t(_ english: String, _ korean: String) -> String {
        usesKorean ? korean : english
    }
}

#if os(macOS)
private let didBecomeActive = NotificationCenter.default
    .publisher(for: NSApplication.didBecomeActiveNotification)
#else
private let didBecomeActive = NotificationCenter.default
    .publisher(for: UIApplication.didBecomeActiveNotification)
#endif

/// Reads the target language the extension is pinned to.
///
/// The extension writes it through `SharedSettings` in
/// `Shared (Extension)/SafariWebExtensionHandler.swift`. The two cannot share a
/// file: they are separate build targets, and `scripts/regen-xcode.sh` rebuilds
/// the project from scratch, so a file added to both would be dropped without a
/// word on the next regeneration. The group identifier and the key below must
/// therefore match that file by hand — `docs/INVARIANTS.md` records the pair.
private enum ExtensionSettings {
    private static let targetKey = "targetLanguage"

    static var target: String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "AppGroupIdentifier") as? String,
              !group.isEmpty,
              let defaults = UserDefaults(suiteName: group),
              let value = defaults.string(forKey: targetKey),
              !value.isEmpty
        else { return nil }
        return value
    }
}

private func code(_ language: Locale.Language) -> String {
    language.languageCode?.identifier ?? language.minimalIdentifier
}

private func name(_ language: Locale.Language) -> String {
    Locale.current.localizedString(forLanguageCode: code(language)) ?? code(language)
}

/// What the screen is doing about the currently selected pair.
///
/// The system download sheet cannot be used as the source of truth: it returns
/// as soon as the user dismisses it, it keeps downloading in the background
/// afterwards, it reports nothing when the user cancels, and it may not appear
/// at all on a retry while a download is already running. So progress is decided
/// here, by re-reading availability on a timer.
private enum Phase: Equatable {
    case checking
    case ready
    case needsDownload
    /// Seconds elapsed. Apple exposes no progress for language pack downloads —
    /// `LanguageAvailability` answers installed/supported/unsupported and nothing
    /// in between — so elapsed time is the only honest thing to show. Inventing a
    /// percentage would be worse than showing none.
    case downloading(elapsed: Int)
    case slow(elapsed: Int)
    /// The system is refusing download requests, so the sheet will not appear
    /// however many times the button is pressed.
    case blocked
    case unsupported
    case sameLanguage

    var isDownloading: Bool {
        switch self {
        case .downloading, .slow: return true
        default: return false
        }
    }
}

private func elapsedText(_ seconds: Int) -> String {
    seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
}

/// How long a download may run before the screen offers a way out. Polling
/// continues past this — packs really can take minutes on a slow connection.
private let slowAfter: Duration = .seconds(60)
/// The elapsed label ticks every second; availability is only re-read every
/// other tick, since that call is far heavier than redrawing a number.
private let tickInterval: Duration = .seconds(1)
private let checksPerTick = 2

struct OnboardingView: View {
    @State private var languages: [Locale.Language] = []
    @State private var source = Locale.Language(identifier: "en")
    @State private var target = Locale.Language(identifier: "ko")

    @State private var phase: Phase = .checking
    @State private var sourceInstalled: Bool?
    @State private var targetInstalled: Bool?

    /// The extension's pinned target, read from the shared app group. Showing it
    /// here is the point of sharing: the app can now say which pack the
    /// extension will actually need instead of guessing.
    @State private var extensionTarget: String?
    @State private var configuration: TranslationSession.Configuration?
    @State private var poll: Task<Void, Never>?
    @State private var prepareError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                enableSection
                packSection
            }
            .padding(24)
            .frame(maxWidth: 520, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await loadLanguages() }
        .translationTask(configuration) { session in
            // Surfaces the system sheet. A normal return says only that the sheet
            // is gone — the poll started alongside it decides what happened. A
            // thrown error, though, is real information and must not be swallowed.
            do {
                prepareError = nil
                try await session.prepareTranslation()
            } catch {
                prepareError = error.localizedDescription
            }
        }
        .onReceive(didBecomeActive) { _ in
            extensionTarget = ExtensionSettings.target
            Task { await refreshStatus() }
        }
        .onDisappear { poll?.cancel() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("QuickGlot").font(.largeTitle.bold())
            Text(L.t("Select text in Safari and it is translated on device.", "Safari 에서 텍스트를 선택하면 기기 안에서 번역합니다."))
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var enableSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L.t("1. Turn on the extension", "1. 확장 프로그램 켜기")).font(.headline)
#if os(macOS)
            Button(L.t("Open Safari Extension Settings", "Safari 확장 프로그램 설정 열기")) {
                SFSafariApplication.showPreferencesForExtension(
                    withIdentifier: extensionBundleIdentifier
                ) { _ in }
            }
#else
            Text(L.t("Settings › Apps › Safari › Extensions › QuickGlot, then allow it on the sites you want.", "설정 › 앱 › Safari › 확장 프로그램 › QuickGlot 을 켠 뒤, 사용할 사이트에 권한을 허용하세요."))
                .foregroundStyle(.secondary)
#endif
            if let extensionTarget, let language = languages.first(where: { code($0) == extensionTarget }) {
                Label(
                    L.t("The extension translates into \(name(language))", "확장은 \(name(language)) 로 번역합니다"),
                    systemImage: "checkmark.circle"
                )
                .font(.callout)
                .foregroundStyle(.secondary)
            } else {
                Text(L.t("The extension picks a language automatically. Choose a fixed one from its toolbar button if you prefer.", "확장은 번역할 언어를 자동으로 고릅니다. 고정하려면 툴바 버튼에서 선택하세요."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var packSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L.t("2. Download the languages you need", "2. 필요한 언어 받기")).font(.headline)
            Text(L.t("Downloaded once, then translation works offline.", "한 번 받아두면 이후에는 오프라인에서 번역됩니다."))
                .font(.callout)
                .foregroundStyle(.secondary)

            if languages.isEmpty {
                ProgressView().padding(.vertical, 8)
            } else {
                languageRow("From", selection: $source, installed: sourceInstalled)
                languageRow("To", selection: $target, installed: targetInstalled)
                Divider()
                statusRow
            }
        }
        .onChange(of: source) { pairChanged() }
        .onChange(of: target) { pairChanged() }
    }

    /// Each language carries its own state, because a pair is often half ready
    /// and L.t("Download", "받기") on the pair says nothing about which half is missing.
    @ViewBuilder
    private func languageRow(
        _ label: String,
        selection: Binding<Locale.Language>,
        installed: Bool?
    ) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .frame(width: 44, alignment: .leading)
                .foregroundStyle(.secondary)
            Picker("", selection: selection) {
                ForEach(languages, id: \.self) { Text(name($0)).tag($0) }
            }
            .labelsHidden()
            Spacer(minLength: 8)
            switch installed {
            case .some(true):
                Label(L.t("On device", "기기에 있음"), systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
            case .some(false):
                Label(L.t("Not downloaded", "받지 않음"), systemImage: "arrow.down.circle")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            case nil:
                ProgressView().controlSize(.small)
            }
        }
    }

    @ViewBuilder
    private var statusRow: some View {
        switch phase {
        case .checking:
            HStack { ProgressView().controlSize(.small); Text(L.t("Checking…", "확인 중…")).foregroundStyle(.secondary) }

        case .ready:
            Label(L.t("Ready — this pair translates offline", "준비됨 — 이 언어쌍은 오프라인에서 번역됩니다"), systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)

        case .needsDownload:
            HStack {
                Button(L.t("Download", "받기")) { startDownload() }
                Spacer()
                Button(L.t("Recheck", "다시 확인")) { Task { await refreshStatus() } }
                    .buttonStyle(.borderless)
            }

        case let .downloading(elapsed):
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L.t("Downloading… ", "다운로드 중… ") + elapsedText(elapsed)).monospacedDigit()
                }
                Text(L.t("You can close the system dialog. The download continues, and this screen updates when it finishes.", "시스템 대화상자는 닫으셔도 됩니다. 다운로드는 계속되고, 끝나면 이 화면이 바뀝니다."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

        case let .slow(elapsed):
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L.t("Still downloading… ", "계속 다운로드 중… ") + elapsedText(elapsed)).monospacedDigit()
                }
                Text(L.t("This is taking a while. Large packs can take several minutes. If you cancelled the download, or the connection dropped, start it again.", "오래 걸리고 있습니다. 큰 언어팩은 몇 분이 걸리기도 합니다. 다운로드를 취소했거나 연결이 끊겼다면 다시 시작하세요."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let prepareError {
                    Text(prepareError).font(.caption).foregroundStyle(.secondary)
                }
                HStack {
                    Button(L.t("Try again", "다시 시도")) { startDownload() }
                    systemSettingsButton
                    Button(L.t("Recheck", "다시 확인")) { Task { await refreshStatus() } }
                        .buttonStyle(.borderless)
                }
            }

        case .blocked:
            VStack(alignment: .leading, spacing: 8) {
                Label(L.t("The system is not accepting download requests right now", "시스템이 지금 다운로드 요청을 받지 않습니다"),
                      systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                Text(L.t("This usually means a download was already started or cancelled recently. Pressing Download again will not bring the dialog back — manage the languages directly instead.", "이미 시작했거나 최근에 취소한 다운로드가 있으면 이렇게 됩니다. 받기를 다시 눌러도 대화상자는 돌아오지 않으니 언어를 직접 관리하세요."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let prepareError {
                    Text(prepareError).font(.caption).foregroundStyle(.secondary)
                }
                HStack {
                    systemSettingsButton
                    Button(L.t("Recheck", "다시 확인")) { Task { await refreshStatus() } }
                        .buttonStyle(.borderless)
                }
            }

        case .unsupported:
            Label(L.t("Apple's on-device models don't cover this pair", "Apple 의 온디바이스 모델이 이 언어쌍을 지원하지 않습니다"), systemImage: "exclamationmark.triangle")
                .foregroundStyle(.secondary)

        case .sameLanguage:
            Text(L.t("Pick two different languages.", "서로 다른 두 언어를 고르세요.")).foregroundStyle(.secondary)
        }
    }

    /// Language packs are also manageable outside the app, which is the only way
    /// out when the system will not show its own download sheet.
    @ViewBuilder
    private var systemSettingsButton: some View {
#if os(macOS)
        Button(L.t("Open Language Settings", "언어 설정 열기")) {
            if let url = URL(string: "x-apple.systempreferences:com.apple.Localization-Settings.extension") {
                NSWorkspace.shared.open(url)
            }
        }
#else
        Text(L.t("Manage in Settings › General › Language & Region.", "설정 › 일반 › 언어 및 지역 에서 관리하세요."))
            .font(.caption)
            .foregroundStyle(.secondary)
#endif
    }

    // MARK: - Actions

    private func pairChanged() {
        poll?.cancel()
        poll = nil
        Task { await refreshStatus() }
    }

    private func startDownload() {
        phase = .downloading(elapsed: 0)

        // translationTask only re-fires when the configuration compares unequal,
        // so a retry of the same pair has to invalidate() rather than reassign.
        if configuration?.source == source, configuration?.target == target {
            configuration?.invalidate()
        } else {
            configuration = TranslationSession.Configuration(source: source, target: target)
        }

        poll?.cancel()
        poll = Task {
            var seconds = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: tickInterval)
                if Task.isCancelled { return }
                seconds += 1

                if seconds % checksPerTick == 0 {
                    await refreshInstalled()
                    if await pairStatus() == .installed {
                        phase = .ready
                        return
                    }
                }

                if seconds >= Int(slowAfter.components.seconds) {
                    // Nothing has arrived and the system will not be asked again;
                    // keeping a spinner up would misrepresent a dead end.
                    phase = canRequestDownloads() ? .slow(elapsed: seconds) : .blocked
                } else {
                    phase = .downloading(elapsed: seconds)
                }
            }
        }
    }

    // MARK: - Status

    private func pairStatus() async -> LanguageAvailability.Status {
        await LanguageAvailability().status(from: source, to: target)
    }

    /// Whether asking for a download would actually surface the system sheet.
    /// When this is false the button is a dead end, so the screen must say so
    /// rather than letting the user press it repeatedly.
    private func canRequestDownloads() -> Bool {
        TranslationSession(installedSource: source, target: target).canRequestDownloads
    }

    /// Per-language readiness. `status(from:to:)` with a nil target answers for
    /// the source language alone, which is what the two rows need.
    private func refreshInstalled() async {
        let availability = LanguageAvailability()
        async let s = availability.status(from: source, to: nil)
        async let t = availability.status(from: target, to: nil)
        let (sourceStatus, targetStatus) = await (s, t)
        sourceInstalled = sourceStatus == .installed
        targetInstalled = targetStatus == .installed
    }

    private func refreshStatus() async {
        guard code(source) != code(target) else {
            poll?.cancel()
            phase = .sameLanguage
            sourceInstalled = nil
            targetInstalled = nil
            return
        }

        await refreshInstalled()

        switch await pairStatus() {
        case .installed:
            poll?.cancel()
            phase = .ready
        case .unsupported:
            poll?.cancel()
            phase = .unsupported
        case .supported:
            // A poll already running owns the phase; do not knock it back to
            // needsDownload while a download is still in flight.
            if poll == nil || poll?.isCancelled == true || !phase.isDownloading {
                phase = canRequestDownloads() ? .needsDownload : .blocked
            }
        @unknown default:
            phase = .needsDownload
        }
    }

    private func loadLanguages() async {
        var seen = Set<String>()
        var found: [Locale.Language] = []
        for language in await LanguageAvailability().supportedLanguages {
            guard seen.insert(code(language)).inserted else { continue }
            found.append(Locale.Language(identifier: code(language)))
        }
        languages = found.sorted { name($0) < name($1) }

        if let english = languages.first(where: { code($0) == "en" }) { source = english }

        extensionTarget = ExtensionSettings.target
        if let pinned = extensionTarget,
           let match = languages.first(where: { code($0) == pinned }) {
            target = match
        } else {
            let preferred = Locale.preferredLanguages.map(Locale.Language.init(identifier:))
            if let first = preferred.first(where: { code($0) != code(source) }),
               let match = languages.first(where: { code($0) == code(first) }) {
                target = match
            }
        }
        await refreshStatus()
    }
}
